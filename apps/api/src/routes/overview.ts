import type { FastifyInstance } from "fastify";
import { desc, sql } from "drizzle-orm";
import { schema } from "@qansa/db";
import { queueStats, recentClaimAttempts } from "@qansa/services";
import { requirePermission } from "../auth.js";

/**
 * Overview and monitoring. Every number here is a query, not a cached guess:
 * an operator looking at "orders awaiting fulfilment" expects it to match the
 * order list one click away.
 */

const DAY_MS = 24 * 3600 * 1000;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function seriesOf(
  rows: Array<{ day: string; value: number | string }>,
  days: number,
): Array<{ day: string; value: number }> {
  const byDay = new Map(rows.map((row) => [row.day, Number(row.value)]));
  const today = new Date();
  const out: Array<{ day: string; value: number }> = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const key = dayKey(new Date(today.getTime() - index * DAY_MS));
    out.push({ day: key, value: byDay.get(key) ?? 0 });
  }
  return out;
}

export async function overviewRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "overview:read");
  const monitor = requirePermission(ctx, "monitoring:read");

  app.get("/api/admin/overview", { preHandler: read }, async () => {
    const since = new Date(Date.now() - 14 * DAY_MS);
    const db = ctx.db;

    const [stores] = await db
      .select({
        total: sql<number>`count(*)`,
        connected: sql<number>`count(*) filter (where ${schema.shopeeStores.status} = 'CONNECTED')`,
        errored: sql<number>`count(*) filter (where ${schema.shopeeStores.status} = 'ERROR')`,
      })
      .from(schema.shopeeStores);

    const [products] = await db
      .select({
        total: sql<number>`count(*)`,
      })
      .from(schema.shopeeProducts)
      .where(sql`${schema.shopeeProducts.deletedAt} is null`);

    const [digital] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.digitalProducts);

    const [orderStats] = await db
      .select({
        total: sql<number>`count(*)`,
        paid: sql<number>`count(*) filter (where ${schema.orders.state} in ('VALIDATED','FULFILLED','CLAIMED','COMPLETED'))`,
        claimable: sql<number>`count(*) filter (where ${schema.orders.state} = 'FULFILLED')`,
        claimed: sql<number>`count(*) filter (where ${schema.orders.state} in ('CLAIMED','COMPLETED'))`,
        ineligible: sql<number>`count(*) filter (where ${schema.orders.state} in ('INELIGIBLE','CANCELLED'))`,
        awaitingSync: sql<number>`count(*) filter (where ${schema.orders.state} = 'VALIDATED')`,
      })
      .from(schema.orders);

    const [claims] = await db
      .select({
        successful: sql<number>`count(*) filter (where ${schema.claims.status} = 'COMPLETED')`,
        revoked: sql<number>`count(*) filter (where ${schema.claims.status} = 'REVOKED')`,
      })
      .from(schema.claims);

    const [attempts] = await db
      .select({
        failed24h: sql<number>`count(*) filter (where ${schema.claimAttempts.success} = false and ${schema.claimAttempts.createdAt} > now() - interval '24 hours')`,
        total24h: sql<number>`count(*) filter (where ${schema.claimAttempts.createdAt} > now() - interval '24 hours')`,
      })
      .from(schema.claimAttempts);

    const [pending] = await db
      .select({
        total: sql<number>`count(*) filter (where ${schema.syncJobs.status} in ('QUEUED','RUNNING'))`,
      })
      .from(schema.syncJobs);

    const [unmapped] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.orderItems)
      .where(sql`${schema.orderItems.mappingStatus} <> 'MAPPED'`);

    const [unmappedListings] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.shopeeProducts)
      .leftJoin(
        schema.productMappings,
        sql`${schema.productMappings.shopeeProductId} = ${schema.shopeeProducts.id}`,
      )
      .where(
        sql`${schema.shopeeProducts.deletedAt} is null and ${schema.productMappings.id} is null`,
      );

    const orderSeries = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${schema.orders.createdAt}), 'YYYY-MM-DD')`,
        value: sql<number>`count(*)`,
      })
      .from(schema.orders)
      // The parameter is cast explicitly: with prepared statements disabled,
      // postgres-js cannot infer the type of a bare Date inside sql``.
      .where(
        sql`${schema.orders.createdAt} >= ${since.toISOString()}::timestamptz`,
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const claimSeries = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${schema.claims.createdAt}), 'YYYY-MM-DD')`,
        value: sql<number>`count(*)`,
      })
      .from(schema.claims)
      .where(
        sql`${schema.claims.createdAt} >= ${since.toISOString()}::timestamptz`,
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const recentOrders = await db
      .select({
        id: schema.orders.id,
        orderSn: schema.orders.orderSn,
        state: schema.orders.state,
        buyerUsername: schema.orders.buyerUsername,
        totalAmount: schema.orders.totalAmount,
        syncedAt: schema.orders.syncedAt,
        storeLabel: schema.shopeeStores.label,
      })
      .from(schema.orders)
      .innerJoin(
        schema.shopeeStores,
        sql`${schema.shopeeStores.id} = ${schema.orders.storeId}`,
      )
      .orderBy(desc(schema.orders.syncedAt))
      .limit(6);

    const activity = await db
      .select({
        id: schema.auditLogs.id,
        action: schema.auditLogs.action,
        actorLabel: schema.auditLogs.actorLabel,
        targetType: schema.auditLogs.targetType,
        createdAt: schema.auditLogs.createdAt,
      })
      .from(schema.auditLogs)
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(8);

    return {
      stores: {
        total: Number(stores?.total ?? 0),
        connected: Number(stores?.connected ?? 0),
        errored: Number(stores?.errored ?? 0),
      },
      products: {
        shopee: Number(products?.total ?? 0),
        digital: Number(digital?.total ?? 0),
        unmappedListings: Number(unmappedListings?.total ?? 0),
      },
      orders: {
        total: Number(orderStats?.total ?? 0),
        paid: Number(orderStats?.paid ?? 0),
        claimable: Number(orderStats?.claimable ?? 0),
        claimed: Number(orderStats?.claimed ?? 0),
        ineligible: Number(orderStats?.ineligible ?? 0),
        awaitingSync: Number(orderStats?.awaitingSync ?? 0),
        unmappedItems: Number(unmapped?.total ?? 0),
      },
      claims: {
        successful: Number(claims?.successful ?? 0),
        revoked: Number(claims?.revoked ?? 0),
        failedAttempts24h: Number(attempts?.failed24h ?? 0),
        attempts24h: Number(attempts?.total24h ?? 0),
      },
      pendingSync: Number(pending?.total ?? 0),
      series: {
        orders: seriesOf(orderSeries, 14),
        claims: seriesOf(claimSeries, 14),
      },
      recentOrders,
      activity,
      gatewayMode: ctx.config.gatewayMode,
    };
  });

  app.get("/api/admin/monitoring", { preHandler: monitor }, async () => {
    const db = ctx.db;

    const [webhooks] = await db
      .select({
        total24h: sql<number>`count(*) filter (where ${schema.webhookEvents.receivedAt} > now() - interval '24 hours')`,
        failed24h: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'FAILED' and ${schema.webhookEvents.receivedAt} > now() - interval '24 hours')`,
        invalidSignature24h: sql<number>`count(*) filter (where ${schema.webhookEvents.signatureValid} = false and ${schema.webhookEvents.receivedAt} > now() - interval '24 hours')`,
        invalidSignature15m: sql<number>`count(*) filter (where ${schema.webhookEvents.signatureValid} = false and ${schema.webhookEvents.receivedAt} > now() - interval '15 minutes')`,
        duplicates24h: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'DUPLICATE' and ${schema.webhookEvents.receivedAt} > now() - interval '24 hours')`,
      })
      .from(schema.webhookEvents);

    const recentWebhooks = await db
      .select({
        id: schema.webhookEvents.id,
        code: schema.webhookEvents.code,
        shopId: schema.webhookEvents.shopId,
        orderSn: schema.webhookEvents.orderSn,
        status: schema.webhookEvents.status,
        signatureValid: schema.webhookEvents.signatureValid,
        error: schema.webhookEvents.error,
        receivedAt: schema.webhookEvents.receivedAt,
      })
      .from(schema.webhookEvents)
      .orderBy(desc(schema.webhookEvents.receivedAt))
      .limit(10);

    const queue = await queueStats(ctx.deps);

    const deadJobs = await db
      .select({
        id: schema.jobs.id,
        type: schema.jobs.type,
        attempts: schema.jobs.attempts,
        lastError: schema.jobs.lastError,
        completedAt: schema.jobs.completedAt,
      })
      .from(schema.jobs)
      .where(sql`${schema.jobs.status} = 'DEAD'`)
      .orderBy(desc(schema.jobs.completedAt))
      .limit(10);

    const failedSyncs = await db
      .select({
        id: schema.syncJobs.id,
        type: schema.syncJobs.type,
        status: schema.syncJobs.status,
        error: schema.syncJobs.error,
        finishedAt: schema.syncJobs.finishedAt,
        storeLabel: schema.shopeeStores.label,
      })
      .from(schema.syncJobs)
      .innerJoin(
        schema.shopeeStores,
        sql`${schema.shopeeStores.id} = ${schema.syncJobs.storeId}`,
      )
      .where(sql`${schema.syncJobs.status} in ('FAILED','DEAD')`)
      .orderBy(desc(schema.syncJobs.createdAt))
      .limit(10);

    const tokenHealth = await db
      .select({
        storeId: schema.shopeeStores.id,
        label: schema.shopeeStores.label,
        status: schema.shopeeStores.status,
        lastError: schema.shopeeStores.lastError,
        expiresAt: schema.shopeeTokens.expiresAt,
      })
      .from(schema.shopeeStores)
      .leftJoin(
        schema.shopeeTokens,
        sql`${schema.shopeeTokens.storeId} = ${schema.shopeeStores.id}`,
      );

    const [unmappedItems] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.orderItems)
      .where(sql`${schema.orderItems.mappingStatus} <> 'MAPPED'`);

    const [unmappedListings] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.shopeeProducts)
      .leftJoin(
        schema.productMappings,
        sql`${schema.productMappings.shopeeProductId} = ${schema.shopeeProducts.id}`,
      )
      .where(
        sql`${schema.shopeeProducts.deletedAt} is null and ${schema.productMappings.id} is null`,
      );

    /**
     * Digital orders that are already delivered through the portal but still sit
     * in `READY_TO_SHIP` on Shopee. Nothing in this platform ships an order for
     * the seller, so these need a human before Shopee's shipping deadline turns
     * into an automatic cancellation and a refund of an already delivered product.
     */
    const awaitingShipment = await db
      .select({
        orderSn: schema.orders.orderSn,
        state: schema.orders.state,
        shopeeStatus: schema.orders.shopeeStatus,
        createdAt: schema.orders.createdAt,
        storeLabel: schema.shopeeStores.label,
      })
      .from(schema.orders)
      .innerJoin(
        schema.shopeeStores,
        sql`${schema.shopeeStores.id} = ${schema.orders.storeId}`,
      )
      .where(
        sql`${schema.orders.shopeeStatus} = 'READY_TO_SHIP' and ${schema.orders.state} in ('FULFILLED','CLAIMED','COMPLETED')`,
      )
      .orderBy(schema.orders.createdAt)
      .limit(50);

    const oldestHours = awaitingShipment[0]?.createdAt
      ? Math.round(
          (Date.now() - awaitingShipment[0].createdAt.getTime()) / 3_600_000,
        )
      : null;

    const attempts = await recentClaimAttempts(ctx.deps, 10);

    const alerts: Array<{
      level: "warning" | "critical";
      code: string;
      message: string;
    }> = [];
    // One forged push is noise: scanners and every preflight run produce one. A run
    // of them inside fifteen minutes is a wrong shared secret or someone probing on
    // purpose, and that is worth waking up for.
    const invalidSignatures = Number(webhooks?.invalidSignature15m ?? 0);
    if (invalidSignatures >= 3) {
      alerts.push({
        level: "critical",
        code: "WEBHOOK_SIGNATURE",
        message: `${invalidSignatures} push dengan tanda tangan tidak valid dalam 15 menit terakhir`,
      });
    }
    if (queue.dead > 0)
      alerts.push({
        level: "critical",
        code: "DEAD_JOBS",
        message: `${queue.dead} job berhenti di dead letter`,
      });
    if (Number(unmappedListings?.total ?? 0) > 0) {
      alerts.push({
        level: "warning",
        code: "UNMAPPED_LISTINGS",
        message: `${unmappedListings?.total} produk Shopee belum dipetakan`,
      });
    }
    const expiring = tokenHealth.filter(
      (row) =>
        row.expiresAt && row.expiresAt.getTime() - Date.now() < 30 * 60_000,
    );
    if (expiring.length > 0) {
      alerts.push({
        level: "warning",
        code: "TOKEN_EXPIRING",
        message: `${expiring.length} token toko akan kedaluwarsa dalam 30 menit`,
      });
    }
    if (awaitingShipment.length > 0) {
      alerts.push({
        level: "warning",
        code: "AWAITING_SHIPMENT",
        message: `${awaitingShipment.length} pesanan sudah diklaim tapi belum ditandai dikirim di Shopee (tertua ${oldestHours} jam)`,
      });
    }
    const errored = tokenHealth.filter((row) => row.status === "ERROR");
    if (errored.length > 0)
      alerts.push({
        level: "critical",
        code: "STORE_ERROR",
        message: `${errored.length} toko bermasalah: ${errored.map((row) => row.label).join(", ")}`,
      });

    return {
      webhooks: {
        total24h: Number(webhooks?.total24h ?? 0),
        failed24h: Number(webhooks?.failed24h ?? 0),
        invalidSignature24h: Number(webhooks?.invalidSignature24h ?? 0),
        duplicates24h: Number(webhooks?.duplicates24h ?? 0),
        recent: recentWebhooks,
        configured: Boolean(ctx.config.pushUrl),
      },
      queue,
      deadJobs,
      failedSyncs,
      tokenHealth: tokenHealth.map((row) => ({
        ...row,
        minutesLeft: row.expiresAt
          ? Math.round((row.expiresAt.getTime() - Date.now()) / 60_000)
          : null,
      })),
      unmapped: {
        items: Number(unmappedItems?.total ?? 0),
        listings: Number(unmappedListings?.total ?? 0),
      },
      shipping: {
        awaitingShipment: awaitingShipment.length,
        oldestHours,
        sample: awaitingShipment.slice(0, 5).map((row) => ({
          orderSn: row.orderSn,
          state: row.state,
          shopeeStatus: row.shopeeStatus,
          storeLabel: row.storeLabel,
          hours: Math.round((Date.now() - row.createdAt.getTime()) / 3_600_000),
        })),
      },
      attempts,
      alerts,
      gatewayMode: ctx.config.gatewayMode,
    };
  });
}
