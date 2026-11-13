import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { getStoreAccess } from "./tokens.js";
import { enqueue } from "./queue.js";
import { loadSettings } from "./settings.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Arrange shipment for an order that the buyer has already collected.
 *
 * Nothing in this platform ships on its own: Shopee cancels an unshipped order and
 * refunds it, which for a digital product means the buyer keeps what was delivered.
 * This is the one deliberate write back to Shopee, and it is an operator action,
 * never a side effect of claiming.
 */

/** Shopee statuses that mean the shipment is already arranged. */
const ALREADY_SHIPPED = ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"];

export interface ShipOrderInput {
  orderId: string;
  /** The resi the seller would type in the seller centre; required by a non-integrated channel. */
  trackingNumber?: string | null;
  actor: { id: string; email: string; system?: boolean };
  ip?: string | null;
}

export interface ShipOrderResult {
  orderSn: string;
  shopeeStatus: string;
  packageNumber: string | null;
  trackingNumber: string | null;
  /** True when Shopee already had it shipped, so nothing was called. */
  alreadyShipped: boolean;
}

export async function markShipped(
  deps: ServiceDeps,
  input: ShipOrderInput,
): Promise<ShipOrderResult> {
  const [row] = await deps.db
    .select({ order: schema.orders, store: schema.shopeeStores })
    .from(schema.orders)
    .innerJoin(
      schema.shopeeStores,
      eq(schema.shopeeStores.id, schema.orders.storeId),
    )
    .where(eq(schema.orders.id, input.orderId))
    .limit(1);

  if (!row) throw AppError.notFound("Pesanan");
  const { order, store } = row;

  const currentStatus = (order.shopeeStatus ?? "").toUpperCase();
  if (ALREADY_SHIPPED.includes(currentStatus)) {
    return {
      orderSn: order.orderSn,
      shopeeStatus: order.shopeeStatus ?? currentStatus,
      packageNumber: null,
      trackingNumber: input.trackingNumber?.trim() ?? null,
      alreadyShipped: true,
    };
  }

  if (!["FULFILLED", "CLAIMED", "COMPLETED"].includes(order.state)) {
    throw new AppError(
      "ORDER_NOT_READY",
      "Pesanan ini belum siap dikirim. Tandai dikirim hanya untuk pesanan yang produknya sudah diserahkan ke pembeli.",
      409,
    );
  }

  if (!deps.gateway.shipOrder) {
    throw new AppError(
      "SHIP_NOT_SUPPORTED",
      "Gateway Shopee yang aktif tidak mendukung pengaturan pengiriman.",
      501,
    );
  }

  const { access } = await getStoreAccess(deps, store.id);
  const storeAccess = {
    shopId: access.shopId,
    accessToken: access.accessToken,
  };

  // Ask the channel what it needs before calling ship_order: a shop that ships
  // with its own courier (jasa kirim toko, a non-integrated channel) must be given
  // the resi, and saying that plainly beats forwarding Shopee's parameter error.
  const trackingNumber = input.trackingNumber?.trim() ?? "";
  if (!trackingNumber && deps.gateway.getShippingOptions) {
    const options = await deps.gateway
      .getShippingOptions(storeAccess, order.orderSn)
      .catch((error: unknown) => {
        const code = (error as { code?: string }).code ?? "SHIP_FAILED";
        throw new AppError(
          "SHIP_FAILED",
          `Tidak bisa membaca metode pengiriman pesanan ini: ${code}`,
          502,
          { shopeeCode: code },
        );
      });
    if (options.nonIntegrated?.needsTrackingNumber) {
      throw new AppError(
        "TRACKING_NUMBER_REQUIRED",
        "Pesanan ini memakai jasa kirim toko, jadi nomor resi wajib diisi. Isi nomor resi yang sama dengan yang Anda masukkan di Seller Centre.",
        422,
      );
    }
  }

  let result: { shipped: boolean; packageNumber?: string | null };
  try {
    result = await deps.gateway.shipOrder(storeAccess, order.orderSn, {
      trackingNumber: trackingNumber || null,
    });
  } catch (error) {
    const code = (error as { code?: string }).code ?? "SHIP_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      "SHIP_FAILED",
      // The channel matters: an integrated channel cannot be arranged from here,
      // and telling the operator that is more useful than a generic failure.
      code === "error_logistics_not_supported"
        ? "Kanal pengiriman pesanan ini tidak bisa diatur lewat API. Tandai dikirim manual di Seller Centre Shopee."
        : `Shopee menolak pengaturan pengiriman: ${message}`,
      502,
      { shopeeCode: code },
    );
  }

  if (!result.shipped) {
    throw new AppError(
      "SHIP_FAILED",
      "Shopee tidak mengonfirmasi pengiriman untuk pesanan ini.",
      502,
    );
  }

  const now = nowOf(deps);
  await deps.db.transaction(async (tx) => {
    await tx
      .update(schema.orders)
      .set({ shopeeStatus: "SHIPPED", updatedAt: now })
      .where(eq(schema.orders.id, order.id));
    await tx.insert(schema.orderEvents).values({
      orderId: order.id,
      type: "SHIP_CONFIRMED",
      payload: {
        actor: input.actor.email,
        packageNumber: result.packageNumber ?? null,
        trackingNumber: trackingNumber || null,
      },
    });
  });

  await recordAudit(deps, {
    actorType: input.actor.system ? "SYSTEM" : "ADMIN",
    actorId: input.actor.system ? null : input.actor.id,
    actorLabel: input.actor.email,
    action: "order.ship",
    targetType: "order",
    targetId: order.id,
    metadata: {
      orderSn: order.orderSn,
      packageNumber: result.packageNumber ?? null,
      trackingNumber: trackingNumber || null,
      mode: deps.config.gatewayMode,
    },
    ip: input.ip ?? null,
  });

  return {
    orderSn: order.orderSn,
    shopeeStatus: "SHIPPED",
    packageNumber: result.packageNumber ?? null,
    trackingNumber: trackingNumber || null,
    alreadyShipped: false,
  };
}

