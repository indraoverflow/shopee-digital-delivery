import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDatabase, schema, type TestDatabase } from "@qansa/db";
import { encryptSecret } from "@qansa/core";
import { FixtureShopeeGateway, type FixtureStore } from "@qansa/shopee-adapter";
import {
  createSyncJob,
  enqueue,
  queueStats,
  recoverStuckJobs,
  type ServiceDeps,
} from "@qansa/services";
import { handleJob, runOnce, scheduleMaintenance } from "../src/worker.js";

/**
 * Worker behaviour: the queue's locking, retry and dead-letter rules, and one
 * end-to-end trip from a queued PROCESS_ORDER to a claimable fulfilment.
 */

const KEY = "e".repeat(64);
let db: TestDatabase | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const fixture = (): FixtureStore => ({
  shopId: 660001,
  shopName: "tokouji",
  products: [
    {
      item_id: 301,
      item_name: "Lisensi Aplikasi",
      models: [
        { model_id: 4001, model_name: "1 Bulan", price: 25000, stock: 10 },
      ],
    },
  ],
  orders: [
    {
      order_sn: "260202WRK0001",
      order_status: "READY_TO_SHIP",
      buyer_username: "pembeli_uji",
      recipient_phone: "********4455",
      create_time: 1_767_000_000,
      update_time: 1_767_000_600,
      items: [
        {
          item_id: 301,
          model_id: 4001,
          item_name: "Lisensi Aplikasi",
          model_name: "1 Bulan",
          quantity: 1,
        },
      ],
    },
  ],
});

