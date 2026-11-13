import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@qansa/db";
import { processOrder } from "../src/orders.js";
import { runProductSync } from "../src/sync.js";
import { markShipped } from "../src/shipping.js";
import { addCodes, createDigitalProduct, harness, mapVariation, sampleStore, type Harness } from "./helpers.js";

/**
 * The one deliberate write back to Shopee. It is an operator action, so the tests
 * care about the refusal paths as much as the happy one: an order that was not
 * delivered yet must not be shipped, and a gateway that cannot ship must say so
 * instead of reporting success.
 */

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

const actor = { id: "11111111-1111-1111-1111-111111111111", email: "ops@qansa.web.id" };
/** Fixtures ship with "jasa kirim toko", a non-integrated channel, so a resi is required. */
const resi = "DIGITAL-260101TEST0001";

async function claimableOrder() {
  h = await harness([sampleStore()]);
  await runProductSync(h.deps, { storeId: h.storeId });
  const digital = await createDigitalProduct(h, { name: "Produk Kirim", kind: "CODE" });
  await addCodes(h, digital.id, ["SHIP-CODE-1"]);
  await mapVariation(h, { itemId: 101, modelId: 1002, digitalProductId: digital.id });
  await processOrder(h.deps, h.storeId, "260101TEST0001");

  const [order] = await h.db.db.select().from(schema.orders).where(eq(schema.orders.orderSn, "260101TEST0001"));
  return order!;
}

describe("markShipped", () => {
  it("arranges shipment and records it on the order and the audit trail", async () => {
    const order = await claimableOrder();
    expect(order.shopeeStatus).toBe("READY_TO_SHIP");

    const result = await markShipped(h!.deps, { orderId: order.id, trackingNumber: resi, actor, ip: "10.0.0.5" });

    expect(result).toMatchObject({ orderSn: order.orderSn, shopeeStatus: "SHIPPED", alreadyShipped: false });
    expect(result.packageNumber).toBe(`FIXTURE-${order.orderSn}`);
    expect(result.trackingNumber).toBe(resi);

    const [after] = await h!.db.db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(after!.shopeeStatus).toBe("SHIPPED");

    const events = await h!.db.db.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, order.id));
    expect(events.map((event) => event.type)).toContain("SHIP_CONFIRMED");
    expect(events.find((event) => event.type === "SHIP_CONFIRMED")?.payload).toMatchObject({ trackingNumber: resi });

    const audit = await h!.db.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "order.ship"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ orderSn: order.orderSn, mode: "fixture" });
  });

  it("is idempotent: a second call reports it was already shipped and writes nothing", async () => {
    const order = await claimableOrder();
    await markShipped(h!.deps, { orderId: order.id, trackingNumber: resi, actor });

    const second = await markShipped(h!.deps, { orderId: order.id, trackingNumber: resi, actor });
    expect(second.alreadyShipped).toBe(true);
    expect(second.shopeeStatus).toBe("SHIPPED");

    const events = await h!.db.db.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, order.id));
    expect(events.filter((event) => event.type === "SHIP_CONFIRMED")).toHaveLength(1);
  });

  it("keeps the operator's shipment when a later read still says unshipped", async () => {
    const order = await claimableOrder();
    await markShipped(h!.deps, { orderId: order.id, trackingNumber: resi, actor });

    // A fresh gateway starts from the original fixture data, which still says
    // READY_TO_SHIP, exactly like a stale or lagging read from Shopee.
    const fixtures = await import("@qansa/shopee-adapter");
    h!.deps.gateway = new fixtures.FixtureShopeeGateway([sampleStore()]);
    await processOrder(h!.deps, h!.storeId, order.orderSn);

    const [after] = await h!.db.db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(after!.shopeeStatus).toBe("SHIPPED");

    const events = await h!.db.db.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, order.id));
    const discrepancy = events.find((event) => event.type === "SHIP_STATUS_DISCREPANCY");
    expect(discrepancy?.payload).toMatchObject({ reported: "READY_TO_SHIP", kept: "SHIPPED" });
  });

  it("asks for the resi a jasa kirim toko order needs, before calling Shopee", async () => {
    const order = await claimableOrder();

    await expect(markShipped(h!.deps, { orderId: order.id, actor })).rejects.toMatchObject({
      code: "TRACKING_NUMBER_REQUIRED",
      status: 422,
    });

    // Nothing was shipped, so the alert stays and the order is still shippable.
    const [unchanged] = await h!.db.db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(unchanged!.shopeeStatus).toBe("READY_TO_SHIP");

    const shipped = await markShipped(h!.deps, { orderId: order.id, trackingNumber: "DIGITAL-RESI-1", actor });
    expect(shipped.trackingNumber).toBe("DIGITAL-RESI-1");
  });

  it("refuses an order that was not delivered to the buyer yet", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    // 260101TEST0001 is paid but unmapped here, so it never becomes claimable.
    await processOrder(h.deps, h.storeId, "260101TEST0001");

    const [order] = await h.db.db.select().from(schema.orders).where(eq(schema.orders.orderSn, "260101TEST0001"));
    expect(order!.state).not.toBe("FULFILLED");

    await expect(markShipped(h.deps, { orderId: order!.id, actor })).rejects.toMatchObject({ code: "ORDER_NOT_READY" });
  });

  it("refuses when the active gateway cannot ship at all", async () => {
    const order = await claimableOrder();
    const { shipOrder: _omitted, ...rest } = h!.deps.gateway as unknown as Record<string, unknown>;
    void _omitted;

    await expect(
      markShipped({ ...h!.deps, gateway: rest as never }, { orderId: order.id, trackingNumber: resi, actor }),
    ).rejects.toMatchObject({
      code: "SHIP_NOT_SUPPORTED",
      status: 501,
    });
  });

  it("surfaces a Shopee refusal instead of pretending success", async () => {
    h = await harness([sampleStore()], {});
    // Rebuild the gateway with shipping forced to fail.
    const fixtures = await import("@qansa/shopee-adapter");
    h.deps.gateway = new fixtures.FixtureShopeeGateway([sampleStore()], { failOn: ["shipOrder"] });

    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, { name: "Produk Gagal Kirim", kind: "CODE" });
    await addCodes(h, digital.id, ["SHIP-CODE-2"]);
    await mapVariation(h, { itemId: 101, modelId: 1002, digitalProductId: digital.id });
    await processOrder(h.deps, h.storeId, "260101TEST0001");
    const [order] = await h.db.db.select().from(schema.orders).where(eq(schema.orders.orderSn, "260101TEST0001"));

    await expect(markShipped(h.deps, { orderId: order!.id, trackingNumber: resi, actor })).rejects.toMatchObject({
      code: "SHIP_FAILED",
      status: 502,
    });

    const [unchanged] = await h.db.db.select().from(schema.orders).where(eq(schema.orders.id, order!.id));
    expect(unchanged!.shopeeStatus).toBe("READY_TO_SHIP");
  });
});
