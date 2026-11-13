import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@qansa/db";
import { apiHarness, type ApiHarness } from "./helpers.js";

/**
 * The mint route is the one an operator can press that spends money at the supplier,
 * so its guards are what matter: no permission, no credentials, no fulfilment.
 */

let h: ApiHarness;

beforeEach(async () => {
  h = await apiHarness();
});

afterEach(async () => {
  await h.close();
});

async function seedFulfillment(meteraiEnabled = true) {
  const [store] = await h.db.db
    .insert(schema.shopeeStores)
    .values({
      shopId: 771001,
      label: "meterai-store",
      status: "CONNECTED",
      environment: "SANDBOX",
    })
    .returning();
  const [product] = await h.db.db
    .insert(schema.digitalProducts)
    .values({
      name: "E-Meterai",
      slug: "e-meterai",
      deliveryKind: "INSTRUCTIONS",
      status: "ACTIVE",
      meteraiEnabled,
    })
    .returning();
  const [order] = await h.db.db
    .insert(schema.orders)
    .values({
      storeId: store!.id,
      orderSn: "260101MTR0001",
      state: "FULFILLED",
      shopeeStatus: "READY_TO_SHIP",
    })
    .returning();
  const [item] = await h.db.db
    .insert(schema.orderItems)
    .values({
      orderId: order!.id,
      lineKey: "101:0",
      itemId: 101,
      itemName: "E-Meterai",
    })
    .returning();
  const [fulfillment] = await h.db.db
    .insert(schema.fulfillments)
    .values({
      orderId: order!.id,
      orderItemId: item!.id,
      storeId: store!.id,
      digitalProductId: product!.id,
      status: "CLAIMABLE",
      quantity: 1,
    })
    .returning();
  return fulfillment!;
}

describe("POST /api/admin/fulfillments/:id/mint", () => {
  it("is closed to a viewer", async () => {
    const fulfillment = await seedFulfillment();
    const viewer = await h.login("viewer@qansa.web.id", "viewer-password-2026");

    const response = await h.app.inject({
      method: "POST",
      url: `/api/admin/fulfillments/${fulfillment.id}/mint`,
      headers: { cookie: viewer.cookie, "x-csrf-token": viewer.csrf },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses when the account is not configured, before spending anything", async () => {
    const fulfillment = await seedFulfillment();
    const owner = await h.login();

    const response = await h.app.inject({
      method: "POST",
      url: `/api/admin/fulfillments/${fulfillment.id}/mint`,
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("METERAI_DISABLED");
  });

  it("never leaks a stored minted secret through the order detail", async () => {
    const fulfillment = await seedFulfillment();
    const owner = await h.login();
    await h.db.db
      .update(schema.fulfillments)
      .set({
        mintedSecretEnc: "ciphertext-that-must-not-ship-to-the-browser",
        mintedAt: new Date(),
      })
      .where(eq(schema.fulfillments.id, fulfillment.id));

    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/orders/${fulfillment.orderId}`,
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("ciphertext-that-must-not-ship");
    expect(response.json().fulfillments[0]).toMatchObject({
      hasMintedLink: true,
      meteraiEnabled: true,
    });
  });
});
