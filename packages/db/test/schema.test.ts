import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, schema, type TestDatabase } from "../src/index.js";

let handle: TestDatabase;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await handle.close();
});

const newStore = async (shopId: number) => {
  const [store] = await handle.db
    .insert(schema.shopeeStores)
    .values({ shopId, label: `store-${shopId}`, status: "CONNECTED", environment: "SANDBOX" })
    .returning();
  return store!;
};

const newDigitalProduct = async () => {
  const [product] = await handle.db
    .insert(schema.digitalProducts)
    .values({ name: "E-Meterai 1", slug: `meterai-${Math.random().toString(36).slice(2, 8)}`, deliveryKind: "CODE", status: "ACTIVE" })
    .returning();
  return product!;
};

describe("migrations", () => {
  it("applies every table from the real migration files", async () => {
    const rows = (await handle.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    )) as Array<{ table_name: string }>;
    const names = rows.map((row) => row.table_name);
    for (const expected of ["orders", "order_items", "fulfillments", "claims", "shopee_stores", "product_mappings", "jobs", "webhook_events", "audit_logs"]) {
      expect(names).toContain(expected);
    }
  });

  it("keeps money as numeric and timestamps with a timezone", async () => {
    const store = await newStore(9001);
    const [order] = await handle.db
      .insert(schema.orders)
      .values({ storeId: store.id, orderSn: "SN-TYPES", totalAmount: "55000.00", state: "RECEIVED" })
      .returning();
    expect(order!.totalAmount).toBe("55000.00");
    expect(order!.createdAt).toBeInstanceOf(Date);
  });

  it("refuses a duplicate order number inside one store but allows it in another", async () => {
    const first = await newStore(9002);
    const second = await newStore(9003);
    await handle.db.insert(schema.orders).values({ storeId: first.id, orderSn: "SN-DUP" });

    await expect(handle.db.insert(schema.orders).values({ storeId: first.id, orderSn: "SN-DUP" })).rejects.toThrow();
    await expect(handle.db.insert(schema.orders).values({ storeId: second.id, orderSn: "SN-DUP" })).resolves.toBeDefined();
  });

  it("refuses a duplicate shop id in the same environment", async () => {
    await newStore(9004);
    await expect(newStore(9004)).rejects.toThrow();
  });

  it("allows one listing-level mapping and one mapping per variation", async () => {
    const store = await newStore(9005);
    const digital = await newDigitalProduct();
    const [product] = await handle.db
      .insert(schema.shopeeProducts)
      .values({ storeId: store.id, itemId: 501, name: "Listing" })
      .returning();
    const [variation] = await handle.db
      .insert(schema.shopeeVariations)
      .values({ productId: product!.id, modelId: 7001, name: "1 pcs" })
      .returning();

    const base = { storeId: store.id, shopeeProductId: product!.id, digitalProductId: digital.id };
    await handle.db.insert(schema.productMappings).values({ ...base, shopeeVariationId: null });
    await handle.db.insert(schema.productMappings).values({ ...base, shopeeVariationId: variation!.id });

    await expect(handle.db.insert(schema.productMappings).values({ ...base, shopeeVariationId: null })).rejects.toThrow();
    await expect(handle.db.insert(schema.productMappings).values({ ...base, shopeeVariationId: variation!.id })).rejects.toThrow();
  });

  it("deduplicates webhook bodies and pending job keys", async () => {
    const hash = "a".repeat(64);
    await handle.db.insert(schema.webhookEvents).values({ bodyHash: hash, signatureValid: true, code: 3 });
    await expect(handle.db.insert(schema.webhookEvents).values({ bodyHash: hash, signatureValid: true, code: 3 })).rejects.toThrow();

    await handle.db.insert(schema.jobs).values({ type: "PROCESS_ORDER", payload: { orderSn: "A" }, dedupeKey: "order:A" });
    await expect(handle.db.insert(schema.jobs).values({ type: "PROCESS_ORDER", payload: { orderSn: "A" }, dedupeKey: "order:A" })).rejects.toThrow();
  });

  it("cascades an order delete to its items and events", async () => {
    const store = await newStore(9006);
    const [order] = await handle.db.insert(schema.orders).values({ storeId: store.id, orderSn: "SN-CASCADE" }).returning();
    await handle.db.insert(schema.orderItems).values({ orderId: order!.id, lineKey: "1:0", itemId: 1, itemName: "X" });
    await handle.db.insert(schema.orderEvents).values({ orderId: order!.id, type: "SYNCED" });

    await handle.db.delete(schema.orders).where(eq(schema.orders.id, order!.id));

    const items = await handle.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order!.id));
    const events = await handle.db.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, order!.id));
    expect(items).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
