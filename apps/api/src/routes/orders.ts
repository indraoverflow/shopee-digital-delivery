import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { requirePermission } from "../auth.js";
import { paginate, paginationSchema } from "./common.js";
import { enqueue, markShipped } from "@qansa/services";

/**
 * Order visibility. The admin pages read from this module; nothing here can
 * change an order's state by hand, because Shopee owns that truth and the
 * pipeline is the only writer.
 */

const states = ["RECEIVED", "VALIDATED", "FULFILLED", "CLAIMED", "COMPLETED", "INELIGIBLE", "CANCELLED", "EXPIRED", "FAILED"] as const;

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "order:read");
  // Resync and shipment are writes: a VIEWER must not be able to requeue jobs or
  // move an order in Shopee just because it may read the list.
  const write = requirePermission(ctx, "order:write");

  app.get("/api/admin/orders", { preHandler: read }, async (request) => {
    const query = paginationSchema
      .extend({
        storeId: z.string().uuid().optional(),
        state: z.enum(states).optional(),
        query: z.string().trim().max(120).optional(),
        mapping: z.enum(["all", "unmapped", "mapped"]).default("all"),
      })
      .parse(request.query);

    const filters = [
      ...(query.storeId ? [eq(schema.orders.storeId, query.storeId)] : []),
      ...(query.state ? [eq(schema.orders.state, query.state)] : []),
      ...(query.query ? [sql`(${schema.orders.orderSn} ilike ${`%${query.query}%`} or ${schema.orders.buyerUsername} ilike ${`%${query.query}%`})`] : []),
    ];
    const where = filters.length ? and(...filters) : undefined;

    const rows = await ctx.db
      .select({ order: schema.orders, storeLabel: schema.shopeeStores.label })
      .from(schema.orders)
      .innerJoin(schema.shopeeStores, eq(schema.shopeeStores.id, schema.orders.storeId))
      .where(where)
      .orderBy(desc(schema.orders.syncedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const [total] = await ctx.db.select({ value: count() }).from(schema.orders).where(where);

    const orderIds = rows.map((row) => row.order.id);
    const items = orderIds.length
      ? await ctx.db
          .select({
            orderId: schema.orderItems.orderId,
            total: count(),
            unmapped: sql<number>`count(*) filter (where ${schema.orderItems.mappingStatus} <> 'MAPPED')`,
          })
          .from(schema.orderItems)
          .where(sql`${schema.orderItems.orderId} in ${orderIds}`)
          .groupBy(schema.orderItems.orderId)
      : [];
    const fulfillments = orderIds.length
      ? await ctx.db
          .select({
            orderId: schema.fulfillments.orderId,
            total: count(),
            claimable: sql<number>`count(*) filter (where ${schema.fulfillments.status} = 'CLAIMABLE')`,
            claimed: sql<number>`count(*) filter (where ${schema.fulfillments.status} = 'CLAIMED')`,
          })
          .from(schema.fulfillments)
          .where(sql`${schema.fulfillments.orderId} in ${orderIds}`)
          .groupBy(schema.fulfillments.orderId)
      : [];

    const itemStats = new Map(items.map((row) => [row.orderId, row]));
    const fulfillmentStats = new Map(fulfillments.map((row) => [row.orderId, row]));

    const data = rows
      .map((row) => ({
        ...row.order,
        storeLabel: row.storeLabel,
        items: Number(itemStats.get(row.order.id)?.total ?? 0),
        unmappedItems: Number(itemStats.get(row.order.id)?.unmapped ?? 0),
        fulfillments: Number(fulfillmentStats.get(row.order.id)?.total ?? 0),
        claimable: Number(fulfillmentStats.get(row.order.id)?.claimable ?? 0),
        claimed: Number(fulfillmentStats.get(row.order.id)?.claimed ?? 0),
      }))
      .filter((row) => (query.mapping === "all" ? true : query.mapping === "unmapped" ? row.unmappedItems > 0 : row.unmappedItems === 0));

    return paginate(data, query.page, query.pageSize, Number(total?.value ?? 0));
  });

  app.get<{ Params: { id: string } }>("/api/admin/orders/:id", { preHandler: read }, async (request) => {
    const [row] = await ctx.db
      .select({ order: schema.orders, store: schema.shopeeStores })
      .from(schema.orders)
      .innerJoin(schema.shopeeStores, eq(schema.shopeeStores.id, schema.orders.storeId))
      .where(eq(schema.orders.id, request.params.id))
      .limit(1);
    if (!row) throw AppError.notFound("Pesanan");

    const items = await ctx.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, row.order.id));
    const fulfillments = await ctx.db
      .select({ fulfillment: schema.fulfillments, productName: schema.digitalProducts.name, deliveryKind: schema.digitalProducts.deliveryKind })
      .from(schema.fulfillments)
      .innerJoin(schema.digitalProducts, eq(schema.digitalProducts.id, schema.fulfillments.digitalProductId))
      .where(eq(schema.fulfillments.orderId, row.order.id));
    const claims = await ctx.db.select().from(schema.claims).where(eq(schema.claims.orderId, row.order.id)).orderBy(desc(schema.claims.createdAt));
    const events = await ctx.db.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, row.order.id)).orderBy(desc(schema.orderEvents.createdAt));
    const deliveries = await ctx.db
      .select({ log: schema.deliveryLogs, productName: schema.digitalProducts.name })
      .from(schema.deliveryLogs)
      .innerJoin(schema.digitalProducts, eq(schema.digitalProducts.id, schema.deliveryLogs.digitalProductId))
      .where(sql`${schema.deliveryLogs.claimId} in (select id from ${schema.claims} where order_id = ${row.order.id})`)
      .orderBy(desc(schema.deliveryLogs.createdAt));

    return {
      order: row.order,
      store: {
        id: row.store.id,
        label: row.store.label,
        shopId: row.store.shopId,
        environment: row.store.environment,
        verificationPolicy: row.store.verificationPolicy,
      },
      items,
      fulfillments: fulfillments.map((entry) => ({ ...entry.fulfillment, productName: entry.productName, deliveryKind: entry.deliveryKind })),
      claims,
      events,
      deliveries,
    };
  });

  /** Re-runs the pipeline for one order: the safe way to fix a half-synced order. */
  app.post<{ Params: { id: string } }>("/api/admin/orders/:id/resync", { preHandler: write }, async (request) => {
    const [order] = await ctx.db.select().from(schema.orders).where(eq(schema.orders.id, request.params.id)).limit(1);
    if (!order) throw AppError.notFound("Pesanan");

    const jobId = await enqueue(ctx.deps, {
      type: "PROCESS_ORDER",
      payload: { storeId: order.storeId, orderSn: order.orderSn },
      dedupeKey: `order:${order.storeId}:${order.orderSn}`,
    });

    await ctx.audit({
      actorType: "ADMIN",
      actorId: request.user?.id ?? null,
      actorLabel: request.user?.email ?? "admin",
      action: "order.resync",
      targetType: "order",
      targetId: order.id,
      metadata: { jobId },
      ip: request.ip,
    });

    return { queued: true, jobId };
  });

  /**
   * Arranges shipment in Shopee for an order the buyer has already collected.
   * Without this, Shopee cancels the unshipped order and refunds a product that
   * was delivered. Operator action, audited, never a side effect of claiming.
   */
  app.post<{ Params: { id: string } }>("/api/admin/orders/:id/ship", { preHandler: write }, async (request) => {
    const user = request.user;
    const result = await markShipped(ctx.deps, {
      orderId: request.params.id,
      actor: { id: user?.id ?? "system", email: user?.email ?? "system" },
      ip: request.ip,
    });
    return { ok: true, ...result };
  });
}
