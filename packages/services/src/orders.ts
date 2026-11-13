import {
  AppError,
  DEFAULT_ELIGIBLE_STATUSES,
  planTransition,
  deliveredQuantity,
  evaluateEligibility,
  ineligibleTargetState,
  isClaimableState,
  resolveMapping,
  type MappingCandidate,
  type OrderState,
} from "@qansa/core";
import { schema, type Order, type ShopeeStore } from "@qansa/db";
import type {
  NormalisedOrder,
  NormalisedOrderItem,
} from "@qansa/shopee-adapter";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { queueAutoShip } from "./shipping.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * The order pipeline. One function turns a Shopee order payload into rows the
 * claim portal can serve, and it is safe to run twice: pushes arrive late, in
 * pairs, or not at all, so every step is an upsert keyed by Shopee's own ids.
 */

export interface ProcessSummary {
  orderId: string;
  orderSn: string;
  state: OrderState;
  eligibility: string;
  items: number;
  mapped: number;
  unmapped: number;
  fulfillments: number;
  newlyClaimable: number;
  ignored: boolean;
}

/** Products referenced by an order must exist before a mapping can point at them. */
async function ensureProductStubs(
  deps: ServiceDeps,
  store: ShopeeStore,
  items: NormalisedOrderItem[],
): Promise<Map<number, string>> {
  const ids = [...new Set(items.map((item) => item.itemId))];
  if (ids.length === 0) return new Map();

  const existing = await deps.db
    .select({
      id: schema.shopeeProducts.id,
      itemId: schema.shopeeProducts.itemId,
    })
    .from(schema.shopeeProducts)
    .where(
      and(
        eq(schema.shopeeProducts.storeId, store.id),
        inArray(schema.shopeeProducts.itemId, ids),
      ),
    );

  const byItem = new Map(existing.map((row) => [row.itemId, row.id]));

  for (const item of items) {
    if (byItem.has(item.itemId)) continue;
    const name =
      typeof item.raw.item_name === "string"
        ? item.raw.item_name
        : item.itemName;
    const [row] = await deps.db
      .insert(schema.shopeeProducts)
      .values({ storeId: store.id, itemId: item.itemId, name, raw: item.raw })
      .onConflictDoNothing()
      .returning({ id: schema.shopeeProducts.id });

    if (row) {
      byItem.set(item.itemId, row.id);
    } else {
      const [again] = await deps.db
        .select({ id: schema.shopeeProducts.id })
        .from(schema.shopeeProducts)
        .where(
          and(
            eq(schema.shopeeProducts.storeId, store.id),
            eq(schema.shopeeProducts.itemId, item.itemId),
          ),
        )
        .limit(1);
      if (again) byItem.set(item.itemId, again.id);
    }
  }

  return byItem;
}

interface ResolvedLine {
  item: NormalisedOrderItem;
  itemRowId: string;
  mappingStatus: "UNMAPPED" | "MAPPED" | "AMBIGUOUS";
  digitalProductId: string | null;
  quantity: number;
  unmappedReason: string | null;
}

async function resolveLines(
  deps: ServiceDeps,
  store: ShopeeStore,
  items: NormalisedOrderItem[],
  productIds: Map<number, string>,
): Promise<ResolvedLine[]> {
  const shopeeProductIds = [...productIds.values()];
  if (shopeeProductIds.length === 0) return [];

  const variations = await deps.db
    .select({
      id: schema.shopeeVariations.id,
      productId: schema.shopeeVariations.productId,
      modelId: schema.shopeeVariations.modelId,
    })
    .from(schema.shopeeVariations)
    .where(inArray(schema.shopeeVariations.productId, shopeeProductIds));

  const variationByModel = new Map<string, string>();
  for (const variation of variations)
    variationByModel.set(
      `${variation.productId}:${variation.modelId}`,
      variation.id,
    );

  const mappings = await deps.db
    .select({
      id: schema.productMappings.id,
      shopeeProductId: schema.productMappings.shopeeProductId,
      shopeeVariationId: schema.productMappings.shopeeVariationId,
      digitalProductId: schema.productMappings.digitalProductId,
      quantityMultiplier: schema.productMappings.quantityMultiplier,
      isActive: schema.productMappings.isActive,
    })
    .from(schema.productMappings)
    .where(
      and(
        eq(schema.productMappings.storeId, store.id),
        inArray(schema.productMappings.shopeeProductId, shopeeProductIds),
      ),
    );

  const byProduct = new Map<string, MappingCandidate[]>();
  for (const mapping of mappings) {
    const list = byProduct.get(mapping.shopeeProductId) ?? [];
    list.push({
      id: mapping.id,
      shopeeVariationId: mapping.shopeeVariationId,
      digitalProductId: mapping.digitalProductId,
      quantityMultiplier: mapping.quantityMultiplier,
      isActive: mapping.isActive,
    });
    byProduct.set(mapping.shopeeProductId, list);
  }

  return items.map((item) => {
    const productRowId = productIds.get(item.itemId);
    if (!productRowId) {
      return {
        item,
        itemRowId: "",
        mappingStatus: "UNMAPPED" as const,
        digitalProductId: null,
        quantity: item.quantity,
        unmappedReason: "PRODUCT_MISSING",
      };
    }

    const candidates = byProduct.get(productRowId) ?? [];
    const variationId = item.modelId
      ? variationByModel.get(`${productRowId}:${item.modelId}`)
      : undefined;
    const outcome = resolveMapping(
      { itemId: item.itemId, modelId: item.modelId, candidates },
      () => variationId,
    );

    if (outcome.status === "MAPPED") {
      return {
        item,
        itemRowId: productRowId,
        mappingStatus: "MAPPED" as const,
        digitalProductId: outcome.mapping.digitalProductId,
        quantity: deliveredQuantity(item.quantity, outcome.quantityMultiplier),
        unmappedReason: null,
      };
    }
    if (outcome.status === "AMBIGUOUS") {
      return {
        item,
        itemRowId: productRowId,
        mappingStatus: "AMBIGUOUS" as const,
        digitalProductId: null,
        quantity: item.quantity,
        unmappedReason: "MULTIPLE_MAPPINGS",
      };
    }
    return {
      item,
      itemRowId: productRowId,
      mappingStatus: "UNMAPPED" as const,
      digitalProductId: null,
      quantity: item.quantity,
      unmappedReason: outcome.reason,
    };
  });
}