async function setup(
  options: { failOn?: string[]; storeStatus?: "CONNECTED" | "ERROR" } = {},
) {
  db = await createTestDatabase();
  const [store] = await db.db
    .insert(schema.shopeeStores)
    .values({
      shopId: 660001,
      label: "tokouji",
      status: options.storeStatus ?? "CONNECTED",
      environment: "SANDBOX",
    })
    .returning();

  await db.db.insert(schema.shopeeTokens).values({
    storeId: store!.id,
    accessTokenEnc: encryptSecret("access", KEY),
    refreshTokenEnc: encryptSecret("refresh", KEY),
    expiresAt: new Date(Date.now() + 3600_000),
  });

  const deps: ServiceDeps = {
    db: db.db,
    gateway: new FixtureShopeeGateway([fixture()], {
      ...(options.failOn ? { failOn: options.failOn } : {}),
    }),
    config: {
      appEncryptionKey: KEY,
      downloadSigningSecret: "f".repeat(40),
      uploadDir: "/tmp/qansa-worker-test",
      claimOrigin: "https://claim.qansa.web.id",
      apiPublicOrigin: "https://api.qansa.web.id",
      gatewayMode: "fixture",
      orderLookbackHours: 72,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  return { deps, storeId: store!.id, context: { deps, logger: deps.logger } };
}

describe("queue", () => {
  it("dedupes a pending job with the same key and runs it to success", async () => {
    const { deps, storeId, context } = await setup();

    const first = await enqueue(deps, {
      type: "PROCESS_ORDER",
      payload: { storeId, orderSn: "260202WRK0001" },
      dedupeKey: "order:1",
    });
    const second = await enqueue(deps, {
      type: "PROCESS_ORDER",
      payload: { storeId, orderSn: "260202WRK0001" },
      dedupeKey: "order:1",
    });
    expect(first).toBeTruthy();
    expect(second).toBeNull();

    const result = await runOnce(context, { workerId: "test-worker" });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const [job] = await db!.db.select().from(schema.jobs);
    expect(job!.status).toBe("SUCCEEDED");
    expect(job!.attempts).toBe(1);

    const [order] = await db!.db.select().from(schema.orders);
    expect(order!.orderSn).toBe("260202WRK0001");
    expect(order!.state).toBe("VALIDATED"); // no mapping yet, but persisted
  });

  it("reports an empty queue instead of spinning", async () => {
    const { context } = await setup();
    const result = await runOnce(context, { workerId: "test-worker" });
    expect(result).toMatchObject({ processed: 0, failed: 0, idle: true });
  });

  it("retries a failed job with backoff and then dead-letters it", async () => {
    const { deps, storeId, context } = await setup({
      failOn: ["listProducts"],
    });
    const syncJobId = await createSyncJob(deps, {
      storeId,
      type: "PRODUCTS",
      triggeredBy: "test",
    });
    await enqueue(deps, {
      type: "SYNC_PRODUCTS",
      payload: { storeId, syncJobId },
      maxAttempts: 2,
    });

    const first = await runOnce(context, { workerId: "test-worker" });
    expect(first.failed).toBe(1);

    const [retry] = await db!.db.select().from(schema.jobs);
    expect(retry!.status).toBe("QUEUED");
    expect(retry!.attempts).toBe(1);
    expect(retry!.lastError).toContain("fixture failure");

    // Not due yet, so the worker does not pick it up early.
    const idle = await runOnce(context, { workerId: "test-worker" });
    expect(idle.idle).toBe(true);

    // Force the retry window to have passed, then exhaust the attempts.
    await db!.db
      .update(schema.jobs)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(schema.jobs.id, retry!.id));
    const second = await runOnce(context, { workerId: "test-worker" });
    expect(second.failed).toBe(1);

    const [dead] = await db!.db.select().from(schema.jobs);
    expect(dead!.status).toBe("DEAD");
    expect(dead!.attempts).toBe(2);

    const [syncJob] = await db!.db.select().from(schema.syncJobs);
    expect(syncJob!.status).toBe("FAILED");
    expect(syncJob!.error).toContain("fixture failure");

    const [store] = await db!.db.select().from(schema.shopeeStores);
    expect(store!.status).toBe("ERROR");
    expect(store!.lastError).toContain("product sync failed");
  });

  it("recovers a job left running by a crashed worker", async () => {
    const { deps } = await setup();
    await enqueue(deps, { type: "EXPIRE_CLAIMS", payload: {} });
    await db!.db
      .update(schema.jobs)
      .set({
        status: "RUNNING",
        lockedAt: new Date(Date.now() - 60 * 60_000),
        lockedBy: "dead-worker",
      })
      .where(eq(schema.jobs.status, "QUEUED"));

    const recovered = await recoverStuckJobs(deps, 15);
    expect(recovered).toBe(1);
    const [job] = await db!.db.select().from(schema.jobs);
    expect(job!.status).toBe("QUEUED");
    expect(job!.lastError).toContain("stale lock");
  });

  it("counts jobs by status for the monitoring page", async () => {
    const { deps } = await setup();
    await enqueue(deps, { type: "EXPIRE_CLAIMS", payload: {} });
    const stats = await queueStats(deps);
    expect(stats.queued).toBe(1);
    expect(stats.running).toBe(0);
    expect(stats.dead).toBe(0);
  });
});

describe("handlers", () => {
  it("processes an order and writes a claimable fulfilment once mapped", async () => {
    const { deps, storeId, context } = await setup();
    const [product] = await deps.db
      .insert(schema.shopeeProducts)
      .values({ storeId, itemId: 301, name: "Lisensi Aplikasi" })
      .returning();
    const [variation] = await deps.db
      .insert(schema.shopeeVariations)
      .values({ productId: product!.id, modelId: 4001, name: "1 Bulan" })
      .returning();
    const [digital] = await deps.db
      .insert(schema.digitalProducts)
      .values({
        name: "Lisensi 1 Bulan",
        slug: "lisensi-1-bulan",
        deliveryKind: "CODE",
        status: "ACTIVE",
      })
      .returning();
    await deps.db.insert(schema.productMappings).values({
      storeId,
      shopeeProductId: product!.id,
      shopeeVariationId: variation!.id,
      digitalProductId: digital!.id,
    });
    await deps.db
      .insert(schema.digitalProductCodes)
      .values({
        digitalProductId: digital!.id,
        secretEnc: encryptSecret("WRK-CODE-1", KEY),
        label: "***e-1",
      });

    const detail = await handleJob(
      context,
      {
        id: "job-1",
        type: "PROCESS_ORDER",
        payload: { storeId, orderSn: "260202WRK0001" },
      },
      { workerId: "w" },
    );
    expect(detail).toContain("FULFILLED");

    const [fulfillment] = await db!.db.select().from(schema.fulfillments);
    expect(fulfillment!.status).toBe("CLAIMABLE");
  });

  it("ships a claimed order in Shopee with the resi the platform assigned", async () => {
    const { deps, storeId, context } = await setup();
    // The order was delivered through the portal, so only Shopee's side is left.
    const [order] = await deps.db
      .insert(schema.orders)
      .values({
        storeId,
        orderSn: "260202WRK0001",
        state: "COMPLETED",
        shopeeStatus: "READY_TO_SHIP",
      })
      .returning();

    const detail = await handleJob(
      context,
      {
        id: "job-ship",
        type: "SHIP_ORDER",
        payload: {
          orderId: order!.id,
          trackingNumber: "DIGITAL-260202WRK0001",
        },
      },
      { workerId: "w" },
    );
    expect(detail).toContain("shipped");

    const [after] = await deps.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order!.id));
    expect(after!.shopeeStatus).toBe("SHIPPED");

    const events = await deps.db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order!.id));
    expect(
      events.find((event) => event.type === "SHIP_CONFIRMED")?.payload,
    ).toMatchObject({
      trackingNumber: "DIGITAL-260202WRK0001",
    });

    // A second run is a no-op, which is what makes retries safe.
    const again = await handleJob(
      context,
      {
        id: "job-ship-2",
        type: "SHIP_ORDER",
        payload: {
          orderId: order!.id,
          trackingNumber: "DIGITAL-260202WRK0001",
        },
      },
      { workerId: "w" },
    );
    expect(again).toContain("already shipped");
  });

  it("drains a sync job for a store that no longer exists instead of dead-lettering it", async () => {
    const { context } = await setup();
    const missing = "00000000-0000-4000-8000-000000000000";

    const product = await handleJob(
      context,
      {
        id: "job-missing-p",
        type: "SYNC_PRODUCTS",
        payload: { storeId: missing },
      },
      { workerId: "w" },
    );
    const orders = await handleJob(
      context,
      {
        id: "job-missing-o",
        type: "SYNC_ORDERS",
        payload: { storeId: missing },
      },
      { workerId: "w" },
    );

    expect(product).toContain("no longer exists");
    expect(orders).toContain("no longer exists");
  });

  it("succeeds instead of retrying when Shopee no longer returns the order", async () => {
    const { context, storeId } = await setup();
    const detail = await handleJob(
      context,
      {
        id: "job-2",
        type: "PROCESS_ORDER",
        payload: { storeId, orderSn: "UNKNOWN" },
      },
      { workerId: "w" },
    );
    expect(detail).toContain("not returned");
  });

  it("expires stale claim windows", async () => {
    const { context, storeId } = await setup();
    const [product] = await context.deps.db
      .insert(schema.shopeeProducts)
      .values({ storeId, itemId: 301, name: "X" })
      .returning();
    const [order] = await context.deps.db
      .insert(schema.orders)
      .values({ storeId, orderSn: "SN-EXP", state: "FULFILLED" })
      .returning();
    const [item] = await context.deps.db
      .insert(schema.orderItems)
      .values({
        orderId: order!.id,
        lineKey: "301:0",
        itemId: 301,
        itemName: "X",
      })
      .returning();
    const [digital] = await context.deps.db
      .insert(schema.digitalProducts)
      .values({ name: "D", slug: "d", deliveryKind: "CODE", status: "ACTIVE" })
      .returning();
    await context.deps.db.insert(schema.fulfillments).values({
      orderId: order!.id,
      orderItemId: item!.id,
      storeId,
      digitalProductId: digital!.id,
      status: "CLAIMABLE",
      claimDeadline: new Date(Date.now() - 3600_000),
    });
    expect(product).toBeTruthy();

    const detail = await handleJob(
      context,
      { id: "job-3", type: "EXPIRE_CLAIMS", payload: {} },
      { workerId: "w" },
    );
    expect(detail).toBe("fulfillments=1");
  });

  it("schedules maintenance once per interval without piling up jobs", async () => {
    const { context, deps } = await setup();
    await scheduleMaintenance(context, {
      productIntervalMinutes: 30,
      orderReconcileMinutes: 10,
    });
    await scheduleMaintenance(context, {
      productIntervalMinutes: 30,
      orderReconcileMinutes: 10,
    });

    const rows = await deps.db
      .select({ type: schema.jobs.type, total: sql<number>`count(*)` })
      .from(schema.jobs)
      .groupBy(schema.jobs.type);
    const byType = Object.fromEntries(
      rows.map((row) => [row.type, Number(row.total)]),
    );

    expect(byType.EXPIRE_CLAIMS).toBe(1);
    expect(byType.RECONCILE_STORES).toBe(1);
    expect(byType.REFRESH_TOKENS).toBe(1);
    expect(byType.SYNC_PRODUCTS).toBe(1);
    expect(byType.SYNC_ORDERS).toBe(1);
  });

  it("skips stores that are not connected when scheduling", async () => {
    const { context, deps } = await setup({ storeStatus: "ERROR" });
    await scheduleMaintenance(context, {
      productIntervalMinutes: 30,
      orderReconcileMinutes: 10,
    });

    const pending = await deps.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, "SYNC_PRODUCTS")));
    expect(pending).toHaveLength(0);
  });
});
