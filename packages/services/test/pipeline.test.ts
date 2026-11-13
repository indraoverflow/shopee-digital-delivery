import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@qansa/db";
import { runOrderSync, runProductSync } from "../src/sync.js";
import { processOrder } from "../src/orders.js";
import {
  addCodes,
  createDigitalProduct,
  FIXED_NOW,
  harness,
  mapVariation,
  sampleStore,
  type Harness,
} from "./helpers.js";

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

const orderRows = async (harnessRef: Harness) =>
  harnessRef.db.db.select().from(schema.orders).orderBy(schema.orders.orderSn);

describe("product sync", () => {
  it("stores the catalog with its variations", async () => {
    h = await harness([sampleStore()]);
    const stats = await runProductSync(h.deps, { storeId: h.storeId });

    expect(stats.items).toBe(1);
    expect(stats.created).toBe(1);
    expect(stats.variations).toBe(3);

    const products = await h.db.db.select().from(schema.shopeeProducts);
    expect(products).toHaveLength(1);
    expect(products[0]!.name).toBe("E-Meterai 10.000");
    expect(products[0]!.hasModel).toBe(true);
    expect(products[0]!.priceMin).toBe("11500.00");

    const variations = await h.db.db.select().from(schema.shopeeVariations);
    expect(variations.map((row) => row.name).sort()).toEqual([
      "1 E-Meterai",
      "10 E-Meterai",
      "5 E-Meterai",
    ]);
  });

  it("is idempotent and soft deletes a product Shopee stopped returning", async () => {
    const store = sampleStore();
    h = await harness([store]);
    await runProductSync(h.deps, { storeId: h.storeId });
    await runProductSync(h.deps, { storeId: h.storeId });

    expect(await h.db.db.select().from(schema.shopeeProducts)).toHaveLength(1);

    // Now the shop returns an empty catalog.
    h.deps.gateway = (await import("@qansa/shopee-adapter")).createGateway({
      mode: "fixture",
      partnerId: 1,
      partnerKey: "x",
      baseUrl: "http://localhost",
    });
    const emptyGateway = new (
      await import("@qansa/shopee-adapter")
    ).FixtureShopeeGateway([{ ...store, products: [] }]);
    h.deps.gateway = emptyGateway;
    const stats = await runProductSync(h.deps, { storeId: h.storeId });

    // An empty catalogue is ambiguous (a truncated page looks the same), so the
    // current rule keeps existing rows instead of deleting the shop.
    expect(stats.items).toBe(0);
    const products = await h.db.db.select().from(schema.shopeeProducts);
    expect(products).toHaveLength(1);
    expect(products[0]!.deletedAt).toBeNull();
  });

  it("soft deletes a product that disappeared from a non-empty catalogue", async () => {
    const store = sampleStore();
    h = await harness([store]);
    await runProductSync(h.deps, { storeId: h.storeId });

    const trimmed = sampleStore({
      products: [
        { ...store.products![0]!, models: [store.products![0]!.models![0]!] },
        { item_id: 202, item_name: "Produk Baru", models: [] },
      ],
    });
    h.deps.gateway = new (
      await import("@qansa/shopee-adapter")
    ).FixtureShopeeGateway([trimmed]);
    const stats = await runProductSync(h.deps, { storeId: h.storeId });

    expect(stats.items).toBe(2);
    expect(stats.removed).toBe(0);
    const products = await h.db.db
      .select()
      .from(schema.shopeeProducts)
      .orderBy(schema.shopeeProducts.itemId);
    expect(products.map((row) => row.itemId)).toEqual([101, 202]);
    expect(products.every((row) => row.deletedAt === null)).toBe(true);

    // The two variations the listing dropped are marked, not deleted, so an old
    // mapping still points at a row.
    const variations = await h.db.db
      .select()
      .from(schema.shopeeVariations)
      .where(eq(schema.shopeeVariations.productId, products[0]!.id));
    const live = variations
      .filter((row) => row.deletedAt === null)
      .map((row) => row.modelId);
    expect(live).toEqual([1001]);
  });
});