/**
 * Applies one Shopee order to the database. Everything happens in one
 * transaction: a half-written order with fulfilments but no items would be
 * worse than a failed attempt that the queue retries.
 */
export async function processOrderDetail(
  deps: ServiceDeps,
  store: ShopeeStore,
  detail: NormalisedOrder,
): Promise<ProcessSummary> {
  if (!detail.orderSn)
    throw AppError.validation("order payload has no order_sn");

  const productIds = await ensureProductStubs(deps, store, detail.items);
  const lines = await resolveLines(deps, store, detail.items, productIds);

  const eligibleStatuses =
    Array.isArray(store.eligibleStatuses) && store.eligibleStatuses.length > 0
      ? store.eligibleStatuses
      : DEFAULT_ELIGIBLE_STATUSES;
  const eligibility = evaluateEligibility({
    shopeeStatus: detail.status,
    eligibleStatuses,
  });

  const digitalProductIds = [
    ...new Set(
      lines
        .map((line) => line.digitalProductId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const digitalProducts = digitalProductIds.length
    ? await deps.db
        .select()
        .from(schema.digitalProducts)
        .where(inArray(schema.digitalProducts.id, digitalProductIds))
    : [];
  const digitalById = new Map(
    digitalProducts.map((product) => [product.id, product]),
  );

  const result = await deps.db.transaction(async (tx) => {
    const now = nowOf(deps);

    const [existingOrder] = await tx
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.storeId, store.id),
          eq(schema.orders.orderSn, detail.orderSn),
        ),
      )
      .limit(1);

    // A shipment the operator arranged must not be undone by a stale read. Shopee
    // still reporting the order as unshipped after ship_order succeeded is a
    // discrepancy worth seeing, not a reason to flip the order back.
    const PRE_SHIPMENT = ["UNPAID", "READY_TO_SHIP", "PROCESSED"];
    const regressedShipment =
      existingOrder?.shopeeStatus === "SHIPPED" &&
      PRE_SHIPMENT.includes(detail.status.toUpperCase());
    const shopeeStatus = regressedShipment ? "SHIPPED" : detail.status;

    const orderValues = {
      storeId: store.id,
      orderSn: detail.orderSn,
      buyerUsername: detail.buyerUsername,
      buyerPhoneMasked: detail.buyerPhoneMasked,
      shopeeStatus,
      totalAmount: detail.totalAmount,
      currency: detail.currency ?? "IDR",
      paymentMethod: detail.paymentMethod,
      messageToSeller: detail.messageToSeller,
      createTime: detail.createTime,
      updateTime: detail.updateTime,
      raw: detail.raw,
      syncedAt: now,
      updatedAt: now,
    };

    let order: Order;
    if (existingOrder) {
      const [updated] = await tx
        .update(schema.orders)
        .set({
          ...orderValues,
          ineligibleReason: eligibility.eligible ? null : eligibility.reason,
        })
        .where(eq(schema.orders.id, existingOrder.id))
        .returning();
      order = updated!;
      if (regressedShipment) {
        await tx.insert(schema.orderEvents).values({
          orderId: order.id,
          type: "SHIP_STATUS_DISCREPANCY",
          payload: { reported: detail.status, kept: "SHIPPED" },
        });
      }
    } else {
      const [created] = await tx
        .insert(schema.orders)
        .values({
          ...orderValues,
          state: "RECEIVED",
          ineligibleReason: eligibility.eligible ? null : eligibility.reason,
        })
        .returning();
      order = created!;
    }

    // Items are keyed by Shopee's item:model pair, so a repeated push updates
    // the same rows instead of duplicating the basket.
    const itemRows: Array<{ line: ResolvedLine; id: string }> = [];
    for (const line of lines) {
      const values = {
        orderId: order.id,
        lineKey: line.item.lineKey,
        itemId: line.item.itemId,
        modelId: line.item.modelId,
        itemName: line.item.itemName,
        variationName: line.item.variationName,
        quantity: line.item.quantity,
        amount: line.item.amount,
        imageUrl: line.item.imageUrl,
        raw: line.item.raw,
        mappingStatus: line.mappingStatus,
        digitalProductId: line.digitalProductId,
        unmappedReason: line.unmappedReason,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(schema.orderItems)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.orderItems.orderId, schema.orderItems.lineKey],
          set: {
            itemName: values.itemName,
            variationName: values.variationName,
            quantity: values.quantity,
            amount: values.amount,
            imageUrl: values.imageUrl,
            raw: values.raw,
            mappingStatus: values.mappingStatus,
            digitalProductId: values.digitalProductId,
            unmappedReason: values.unmappedReason,
            updatedAt: now,
          },
        })
        .returning({ id: schema.orderItems.id });
      itemRows.push({ line, id: row!.id });
    }

    // Fulfilments: one per (order item, digital product), created only for an
    // eligible order, and never reopened after a claim unless an operator
    // explicitly reissues it.
    let newFulfillments = 0;

    for (const { line, id } of itemRows) {
      if (line.mappingStatus !== "MAPPED" || !line.digitalProductId) continue;
      const digital = digitalById.get(line.digitalProductId);
      if (!digital) continue;

      const [existing] = await tx
        .select({
          id: schema.fulfillments.id,
          status: schema.fulfillments.status,
          claimedAt: schema.fulfillments.claimedAt,
        })
        .from(schema.fulfillments)
        .where(
          and(
            eq(schema.fulfillments.orderItemId, id),
            eq(schema.fulfillments.digitalProductId, line.digitalProductId),
          ),
        )
        .limit(1);

      const productReady = digital.status === "ACTIVE";
      const status = !eligibility.eligible
        ? "PENDING"
        : productReady
          ? "CLAIMABLE"
          : "PENDING";
      const failureReason =
        eligibility.eligible && !productReady ? "PRODUCT_NOT_ACTIVE" : null;
      const deadline = new Date(
        now.getTime() + digital.claimExpiryDays * 24 * 3600 * 1000,
      );

      if (!existing) {
        await tx.insert(schema.fulfillments).values({
          orderId: order.id,
          orderItemId: id,
          storeId: store.id,
          digitalProductId: line.digitalProductId,
          quantity: line.quantity,
          status,
          claimDeadline: deadline,
          failureReason,
        });
        newFulfillments += 1;
      } else if (!existing.claimedAt && existing.status !== "REVOKED") {
        await tx
          .update(schema.fulfillments)
          .set({
            quantity: line.quantity,
            status,
            claimDeadline: existing.status === status ? undefined : deadline,
            failureReason,
            updatedAt: now,
          })
          .where(eq(schema.fulfillments.id, existing.id));
      } else if (existing.status === "REVOKED") {
        await tx
          .update(schema.fulfillments)
          .set({ quantity: line.quantity, updatedAt: now })
          .where(eq(schema.fulfillments.id, existing.id));
      }
    }

    // Revoking: a cancelled order must not keep a live download.
    if (eligibility.revokes) {
      const revokedFulfillments = await tx
        .update(schema.fulfillments)
        .set({
          status: "REVOKED",
          revokedAt: now,
          revokeReason: `Shopee status ${detail.status}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.fulfillments.orderId, order.id),
            inArray(schema.fulfillments.status, [
              "PENDING",
              "CLAIMABLE",
              "CLAIMED",
            ]),
          ),
        )
        .returning({ id: schema.fulfillments.id });

      if (revokedFulfillments.length > 0) {
        await tx
          .update(schema.claims)
          .set({
            status: "REVOKED",
            revokedAt: now,
            revokeReason: `Shopee status ${detail.status}`,
          })
          .where(
            and(
              eq(schema.claims.orderId, order.id),
              inArray(schema.claims.status, ["ISSUED", "COMPLETED"]),
            ),
          );
      }
    }

    // A buyer may already have claimed; then the target is COMPLETED when every
    // fulfilment is settled.
    const orderFulfillments = await tx
      .select({ status: schema.fulfillments.status })
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.orderId, order.id));

    const allClaimed =
      orderFulfillments.length > 0 &&
      orderFulfillments.every(
        (row) => row.status === "CLAIMED" || row.status === "REVOKED",
      );
    const anyClaimed = orderFulfillments.some(
      (row) => row.status === "CLAIMED",
    );
    const fulfilledNow = orderFulfillments.filter(
      (row) => row.status === "CLAIMABLE",
    ).length;

    let target: OrderState;
    if (eligibility.revokes) {
      target =
        order.state === "COMPLETED" || order.state === "CANCELLED"
          ? order.state
          : "CANCELLED";
    } else if (!eligibility.eligible) {
      target = ineligibleTargetState(false);
    } else if (anyClaimed && allClaimed) {
      target = "COMPLETED";
    } else if (anyClaimed) {
      target = "CLAIMED";
    } else if (fulfilledNow > 0) {
      target = "FULFILLED";
    } else {
      target = "VALIDATED";
    }

    let finalState = order.state;
    if (target !== order.state) {
      const hops = planTransition(order.state, target);
      if (hops.length > 0) {
        const [moved] = await tx
          .update(schema.orders)
          .set({
            state: target,
            updatedAt: now,
            ...(target === "VALIDATED" && !order.paidAt ? { paidAt: now } : {}),
            ...(target === "CLAIMED" && !order.claimedAt
              ? { claimedAt: now }
              : {}),
          })
          .where(eq(schema.orders.id, order.id))
          .returning({ state: schema.orders.state });
        finalState = moved!.state;

        // One event per hop, so the audit trail reads as the real sequence.
        let previous: string = order.state;
        for (const hop of hops) {
          await tx.insert(schema.orderEvents).values({
            orderId: order.id,
            type: "STATE_CHANGED",
            fromState: previous,
            toState: hop,
            payload: {
              shopeeStatus: detail.status,
              reason: eligibility.reason,
            },
          });
          previous = hop;
        }
      } else {
        // A late push must never drag a claimed order backwards; the event is
        // the record of why nothing moved.
        await tx.insert(schema.orderEvents).values({
          orderId: order.id,
          type: "STATE_HELD",
          fromState: order.state,
          toState: target,
          payload: { shopeeStatus: detail.status },
        });
        finalState = order.state as OrderState;
      }
    }

    await tx.insert(schema.orderEvents).values({
      orderId: order.id,
      type: "ORDER_SYNCED",
      payload: {
        shopeeStatus: detail.status,
        eligibility: eligibility.reason,
        items: lines.length,
        mapped: lines.filter((line) => line.mappingStatus === "MAPPED").length,
        claimable: fulfilledNow,
      },
    });

    return {
      orderId: order.id,
      orderSn: order.orderSn,
      state: finalState,
      eligibility: eligibility.reason,
      items: lines.length,
      mapped: lines.filter((line) => line.mappingStatus === "MAPPED").length,
      unmapped: lines.filter((line) => line.mappingStatus !== "MAPPED").length,
      fulfillments: orderFulfillments.length,
      newlyClaimable: newFulfillments,
      ignored: false,
    } satisfies ProcessSummary;
  });

  // A digital order counts as delivered once it is paid, so the shipment may leave
  // for Shopee without waiting for the buyer to collect it. Queued after the
  // transaction commits, so a Shopee call can never roll back the pipeline.
  const [fresh] = await deps.db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, result.orderId))
    .limit(1);
  if (fresh)
    await queueAutoShip(deps, fresh, store, "ON_PAYMENT").catch(() => null);

  return result;
}

/**
 * Fetches one order from Shopee and runs it through the pipeline. Used by the
 * webhook worker: the push tells us an order number, never the details, because
 * a push body is not a source of truth.
 */
export async function processOrder(
  deps: ServiceDeps,
  storeId: string,
  orderSn: string,
): Promise<ProcessSummary | null> {
  const { getStoreAccess } = await import("./tokens.js");
  const { store, access } = await getStoreAccess(deps, storeId);
  const orders = await deps.gateway.getOrders(access, [orderSn]);
  const detail = orders[0];
  if (!detail) return null;
  return processOrderDetail(deps, store, detail);
}

/** Guard used by tests and by the admin "reprocess" action. */
export function assertClaimableState(state: string): void {
  if (!isClaimableState(state as OrderState)) {
    throw AppError.conflict(
      "ORDER_NOT_ELIGIBLE",
      "Pesanan belum memenuhi syarat untuk diklaim",
    );
  }
}

export async function countUnmappedItems(deps: ServiceDeps): Promise<number> {
  const rows = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.orderItems)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
    .where(
      and(
        eq(schema.orderItems.mappingStatus, "UNMAPPED"),
        eq(schema.orders.state, "VALIDATED"),
      ),
    );
  return rows[0]?.count ?? 0;
}

export { isNull };
