import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { getStoreAccess } from "./tokens.js";
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
  actor: { id: string; email: string };
  ip?: string | null;
}

export interface ShipOrderResult {
  orderSn: string;
  shopeeStatus: string;
  packageNumber: string | null;
  /** True when Shopee already had it shipped, so nothing was called. */
  alreadyShipped: boolean;
}

export async function markShipped(deps: ServiceDeps, input: ShipOrderInput): Promise<ShipOrderResult> {
  const [row] = await deps.db
    .select({ order: schema.orders, store: schema.shopeeStores })
    .from(schema.orders)
    .innerJoin(schema.shopeeStores, eq(schema.shopeeStores.id, schema.orders.storeId))
    .where(eq(schema.orders.id, input.orderId))
    .limit(1);

  if (!row) throw AppError.notFound("Pesanan");
  const { order, store } = row;

  const currentStatus = (order.shopeeStatus ?? "").toUpperCase();
  if (ALREADY_SHIPPED.includes(currentStatus)) {
    return { orderSn: order.orderSn, shopeeStatus: order.shopeeStatus ?? currentStatus, packageNumber: null, alreadyShipped: true };
  }

  if (!["FULFILLED", "CLAIMED", "COMPLETED"].includes(order.state)) {
    throw new AppError(
      "ORDER_NOT_READY",
      "Pesanan ini belum siap dikirim. Tandai dikirim hanya untuk pesanan yang produknya sudah diserahkan ke pembeli.",
      409,
    );
  }

  if (!deps.gateway.shipOrder) {
    throw new AppError("SHIP_NOT_SUPPORTED", "Gateway Shopee yang aktif tidak mendukung pengaturan pengiriman.", 501);
  }

  const { access } = await getStoreAccess(deps, store.id);

  let result: { shipped: boolean; packageNumber?: string | null };
  try {
    result = await deps.gateway.shipOrder({ shopId: access.shopId, accessToken: access.accessToken }, order.orderSn);
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
    throw new AppError("SHIP_FAILED", "Shopee tidak mengonfirmasi pengiriman untuk pesanan ini.", 502);
  }

  const now = nowOf(deps);
  await deps.db.transaction(async (tx) => {
    await tx.update(schema.orders).set({ shopeeStatus: "SHIPPED", updatedAt: now }).where(eq(schema.orders.id, order.id));
    await tx.insert(schema.orderEvents).values({
      orderId: order.id,
      type: "SHIP_CONFIRMED",
      payload: { actor: input.actor.email, packageNumber: result.packageNumber ?? null },
    });
  });

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: "order.ship",
    targetType: "order",
    targetId: order.id,
    metadata: { orderSn: order.orderSn, packageNumber: result.packageNumber ?? null, mode: deps.config.gatewayMode },
    ip: input.ip ?? null,
  });

  return {
    orderSn: order.orderSn,
    shopeeStatus: "SHIPPED",
    packageNumber: result.packageNumber ?? null,
    alreadyShipped: false,
  };
}
