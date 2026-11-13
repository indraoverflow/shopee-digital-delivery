import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { encryptSecret } from "@qansa/core";
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

  it("hands the minted link to an operator and records that they looked", async () => {
    const fulfillment = await seedFulfillment();
    const owner = await h.login();
    const url = "https://e-meterai.co.id/pdfViewer?refid=abc123";
    await h.db.db
      .update(schema.fulfillments)
      .set({
        mintedSecretEnc: encryptSecret(url, h.config.service.appEncryptionKey),
        mintedAt: new Date(),
      })
      .where(eq(schema.fulfillments.id, fulfillment.id));

    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/fulfillments/${fulfillment.id}/minted-link`,
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, url });

    const audits = await h.db.db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, "meterai.reveal"),
          eq(schema.auditLogs.targetId, fulfillment.id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain("abc123"); // the link is the secret, not metadata
  });

  it("lets a read-only viewer resend the link, because resending is not spending", async () => {
    const fulfillment = await seedFulfillment();
    const viewer = await h.login("viewer@qansa.web.id", "viewer-password-2026");
    await h.db.db
      .update(schema.fulfillments)
      .set({
        mintedSecretEnc: encryptSecret(
          "https://e-meterai.co.id/pdfViewer?refid=v1",
          h.config.service.appEncryptionKey,
        ),
        mintedAt: new Date(),
      })
      .where(eq(schema.fulfillments.id, fulfillment.id));

    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/fulfillments/${fulfillment.id}/minted-link`,
      headers: { cookie: viewer.cookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it("says plainly when nothing was minted yet", async () => {
    const fulfillment = await seedFulfillment();
    const owner = await h.login();

    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/fulfillments/${fulfillment.id}/minted-link`,
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("METERAI_LINK_MISSING");
  });

  it("refuses to reveal a link for a product that is not e-Meterai", async () => {
    const fulfillment = await seedFulfillment(false);
    const owner = await h.login();
    await h.db.db
      .update(schema.fulfillments)
      .set({
        mintedSecretEnc: encryptSecret(
          "https://e-meterai.co.id/pdfViewer?refid=x",
          h.config.service.appEncryptionKey,
        ),
        mintedAt: new Date(),
      })
      .where(eq(schema.fulfillments.id, fulfillment.id));

    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/fulfillments/${fulfillment.id}/minted-link`,
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(422);
  });

  it("is closed to an anonymous caller", async () => {
    const fulfillment = await seedFulfillment();
    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/fulfillments/${fulfillment.id}/minted-link`,
    });
    expect(response.statusCode).toBe(401);
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
