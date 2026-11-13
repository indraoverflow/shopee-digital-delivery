import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@qansa/db";
import { apiHarness, type ApiHarness } from "./helpers.js";

/**
 * A digital order is delivered through the portal, but Shopee still expects the
 * seller to ship it. Nothing in this platform ships on the seller's behalf, so an
 * order that stays READY_TO_SHIP is on its way to an automatic cancellation and a
 * refund of an already delivered product. Monitoring has to say so out loud.
 */

let h: ApiHarness;
let session: { cookie: string; csrf: string };

beforeEach(async () => {
  h = await apiHarness();
  session = await h.login();
});

afterEach(async () => {
  await h.close();
});

const admin = (method: "GET" | "POST", url: string) =>
  h.app.inject({ method, url, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } });

async function seedOrder(state: "VALIDATED" | "FULFILLED" | "CLAIMED" | "COMPLETED", shopeeStatus: string) {
  const [store] = await h.db.db
    .insert(schema.shopeeStores)
    .values({ shopId: 771001, label: "pixelbloomid", status: "CONNECTED", environment: "SANDBOX" })
    .returning();
  const [order] = await h.db.db
    .insert(schema.orders)
    .values({
      storeId: store!.id,
      orderSn: `260101TEST${Math.floor(Math.random() * 9000) + 1000}`,
      shopeeStatus,
      state,
      buyerUsername: "rina_kurnia",
      currency: "IDR",
      totalAmount: "55000",
    })
    .returning();
  return order!;
}

describe("monitoring: awaiting shipment", () => {
  it("reports nothing when there is nothing waiting", async () => {
    const response = await admin("GET", "/api/admin/monitoring");
    expect(response.statusCode).toBe(200);
    expect(response.json().shipping).toEqual({ awaitingShipment: 0, oldestHours: null, sample: [] });
    expect(response.json().alerts.some((alert: { code: string }) => alert.code === "AWAITING_SHIPMENT")).toBe(false);
  });

  it("counts a claimed order that Shopee still shows as ready to ship", async () => {
    await seedOrder("CLAIMED", "READY_TO_SHIP");

    const response = await admin("GET", "/api/admin/monitoring");
    const body = response.json();

    expect(body.shipping.awaitingShipment).toBe(1);
    expect(body.shipping.sample[0]).toMatchObject({ state: "CLAIMED", shopeeStatus: "READY_TO_SHIP", storeLabel: "pixelbloomid" });
    expect(body.alerts.map((alert: { code: string }) => alert.code)).toContain("AWAITING_SHIPMENT");
  });

  it("stops counting once Shopee reports the order shipped", async () => {
    const order = await seedOrder("COMPLETED", "READY_TO_SHIP");
    expect((await admin("GET", "/api/admin/monitoring")).json().shipping.awaitingShipment).toBe(1);

    await h.db.db.update(schema.orders).set({ shopeeStatus: "SHIPPED" }).where(eq(schema.orders.id, order.id));

    expect((await admin("GET", "/api/admin/monitoring")).json().shipping.awaitingShipment).toBe(0);
  });

  it("ignores an order that has not been delivered yet", async () => {
    await seedOrder("VALIDATED", "READY_TO_SHIP");
    expect((await admin("GET", "/api/admin/monitoring")).json().shipping.awaitingShipment).toBe(0);
  });
});