/** Shopee statuses where a shipment is still the seller's to arrange. */
const AWAITING_SHIPMENT_STATUSES = ["READY_TO_SHIP", "PROCESSED"];

/**
 * Order states where a shipment is legitimate. VALIDATED is excluded on purpose: it
 * means paid but nothing mapped yet, so the buyer cannot collect anything and
 * shipping would only start Shopee's delivery clock on an undeliverable order. The
 * reconcile after mapping picks it up.
 */
const SHIPPABLE_ORDER_STATES = ["FULFILLED", "CLAIMED", "COMPLETED"];

/**
 * Queue the shipment for an order, at the point the shop chose: the moment it is
 * paid, or the moment the buyer takes the product.
 *
 * The queue is deliberate: a Shopee hiccup must never fail a claim the buyer has
 * already completed, and a retry is the right answer to a timeout. The job is
 * deduped per order, so revealing several items of one order ships it once.
 */
export async function queueAutoShip(
  deps: ServiceDeps,
  order: {
    id: string;
    orderSn: string;
    shopeeStatus: string | null;
    state: string;
  },
  store: { id: string },
  trigger: "ON_PAYMENT" | "ON_CLAIM" = "ON_CLAIM",
): Promise<string | null> {
  const settings = await loadSettings(deps);
  if (!settings.claim.autoShipOnClaim) return null;
  // One point in the flow owns the decision; the other must stay silent.
  if (settings.claim.autoShipTrigger !== trigger) return null;
  if (!SHIPPABLE_ORDER_STATES.includes(order.state)) return null;

  const status = (order.shopeeStatus ?? "").toUpperCase();
  if (!AWAITING_SHIPMENT_STATUSES.includes(status)) return null;

  return enqueue(deps, {
    type: "SHIP_ORDER",
    payload: {
      orderId: order.id,
      orderSn: order.orderSn,
      storeId: store.id,
      trackingNumber: `${settings.claim.autoShipPrefix}${order.orderSn}`,
      reason: trigger === "ON_PAYMENT" ? "payment" : "claim",
    },
    dedupeKey: `ship:${order.id}`,
  });
}