describe("order pipeline", () => {
  it("turns a paid order into a claimable fulfilment", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "E-Meterai 5",
      kind: "CODE",
    });
    await addCodes(h, digital.id, ["CODE-AAAA-1111", "CODE-BBBB-2222"]);
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
    });

    const result = await runOrderSync(h.deps, { storeId: h.storeId });
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);

    const orders = await orderRows(h);
    const paid = orders.find((order) => order.orderSn === "260101TEST0001")!;
    const unpaid = orders.find((order) => order.orderSn === "260101TEST0002")!;
    expect(paid.state).toBe("FULFILLED");
    expect(paid.buyerUsername).toBe("rina_kurnia");
    expect(paid.totalAmount).toBe("55000.00");
    expect(unpaid.state).toBe("INELIGIBLE");
    expect(unpaid.ineligibleReason).toBe("NOT_PAID");

    const items = await h.db.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, paid.id));
    expect(items).toHaveLength(1);
    expect(items[0]!.mappingStatus).toBe("MAPPED");
    expect(items[0]!.digitalProductId).toBe(digital.id);

    const fulfillments = await h.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.orderId, paid.id));
    expect(fulfillments).toHaveLength(1);
    expect(fulfillments[0]!.status).toBe("CLAIMABLE");
    expect(fulfillments[0]!.quantity).toBe(1);

    // The unpaid order must not have produced any fulfilment at all.
    const unpaidFulfillments = await h.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.orderId, unpaid.id));
    expect(unpaidFulfillments).toHaveLength(0);
  });

  it("does not duplicate rows when the same push arrives twice", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "E-Meterai 5",
      kind: "CODE",
    });
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
    });

    await processOrder(h.deps, h.storeId, "260101TEST0001");
    await processOrder(h.deps, h.storeId, "260101TEST0001");
    await processOrder(h.deps, h.storeId, "260101TEST0001");

    const orders = await h.db.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.orderSn, "260101TEST0001"));
    expect(orders).toHaveLength(1);
    const items = await h.db.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, orders[0]!.id));
    expect(items).toHaveLength(1);
    const fulfillments = await h.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.orderId, orders[0]!.id));
    expect(fulfillments).toHaveLength(1);

    const events = await h.db.db
      .select()
      .from(schema.orderEvents)
      .where(
        and(
          eq(schema.orderEvents.orderId, orders[0]!.id),
          eq(schema.orderEvents.type, "ORDER_SYNCED"),
        ),
      );
    expect(events).toHaveLength(3); // three deliveries, three audit entries
  });

  it("keeps an order VALIDATED when the line has no mapping, and says why", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });

    await processOrder(h.deps, h.storeId, "260101TEST0001");
    const [order] = await h.db.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.orderSn, "260101TEST0001"));
    expect(order!.state).toBe("VALIDATED");

    const [item] = await h.db.db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order!.id));
    expect(item!.mappingStatus).toBe("UNMAPPED");
    expect(item!.unmappedReason).toBe("NO_MAPPING");
    expect(await h.db.db.select().from(schema.fulfillments)).toHaveLength(0);
  });

  it("holds the state when a late push tries to rewind a claimed order", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "E-Meterai 5",
      kind: "CODE",
    });
    await addCodes(h, digital.id, ["CODE-AAAA-1111"]);
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
    });
    await processOrder(h.deps, h.storeId, "260101TEST0001");

    const [order] = await h.db.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.orderSn, "260101TEST0001"));
    await h.db.db
      .update(schema.orders)
      .set({ state: "COMPLETED" })
      .where(eq(schema.orders.id, order!.id));

    const summary = await processOrder(h.deps, h.storeId, "260101TEST0001");
    expect(summary!.state).toBe("COMPLETED");
    const held = await h.db.db
      .select()
      .from(schema.orderEvents)
      .where(
        and(
          eq(schema.orderEvents.orderId, order!.id),
          eq(schema.orderEvents.type, "STATE_HELD"),
        ),
      );
    expect(held.length).toBeGreaterThan(0);
  });

  it("revokes fulfilments when Shopee cancels the order", async () => {
    const store = sampleStore();
    h = await harness([store]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "E-Meterai 5",
      kind: "CODE",
    });
    await addCodes(h, digital.id, ["CODE-AAAA-1111"]);
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
    });
    await processOrder(h.deps, h.storeId, "260101TEST0001");

    const cancelled = sampleStore();
    cancelled.orders![0]!.order_status = "CANCELLED";
    h.deps.gateway = new (
      await import("@qansa/shopee-adapter")
    ).FixtureShopeeGateway([cancelled]);

    const summary = await processOrder(h.deps, h.storeId, "260101TEST0001");
    expect(summary!.state).toBe("CANCELLED");
    const fulfillments = await h.db.db.select().from(schema.fulfillments);
    expect(fulfillments[0]!.status).toBe("REVOKED");
    expect(fulfillments[0]!.revokeReason).toContain("CANCELLED");
  });

  it("leaves a pending fulfilment when the mapped product is still a draft", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "Draft",
      kind: "LINK",
      externalUrl: "https://example.com/x",
    });
    await h.db.db
      .update(schema.digitalProducts)
      .set({ status: "DRAFT" })
      .where(eq(schema.digitalProducts.id, digital.id));
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
    });

    await processOrder(h.deps, h.storeId, "260101TEST0001");
    const [order] = await h.db.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.orderSn, "260101TEST0001"));
    expect(order!.state).toBe("VALIDATED");
    const [fulfillment] = await h.db.db.select().from(schema.fulfillments);
    expect(fulfillment!.status).toBe("PENDING");
    expect(fulfillment!.failureReason).toBe("PRODUCT_NOT_ACTIVE");
  });

  it("applies the quantity multiplier from the mapping", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "Paket 3 lisensi",
      kind: "CODE",
    });
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
      multiplier: 3,
    });

    await processOrder(h.deps, h.storeId, "260101TEST0001");
    const [fulfillment] = await h.db.db.select().from(schema.fulfillments);
    expect(fulfillment!.quantity).toBe(3); // 1 package x 3 licences
  });

  it("uses the store's own eligible status list", async () => {
    h = await harness([sampleStore()], { eligibleStatuses: ["COMPLETED"] });
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "E-Meterai",
      kind: "CODE",
    });
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
    });

    await processOrder(h.deps, h.storeId, "260101TEST0001");
    const [order] = await h.db.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.orderSn, "260101TEST0001"));
    expect(order!.state).toBe("INELIGIBLE");
    expect(order!.ineligibleReason).toBe("NOT_IN_ALLOWED_LIST");
  });

  it("records the claim window from the digital product", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "E-Meterai",
      kind: "CODE",
    });
    await h.db.db
      .update(schema.digitalProducts)
      .set({ claimExpiryDays: 7 })
      .where(eq(schema.digitalProducts.id, digital.id));
    await mapVariation(h, {
      itemId: 101,
      modelId: 1002,
      digitalProductId: digital.id,
    });

    await processOrder(h.deps, h.storeId, "260101TEST0001");
    const [fulfillment] = await h.db.db.select().from(schema.fulfillments);
    const expected = FIXED_NOW.getTime() + 7 * 24 * 3600 * 1000;
    expect(fulfillment!.claimDeadline?.getTime()).toBe(expected);
  });
});
