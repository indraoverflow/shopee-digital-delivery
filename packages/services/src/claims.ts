import {
  AppError,
  FAILURE_MESSAGES,
  decryptSecret,
  evaluateEligibility,
  isClaimableState,
  randomToken,
  sha256Hex,
  signPayload,
  verifyBuyer,
  verifyPayload,
  type OrderState,
  type VerificationFailure,
} from "@qansa/core";
import { schema } from "@qansa/db";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { findApprovedWindow } from "./claim-requests.js";
import { notify } from "./notify.js";
import { queueAutoShip } from "./shipping.js";
import { loadSettings } from "./settings.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * The buyer side of the system: verify, issue a session, deliver, and keep a
 * record of every step. The order number alone is never enough, the session is
 * scoped to one order, and every reveal is written to delivery_logs.
 */

const CLAIMABLE_FULFILLMENT_STATES = ["CLAIMABLE", "CLAIMED"] as const;

export interface VerifyClaimInput {
  orderSn: string;
  buyerUsername?: string | undefined;
  phoneSuffix?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface VerifiedClaim {
  token: string;
  sessionId: string;
  expiresAt: Date;
  orderSn: string;
}

const normaliseOrderSn = (value: string): string => value.trim().toUpperCase();

async function recordAttempt(
  deps: ServiceDeps,
  input: {
    orderSn: string;
    method: "USERNAME" | "USERNAME_PHONE" | "MANUAL";
    success: boolean;
    reason?: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<void> {
  await deps.db.insert(schema.claimAttempts).values({
    orderSn: input.orderSn.slice(0, 64),
    method: input.method,
    success: input.success,
    reason: input.reason ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
  });
}

function failure(code: VerificationFailure, status = 400): AppError {
  return new AppError(code, FAILURE_MESSAGES[code], status);
}

/**
 * Step 2 of the buyer journey: prove the person holding the order number is the
 * buyer. Failures are counted per IP and per order before the check runs, so a
 * script cannot iterate order numbers at speed.
 */
export async function verifyClaim(
  deps: ServiceDeps,
  input: VerifyClaimInput,
): Promise<VerifiedClaim> {
  const orderSn = normaliseOrderSn(input.orderSn ?? "");
  if (orderSn.length < 6) throw failure("ORDER_NOT_FOUND");

  const settings = await loadSettings(deps);
  const now = nowOf(deps);
  const since = new Date(now.getTime() - 3600_000);

  if (input.ip) {
    const [ipRow] = await deps.db
      .select({ value: count() })
      .from(schema.claimAttempts)
      .where(
        and(
          eq(schema.claimAttempts.ip, input.ip),
          eq(schema.claimAttempts.success, false),
          gte(schema.claimAttempts.createdAt, since),
        ),
      );
    if (Number(ipRow?.value ?? 0) >= settings.claim.maxAttemptsPerHour) {
      throw failure("TOO_MANY_ATTEMPTS", 429);
    }
  }

  const [orderRow] = await deps.db
    .select({ value: count() })
    .from(schema.claimAttempts)
    .where(
      and(
        eq(schema.claimAttempts.orderSn, orderSn),
        eq(schema.claimAttempts.success, false),
        gte(schema.claimAttempts.createdAt, since),
      ),
    );
  if (Number(orderRow?.value ?? 0) >= settings.claim.maxAttemptsPerOrder) {
    throw failure("TOO_MANY_ATTEMPTS", 429);
  }

  const [row] = await deps.db
    .select({ order: schema.orders, store: schema.shopeeStores })
    .from(schema.orders)
    .innerJoin(
      schema.shopeeStores,
      eq(schema.shopeeStores.id, schema.orders.storeId),
    )
    .where(eq(schema.orders.orderSn, orderSn))
    .limit(1);

  if (!row) {
    await recordAttempt(deps, {
      orderSn,
      method: "USERNAME",
      success: false,
      reason: "ORDER_NOT_FOUND",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw failure("ORDER_NOT_FOUND", 404);
  }

  const { order, store } = row;
  const policy = store.verificationPolicy;

  let verification = verifyBuyer(
    policy,
    {
      buyerUsername: order.buyerUsername,
      buyerPhoneMasked: order.buyerPhoneMasked,
    },
    { buyerUsername: input.buyerUsername, phoneSuffix: input.phoneSuffix },
  );

  /**
   * A manual approval stands in for the factors Shopee cannot supply: when an
   * operator has verified this order out of band, a phone-only failure (or a
   * MANUAL policy) is accepted for the approved window. Username mismatches and
   * payment problems are never overridable.
   */
  if (!verification.ok) {
    const overridable =
      policy === "MANUAL" ||
      [
        "PHONE_UNAVAILABLE",
        "PHONE_SUFFIX_MISMATCH",
        "PHONE_SUFFIX_INVALID",
      ].includes(verification.reason);
    if (overridable) {
      const approved = await findApprovedWindow(deps, order.id);
      if (approved) verification = { ok: true, method: "MANUAL" };
    }
  }

  if (!verification.ok) {
    await recordAttempt(deps, {
      orderSn,
      method: policy,
      success: false,
      reason: verification.reason,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw failure(verification.reason);
  }

  // Verification passed; the order still has to be deliverable. CANCELLED is
  // checked here as well because a revocation may have landed after delivery.
  const eligibility = evaluateEligibility({
    shopeeStatus: order.shopeeStatus,
    eligibleStatuses: store.eligibleStatuses,
  });
  if (!isClaimableState(order.state as OrderState) || !eligibility.eligible) {
    await recordAttempt(deps, {
      orderSn,
      method: verification.method,
      success: false,
      reason: eligibility.eligible
        ? "ORDER_NOT_CLAIMABLE"
        : "ORDER_NOT_ELIGIBLE",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw failure(
      eligibility.eligible ? "ORDER_NOT_CLAIMABLE" : "ORDER_NOT_ELIGIBLE",
      409,
    );
  }

  const statuses = await deps.db
    .select({ status: schema.fulfillments.status, value: count() })
    .from(schema.fulfillments)
    .where(eq(schema.fulfillments.orderId, order.id))
    .groupBy(schema.fulfillments.status);

  const available = statuses
    .filter((row) =>
      (CLAIMABLE_FULFILLMENT_STATES as readonly string[]).includes(row.status),
    )
    .reduce((total, row) => total + Number(row.value), 0);
  const revoked = statuses
    .filter((row) => row.status === "REVOKED" || row.status === "EXPIRED")
    .reduce((total, row) => total + Number(row.value), 0);

  if (available === 0) {
    // Distinguish "nothing mapped yet" from "access was taken away": the buyer
    // deserves a different message, and support needs a different answer.
    const reason = revoked > 0 ? "ORDER_NOT_ELIGIBLE" : "ORDER_NOT_CLAIMABLE";
    await recordAttempt(deps, {
      orderSn,
      method: verification.method,
      success: false,
      reason,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw failure(reason, 409);
  }

  const token = randomToken(32);
  const expiresAt = new Date(
    now.getTime() + settings.claim.sessionMinutes * 60_000,
  );

  const [session] = await deps.db
    .insert(schema.claimSessions)
    .values({
      orderId: order.id,
      tokenHash: sha256Hex(token),
      method: verification.method,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    })
    .returning({ id: schema.claimSessions.id });

  await recordAttempt(deps, {
    orderSn,
    method: verification.method,
    success: true,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await deps.db.insert(schema.orderEvents).values({
    orderId: order.id,
    type: "CLAIM_VERIFIED",
    payload: { method: verification.method, ip: input.ip ?? null },
  });

  return { token, sessionId: session!.id, expiresAt, orderSn: order.orderSn };
}

export interface ClaimSessionContext {
  session: typeof schema.claimSessions.$inferSelect;
  order: typeof schema.orders.$inferSelect;
  store: typeof schema.shopeeStores.$inferSelect;
}

export async function loadClaimSession(
  deps: ServiceDeps,
  token: string,
): Promise<ClaimSessionContext | null> {
  if (!token) return null;
  const [row] = await deps.db
    .select({
      session: schema.claimSessions,
      order: schema.orders,
      store: schema.shopeeStores,
    })
    .from(schema.claimSessions)
    .innerJoin(
      schema.orders,
      eq(schema.orders.id, schema.claimSessions.orderId),
    )
    .innerJoin(
      schema.shopeeStores,
      eq(schema.shopeeStores.id, schema.orders.storeId),
    )
    .where(eq(schema.claimSessions.tokenHash, sha256Hex(token)))
    .limit(1);

  if (!row) return null;
  if (row.session.expiresAt.getTime() <= nowOf(deps).getTime()) return null;
  return row;
}

export interface ClaimSessionView {
  orderSn: string;
  buyerUsernameMasked: string | null;
  orderState: OrderState;
  storeLabel: string;
  storeBrandName: string | null;
  expiresAt: string;
  items: Array<{
    fulfillmentId: string;
    productName: string;
    productDescription: string | null;
    instructions: string | null;
    deliveryKind: "FILE" | "LINK" | "CODE" | "CREDENTIALS" | "INSTRUCTIONS";
    quantity: number;
    status: string;
    claimDeadline: string | null;
    claimedAt: string | null;
    deliveriesUsed: number;
    deliveriesLeft: number;
    previewImageUrl: string | null;
  }>;
}

const maskUsername = (value: string | null): string | null => {
  if (!value) return null;
  if (value.length <= 3) return `${value[0] ?? ""}**`;
  return `${value.slice(0, 3)}${"*".repeat(Math.min(6, value.length - 3))}`;
};

/** Step 4: what the buyer sees after verifying. No secrets are included here. */
export async function getClaimSessionView(
  deps: ServiceDeps,
  token: string,
): Promise<ClaimSessionView | null> {
  const context = await loadClaimSession(deps, token);
  if (!context) return null;

  const rows = await deps.db
    .select({
      fulfillment: schema.fulfillments,
      product: schema.digitalProducts,
    })
    .from(schema.fulfillments)
    .innerJoin(
      schema.digitalProducts,
      eq(schema.digitalProducts.id, schema.fulfillments.digitalProductId),
    )
    .where(eq(schema.fulfillments.orderId, context.order.id))
    .orderBy(schema.fulfillments.createdAt);

  const claims = await deps.db
    .select({ claim: schema.claims })
    .from(schema.claims)
    .where(eq(schema.claims.claimSessionId, context.session.id));
  const claimByFulfillment = new Map(
    claims.map((row) => [row.claim.fulfillmentId, row.claim]),
  );

  return {
    orderSn: context.order.orderSn,
    buyerUsernameMasked: maskUsername(context.order.buyerUsername),
    orderState: context.order.state as OrderState,
    storeLabel: context.store.label,
    storeBrandName: context.store.brandName,
    expiresAt: context.session.expiresAt.toISOString(),
    items: rows.map(({ fulfillment, product }) => {
      const claim = claimByFulfillment.get(fulfillment.id);
      const used = claim?.deliveriesUsed ?? 0;
      return {
        fulfillmentId: fulfillment.id,
        productName: product.name,
        productDescription: product.description,
        instructions: product.instructions,
        deliveryKind: product.deliveryKind,
        quantity: fulfillment.quantity,
        status: fulfillment.status,
        claimDeadline: fulfillment.claimDeadline?.toISOString() ?? null,
        claimedAt: fulfillment.claimedAt?.toISOString() ?? null,
        deliveriesUsed: used,
        deliveriesLeft: Math.max(0, product.maxDeliveries - used),
        previewImageUrl:
          product.deliveryKind === "LINK" ? product.externalUrl : null,
      };
    }),
  };
}

export type DeliveryPayload =
  | {
      kind: "FILE";
      fileName: string;
      sizeBytes: number;
      url: string;
      expiresAt: string;
      instructions: string | null;
    }
  | { kind: "LINK"; url: string; instructions: string | null }
  | { kind: "CODE"; code: string; instructions: string | null }
  | {
      kind: "CREDENTIALS";
      username: string;
      password: string;
      instructions: string | null;
    }
  | { kind: "INSTRUCTIONS"; instructions: string | null };

export interface AccessInput {
  token: string;
  fulfillmentId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Step 5: reveal one item. Runs in a single transaction so two concurrent
 * reveals cannot take the same activation code, and so the delivery limit is
 * enforced against the row that was actually incremented.
 */
export async function accessDelivery(
  deps: ServiceDeps,
  input: AccessInput,
): Promise<DeliveryPayload> {
  const context = await loadClaimSession(deps, input.token);
  if (!context)
    throw AppError.unauthorized(
      "Sesi klaim sudah berakhir. Verifikasi ulang pesanan Anda.",
    );
  const settings = await loadSettings(deps);
  const now = nowOf(deps);

  const [row] = await deps.db
    .select({
      fulfillment: schema.fulfillments,
      product: schema.digitalProducts,
    })
    .from(schema.fulfillments)
    .innerJoin(
      schema.digitalProducts,
      eq(schema.digitalProducts.id, schema.fulfillments.digitalProductId),
    )
    .where(eq(schema.fulfillments.id, input.fulfillmentId))
    .limit(1);

  if (!row || row.fulfillment.orderId !== context.order.id) {
    throw AppError.notFound("Produk pada pesanan ini");
  }

  const { fulfillment, product } = row;

  if (fulfillment.status === "REVOKED")
    throw new AppError(
      "ACCESS_REVOKED",
      "Akses produk ini sudah dicabut. Hubungi dukungan.",
      403,
    );
  if (fulfillment.status === "EXPIRED")
    throw new AppError(
      "CLAIM_EXPIRED",
      "Masa klaim produk ini sudah berakhir.",
      410,
    );
  if (fulfillment.status === "PENDING") {
    throw new AppError(
      "PRODUCT_NOT_READY",
      "Produk belum siap diklaim. Coba lagi beberapa saat lagi.",
      409,
    );
  }
  if (
    fulfillment.claimDeadline &&
    fulfillment.claimDeadline.getTime() < now.getTime()
  ) {
    await deps.db
      .update(schema.fulfillments)
      .set({ status: "EXPIRED", updatedAt: now })
      .where(eq(schema.fulfillments.id, fulfillment.id));
    throw new AppError(
      "CLAIM_EXPIRED",
      "Masa klaim produk ini sudah berakhir.",
      410,
    );
  }
  if (product.status !== "ACTIVE") {
    throw new AppError(
      "PRODUCT_UNAVAILABLE",
      "Produk ini sedang tidak tersedia. Hubungi dukungan.",
      409,
    );
  }

  const asset =
    product.deliveryKind === "FILE"
      ? (
          await deps.db
            .select()
            .from(schema.digitalProductAssets)
            .where(eq(schema.digitalProductAssets.digitalProductId, product.id))
            .limit(1)
        )[0]
      : undefined;

  if (product.deliveryKind === "FILE" && !asset) {
    throw new AppError(
      "PRODUCT_UNAVAILABLE",
      "File produk belum diunggah. Hubungi dukungan.",
      409,
    );
  }
  if (product.deliveryKind === "LINK" && !product.externalUrl) {
    throw new AppError(
      "PRODUCT_UNAVAILABLE",
      "Tautan produk belum diatur. Hubungi dukungan.",
      409,
    );
  }

  // Notifications are sent after the transaction commits, never inside it: an
  // external HTTP call must not be able to roll back a delivery.
  const completed: {
    value: { claimId: string; productName: string; orderSn: string } | null;
  } = { value: null };

  try {
    const delivery = await deps.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.claims)
        .where(
          and(
            eq(schema.claims.fulfillmentId, fulfillment.id),
            eq(schema.claims.claimSessionId, context.session.id),
            inArray(schema.claims.status, ["ISSUED", "COMPLETED"]),
          ),
        )
        .limit(1);

      let claim = existing;
      if (!claim) {
        const [created] = await tx
          .insert(schema.claims)
          .values({
            fulfillmentId: fulfillment.id,
            orderId: context.order.id,
            digitalProductId: product.id,
            claimSessionId: context.session.id,
            status: "COMPLETED",
            verificationMethod: context.session.method,
            deliveriesUsed: 0,
            ip: input.ip ?? null,
            userAgent: input.userAgent?.slice(0, 300) ?? null,
            completedAt: now,
            expiresAt:
              fulfillment.claimDeadline ??
              new Date(now.getTime() + 30 * 24 * 3600 * 1000),
          })
          .returning();
        claim = created!;
      }

      if (claim.deliveriesUsed >= product.maxDeliveries) {
        throw new AppError(
          "DELIVERY_LIMIT",
          "Batas jumlah pengambilan produk ini sudah tercapai. Hubungi dukungan.",
          429,
        );
      }

      const [updatedClaim] = await tx
        .update(schema.claims)
        .set({
          deliveriesUsed: sql`${schema.claims.deliveriesUsed} + 1`,
          status: "COMPLETED",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.claims.id, claim.id))
        .returning();

      await tx
        .update(schema.fulfillments)
        .set({
          status: "CLAIMED",
          claimedAt: fulfillment.claimedAt ?? now,
          updatedAt: now,
        })
        .where(eq(schema.fulfillments.id, fulfillment.id));

      const base = { instructions: product.instructions ?? null };
      let payload: DeliveryPayload;

      if (product.deliveryKind === "FILE" && asset) {
        const ttlMs = settings.claim.downloadTtlMinutes * 60_000;
        const expiresAt = new Date(now.getTime() + ttlMs);
        const signed = signPayload(deps.config.downloadSigningSecret, {
          c: updatedClaim!.id,
          f: fulfillment.id,
          exp: Math.floor(expiresAt.getTime() / 1000),
        });
        payload = {
          kind: "FILE",
          fileName: asset.fileName,
          sizeBytes: asset.sizeBytes,
          url: `${deps.config.apiPublicOrigin.replace(/\/$/, "")}/api/claim/download/${signed}`,
          expiresAt: expiresAt.toISOString(),
          ...base,
        };
      } else if (product.deliveryKind === "LINK") {
        payload = { kind: "LINK", url: product.externalUrl!, ...base };
      } else if (product.deliveryKind === "INSTRUCTIONS") {
        payload = { kind: "INSTRUCTIONS", ...base };
      } else {
        // CODE or CREDENTIALS: take a code from the pool, or reuse the one already
        // assigned to this claim so a repeat visit shows the same secret.
        let secret: string;
        const [assigned] = await tx
          .select()
          .from(schema.digitalProductCodes)
          .where(
            eq(schema.digitalProductCodes.assignedClaimId, updatedClaim!.id),
          )
          .limit(1);

        if (assigned) {
          secret = decryptSecret(
            assigned.secretEnc,
            deps.config.appEncryptionKey,
          );
        } else {
          const [candidate] = await tx
            .select({
              id: schema.digitalProductCodes.id,
              secretEnc: schema.digitalProductCodes.secretEnc,
            })
            .from(schema.digitalProductCodes)
            .where(
              and(
                eq(schema.digitalProductCodes.digitalProductId, product.id),
                isNull(schema.digitalProductCodes.assignedClaimId),
              ),
            )
            .orderBy(schema.digitalProductCodes.createdAt)
            .limit(1)
            .for("update", { skipLocked: true });

          if (!candidate) {
            throw new AppError(
              "OUT_OF_STOCK",
              "Stok produk digital ini sedang habis. Hubungi penjual untuk pengiriman manual.",
              409,
            );
          }

          await tx
            .update(schema.digitalProductCodes)
            .set({ assignedClaimId: updatedClaim!.id, assignedAt: now })
            .where(eq(schema.digitalProductCodes.id, candidate.id));
          secret = decryptSecret(
            candidate.secretEnc,
            deps.config.appEncryptionKey,
          );
        }

        if (product.deliveryKind === "CREDENTIALS") {
          let parsed: { username?: string; password?: string };
          try {
            parsed = JSON.parse(secret) as {
              username?: string;
              password?: string;
            };
          } catch {
            // A credential stored as plain text is treated as the username.
            parsed = { username: secret };
          }
          payload = {
            kind: "CREDENTIALS",
            username: parsed.username ?? "",
            password: parsed.password ?? "",
            ...base,
          };
        } else {
          payload = { kind: "CODE", code: secret, ...base };
        }
      }

      // The reveal is logged, but it is not a download: the download limit counts
      // only rows that carry the asset key, which is why a reveal is marked.
      await tx.insert(schema.deliveryLogs).values({
        claimId: updatedClaim!.id,
        fulfillmentId: fulfillment.id,
        digitalProductId: product.id,
        kind: product.deliveryKind,
        reference: "reveal",
        ip: input.ip ?? null,
      });

      await tx.insert(schema.orderEvents).values({
        orderId: context.order.id,
        type: "DELIVERY_REVEALED",
        payload: { fulfillmentId: fulfillment.id, kind: product.deliveryKind },
      });

      // Order state follows the fulfilments: CLAIMED once anything is revealed,
      // COMPLETED when nothing is left outstanding.
      const siblings = await tx
        .select({ status: schema.fulfillments.status })
        .from(schema.fulfillments)
        .where(eq(schema.fulfillments.orderId, context.order.id));
      const allSettled = siblings.every(
        (entry) => entry.status === "CLAIMED" || entry.status === "REVOKED",
      );
      const nextState: OrderState = allSettled ? "COMPLETED" : "CLAIMED";

      if (nextState !== context.order.state) {
        await tx
          .update(schema.orders)
          .set({
            state: nextState,
            claimedAt: context.order.claimedAt ?? now,
            updatedAt: now,
          })
          .where(eq(schema.orders.id, context.order.id));
        await tx.insert(schema.orderEvents).values({
          orderId: context.order.id,
          type: "STATE_CHANGED",
          fromState: context.order.state,
          toState: nextState,
          payload: { trigger: "CLAIM" },
        });
      }

      completed.value = {
        claimId: updatedClaim!.id,
        productName: product.name,
        orderSn: context.order.orderSn,
      };
      return payload;
    });

    // The buyer has the product, so Shopee should hear about the shipment now
    // rather than when someone remembers to press a button. Queued, deduped, and
    // never allowed to fail the claim itself.
    await queueAutoShip(deps, context.order, context.store).catch(() => null);

    if (completed.value) {
      await notify(deps, {
        type: "claim.completed",
        title: `${completed.value.orderSn} mengambil ${completed.value.productName}`,
        data: {
          orderSn: completed.value.orderSn,
          product: completed.value.productName,
          claimId: completed.value.claimId,
        },
      });
    }

    return delivery;
  } catch (error) {
    if (error instanceof AppError && error.code === "OUT_OF_STOCK") {
      await notify(deps, {
        type: "fulfillment.out_of_stock",
        title: `Stok ${product.name} habis`,
        data: { product: product.name, orderSn: context.order.orderSn },
      });
    }
    throw error;
  }
}

export interface DownloadResolution {
  storageKey: string;
  fileName: string;
  mimeType: string;
  claimId: string;
}

/**
 * Resolves a signed download link. The signature proves the link was issued
 * here; the database checks prove the claim is still valid and within its
 * download limit, so a shared link stops working when the access is revoked.
 */
export async function resolveDownload(
  deps: ServiceDeps,
  token: string,
  ip?: string,
): Promise<DownloadResolution> {
  const verified = verifyPayload<{ c: string; f: string; exp: number }>(
    deps.config.downloadSigningSecret,
    token,
    nowOf(deps),
  );
  if (!verified.ok) {
    if (verified.reason === "EXPIRED")
      throw new AppError(
        "LINK_EXPIRED",
        "Tautan unduhan sudah kedaluwarsa. Buka kembali halaman klaim.",
        410,
      );
    throw new AppError("LINK_INVALID", "Tautan unduhan tidak valid.", 400);
  }

  const settings = await loadSettings(deps);
  const [row] = await deps.db
    .select({
      claim: schema.claims,
      fulfillment: schema.fulfillments,
      product: schema.digitalProducts,
    })
    .from(schema.claims)
    .innerJoin(
      schema.fulfillments,
      eq(schema.fulfillments.id, schema.claims.fulfillmentId),
    )
    .innerJoin(
      schema.digitalProducts,
      eq(schema.digitalProducts.id, schema.claims.digitalProductId),
    )
    .where(eq(schema.claims.id, verified.payload.c))
    .limit(1);

  if (!row) throw AppError.notFound("Klaim");
  if (row.claim.status === "REVOKED")
    throw new AppError(
      "ACCESS_REVOKED",
      "Akses produk ini sudah dicabut.",
      403,
    );
  if (row.claim.status === "EXPIRED")
    throw new AppError(
      "CLAIM_EXPIRED",
      "Masa klaim produk ini sudah berakhir.",
      410,
    );
  if (row.fulfillment.status === "REVOKED")
    throw new AppError(
      "ACCESS_REVOKED",
      "Akses produk ini sudah dicabut.",
      403,
    );

  const [asset] = await deps.db
    .select()
    .from(schema.digitalProductAssets)
    .where(eq(schema.digitalProductAssets.digitalProductId, row.product.id))
    .limit(1);
  if (!asset)
    throw new AppError(
      "PRODUCT_UNAVAILABLE",
      "File produk tidak ditemukan.",
      404,
    );

  const [downloads] = await deps.db
    .select({ value: count() })
    .from(schema.deliveryLogs)
    .where(
      and(
        eq(schema.deliveryLogs.claimId, row.claim.id),
        eq(schema.deliveryLogs.kind, "FILE"),
        ne(schema.deliveryLogs.reference, "reveal"),
      ),
    );

  if (
    Number(downloads?.value ?? 0) >= settings.claim.maxDownloadsPerFulfillment
  ) {
    throw new AppError(
      "DOWNLOAD_LIMIT",
      "Batas unduhan untuk produk ini sudah tercapai.",
      429,
    );
  }

  await deps.db.insert(schema.deliveryLogs).values({
    claimId: row.claim.id,
    fulfillmentId: row.fulfillment.id,
    digitalProductId: row.product.id,
    kind: "FILE",
    reference: asset.storageKey,
    ip: ip ?? null,
  });

  return {
    storageKey: asset.storageKey,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    claimId: row.claim.id,
  };
}

/* --------------------------------------------------------------- admin ops */

export async function revokeClaim(
  deps: ServiceDeps,
  input: {
    claimId: string;
    reason: string;
    actorLabel: string;
    actorId?: string | null;
    ip?: string | null;
  },
): Promise<void> {
  const now = nowOf(deps);
  const [claim] = await deps.db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.id, input.claimId))
    .limit(1);
  if (!claim) throw AppError.notFound("Klaim");

  await deps.db.transaction(async (tx) => {
    await tx
      .update(schema.claims)
      .set({
        status: "REVOKED",
        revokedAt: now,
        revokeReason: input.reason,
        updatedAt: now,
      })
      .where(eq(schema.claims.id, input.claimId));
    await tx
      .update(schema.fulfillments)
      .set({
        status: "REVOKED",
        revokedAt: now,
        revokeReason: input.reason,
        updatedAt: now,
      })
      .where(eq(schema.fulfillments.id, claim.fulfillmentId));
    await tx.insert(schema.orderEvents).values({
      orderId: claim.orderId,
      type: "CLAIM_REVOKED",
      payload: { claimId: input.claimId, reason: input.reason },
    });
  });

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel,
    action: "claim.revoke",
    targetType: "claim",
    targetId: input.claimId,
    metadata: { reason: input.reason },
    ip: input.ip ?? null,
  });

  await notify(deps, {
    type: "claim.revoked",
    title: `Akses klaim dicabut oleh ${input.actorLabel}`,
    data: { claimId: input.claimId, reason: input.reason },
  });
}

export async function reissueFulfillment(
  deps: ServiceDeps,
  input: {
    fulfillmentId: string;
    reason: string;
    actorLabel: string;
    actorId?: string | null;
    ip?: string | null;
    extendDays?: number;
  },
): Promise<void> {
  const now = nowOf(deps);
  const [fulfillment] = await deps.db
    .select()
    .from(schema.fulfillments)
    .where(eq(schema.fulfillments.id, input.fulfillmentId))
    .limit(1);
  if (!fulfillment) throw AppError.notFound("Fulfillment");

  const deadline = new Date(
    now.getTime() + (input.extendDays ?? 7) * 24 * 3600 * 1000,
  );
  await deps.db
    .update(schema.fulfillments)
    .set({
      status: "CLAIMABLE",
      claimedAt: null,
      revokedAt: null,
      revokeReason: null,
      claimDeadline: deadline,
      updatedAt: now,
    })
    .where(eq(schema.fulfillments.id, input.fulfillmentId));

  // The old claim stays as history but no longer grants anything.
  await deps.db
    .update(schema.claims)
    .set({
      status: "REVOKED",
      revokedAt: now,
      revokeReason: `reissued: ${input.reason}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.claims.fulfillmentId, input.fulfillmentId),
        inArray(schema.claims.status, ["ISSUED", "COMPLETED"]),
      ),
    );

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel,
    action: "fulfillment.reissue",
    targetType: "fulfillment",
    targetId: input.fulfillmentId,
    metadata: { reason: input.reason, deadline: deadline.toISOString() },
    ip: input.ip ?? null,
  });
}

/** Expires fulfilments whose claim window has passed, and the orders behind them. */
export async function expireStaleFulfillments(
  deps: ServiceDeps,
): Promise<{ fulfillments: number; orders: number }> {
  const now = nowOf(deps);
  const expired = await deps.db
    .update(schema.fulfillments)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(
      and(
        eq(schema.fulfillments.status, "CLAIMABLE"),
        lte(schema.fulfillments.claimDeadline, now),
      ),
    )
    .returning({ orderId: schema.fulfillments.orderId });

  const orderIds = [...new Set(expired.map((row) => row.orderId))];
  let orders = 0;
  for (const orderId of orderIds) {
    const [order] = await deps.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order || order.state !== "FULFILLED") continue;
    const siblings = await deps.db
      .select({ status: schema.fulfillments.status })
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.orderId, orderId));
    if (
      siblings.every(
        (row) => row.status === "EXPIRED" || row.status === "REVOKED",
      )
    ) {
      await deps.db
        .update(schema.orders)
        .set({ state: "EXPIRED", updatedAt: now })
        .where(eq(schema.orders.id, orderId));
      await deps.db.insert(schema.orderEvents).values({
        orderId,
        type: "STATE_CHANGED",
        fromState: order.state,
        toState: "EXPIRED",
        payload: { trigger: "CLAIM_WINDOW" },
      });
      orders += 1;
    }
  }

  return { fulfillments: expired.length, orders };
}

export async function recentClaimAttempts(deps: ServiceDeps, limit = 50) {
  return deps.db
    .select()
    .from(schema.claimAttempts)
    .orderBy(desc(schema.claimAttempts.createdAt))
    .limit(limit);
}
