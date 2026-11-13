import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@qansa/db";
import {
  accessDelivery,
  expireStaleFulfillments,
  getClaimSessionView,
  loadClaimSession,
  reissueFulfillment,
  resolveDownload,
  revokeClaim,
  verifyClaim,
} from "../src/claims.js";
import { runProductSync } from "../src/sync.js";
import { processOrder } from "../src/orders.js";
import {
  addCodes,
  createDigitalProduct,
  DOWNLOAD_SECRET,
  FIXED_NOW,
  harness,
  mapVariation,
  sampleStore,
  type Harness,
} from "./helpers.js";

let h: Harness | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** Overwrite one claim setting without disturbing the rest of the row. */
async function setClaimSettings(patchValue: Record<string, unknown>) {
  const [row] = await h!.db.db
    .select()
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, "claim"));
  const merged = {
    ...((row?.value as Record<string, unknown>) ?? {}),
    ...patchValue,
  };
  await h!.db.db
    .insert(schema.systemSettings)
    .values({ key: "claim", value: merged })
    .onConflictDoUpdate({
      target: schema.systemSettings.key,
      set: { value: merged },
    });
}

/** A paid order with one mapped product, ready to claim. */
async function paidOrder(
  options: {
    kind?: "CODE" | "LINK" | "FILE" | "CREDENTIALS" | "INSTRUCTIONS";
    maxDeliveries?: number;
    verificationPolicy?: "USERNAME" | "USERNAME_PHONE";
    maxAttemptsPerHour?: number;
    codes?: string[];
  } = {},
) {
  h = await harness([sampleStore()], {
    ...(options.verificationPolicy
      ? { verificationPolicy: options.verificationPolicy }
      : {}),
  });
  await runProductSync(h.deps, { storeId: h.storeId });

  // Seed explicit claim limits: the defaults allow more attempts and more
  // downloads than these tests want to exercise.
  await h.db.db.insert(schema.systemSettings).values({
    key: "claim",
    value: {
      maxAttemptsPerHour: options.maxAttemptsPerHour ?? 100,
      maxAttemptsPerOrder: 100,
      sessionMinutes: 30,
      downloadTtlMinutes: 10,
      maxDownloadsPerFulfillment: 2,
    },
  });

  const digital = await createDigitalProduct(h, {
    name: "Produk Uji",
    kind: options.kind ?? "CODE",
    externalUrl: "https://drive.example.com/file",
    ...(options.maxDeliveries !== undefined
      ? { maxDeliveries: options.maxDeliveries }
      : {}),
  });
  await addCodes(
    h,
    digital.id,
    options.codes ?? ["CODE-AAAA-1111", "CODE-BBBB-2222"],
  );
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
  const [fulfillment] = await h.db.db
    .select()
    .from(schema.fulfillments)
    .where(eq(schema.fulfillments.orderId, order!.id));
  return { digital: digital, order: order!, fulfillment: fulfillment! };
}

describe("verifyClaim", () => {
  it("rejects an unknown order number", async () => {
    h = await harness([sampleStore()]);
    await expect(
      verifyClaim(h.deps, {
        orderSn: "NOT-AN-ORDER",
        buyerUsername: "rina_kurnia",
        ip: "1.1.1.1",
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("rejects the right order number with the wrong buyer", async () => {
    await paidOrder();
    await expect(
      verifyClaim(h!.deps, {
        orderSn: "260101TEST0001",
        buyerUsername: "penyusup",
        ip: "1.1.1.1",
      }),
    ).rejects.toMatchObject({
      code: "USERNAME_MISMATCH",
      status: 400,
    });
    const attempts = await h!.db.db.select().from(schema.claimAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.success).toBe(false);
    expect(attempts[0]!.reason).toBe("USERNAME_MISMATCH");
  });

  it("accepts the buyer and issues a session scoped to that order", async () => {
    const { order } = await paidOrder();
    const verified = await verifyClaim(h!.deps, {
      orderSn: " 260101test0001 ",
      buyerUsername: "Rina_Kurnia",
      ip: "1.1.1.1",
    });

    expect(verified.orderSn).toBe("260101TEST0001");
    expect(verified.token.length).toBeGreaterThan(20);

    const session = await loadClaimSession(h!.deps, verified.token);
    expect(session?.order.id).toBe(order.id);
    // The raw token is never stored.
    const rows = await h!.db.db.select().from(schema.claimSessions);
    expect(rows[0]!.tokenHash).not.toBe(verified.token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });

  it("requires the phone suffix when the store policy asks for it", async () => {
    const { order } = await paidOrder({ verificationPolicy: "USERNAME_PHONE" });
    await expect(
      verifyClaim(h!.deps, {
        orderSn: order.orderSn,
        buyerUsername: "rina_kurnia",
        phoneSuffix: "0000",
        ip: "2.2.2.2",
      }),
    ).rejects.toMatchObject({
      code: "PHONE_SUFFIX_MISMATCH",
    });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      phoneSuffix: "2250",
      ip: "2.2.2.2",
    });
    expect(verified.token).toBeTruthy();
  });

  it("refuses an unpaid order even with the right buyer", async () => {
    h = await harness([sampleStore()]);
    await runProductSync(h.deps, { storeId: h.storeId });
    const digital = await createDigitalProduct(h, {
      name: "Produk",
      kind: "CODE",
    });
    await mapVariation(h, {
      itemId: 101,
      modelId: 1001,
      digitalProductId: digital.id,
    });
    await processOrder(h.deps, h.storeId, "260101TEST0002");

    await expect(
      verifyClaim(h.deps, {
        orderSn: "260101TEST0002",
        buyerUsername: "belum_bayar",
        ip: "3.3.3.3",
      }),
    ).rejects.toMatchObject({
      code: "ORDER_NOT_ELIGIBLE",
      status: 409,
    });
  });

  it("locks out an IP after too many failed attempts", async () => {
    await paidOrder({ maxAttemptsPerHour: 3 });
    for (let index = 0; index < 3; index += 1) {
      await expect(
        verifyClaim(h!.deps, {
          orderSn: "260101TEST0001",
          buyerUsername: "salah",
          ip: "9.9.9.9",
        }),
      ).rejects.toMatchObject({ code: "USERNAME_MISMATCH" });
    }
    await expect(
      verifyClaim(h!.deps, {
        orderSn: "260101TEST0001",
        buyerUsername: "rina_kurnia",
        ip: "9.9.9.9",
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
      status: 429,
    });
  });

  it("expires the session instead of extending it", async () => {
    const { order } = await paidOrder();
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      ip: "4.4.4.4",
    });
    h!.setNow(new Date(Date.now() + 31 * 60_000));
    expect(await loadClaimSession(h!.deps, verified.token)).toBeNull();
  });
});

describe("session view", () => {
  it("lists the item without leaking any secret", async () => {
    const { order } = await paidOrder({ codes: ["SECRET-CODE-9999"] });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    const view = await getClaimSessionView(h!.deps, verified.token);

    expect(view?.orderSn).toBe(order.orderSn);
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]!.productName).toBe("Produk Uji");
    expect(view?.items[0]!.status).toBe("CLAIMABLE");
    expect(JSON.stringify(view)).not.toContain("SECRET-CODE-9999");
    expect(view?.buyerUsernameMasked).toBe("rin******");
  });
});

describe("accessDelivery", () => {
  it("hands over an activation code and marks the order claimed", async () => {
    const { order, fulfillment } = await paidOrder({
      codes: ["CODE-AAAA-1111", "CODE-BBBB-2222"],
    });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });

    const payload = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
      ip: "5.5.5.5",
    });
    expect(payload.kind).toBe("CODE");
    if (payload.kind === "CODE") expect(payload.code).toBe("CODE-AAAA-1111");

    const [fulfil] = await h!.db.db.select().from(schema.fulfillments);
    expect(fulfil!.status).toBe("CLAIMED");
    const [reloaded] = await h!.db.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(reloaded!.state).toBe("COMPLETED");
    expect(await h!.db.db.select().from(schema.deliveryLogs)).toHaveLength(1);
  });

  it("queues the shipment for Shopee as soon as the buyer takes the product", async () => {
    const { order, fulfillment } = await paidOrder({
      codes: ["CODE-SHIP-1111"],
    });
    // This test is about the claim trigger; the default fires on payment instead.
    await setClaimSettings({ autoShipTrigger: "ON_CLAIM" });
    await h!.db.db.delete(schema.jobs);
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });

    await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });

    const jobs = await h!.db.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "SHIP_ORDER"));
    expect(jobs).toHaveLength(1);
    // Jasa kirim toko needs a resi, so the platform assigns one it can explain.
    expect(jobs[0]!.payload).toMatchObject({
      orderId: order.id,
      orderSn: order.orderSn,
      trackingNumber: `DIGITAL-${order.orderSn}`,
      reason: "claim",
    });
  });

  it("leaves shipping to the operator when auto-ship is off", async () => {
    const { order, fulfillment } = await paidOrder({
      codes: ["CODE-SHIP-2222"],
    });
    await setClaimSettings({ autoShipOnClaim: false });
    await h!.db.db.delete(schema.jobs);
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });

    await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });

    expect(
      await h!.db.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.type, "SHIP_ORDER")),
    ).toHaveLength(0);
  });

  it("shows the same code on a repeat visit instead of burning a second one", async () => {
    const { order, fulfillment } = await paidOrder({
      codes: ["CODE-ONE-1111", "CODE-TWO-2222"],
    });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });

    const first = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    const second = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    expect(first).toEqual(second);

    const codes = await h!.db.db.select().from(schema.digitalProductCodes);
    expect(codes.filter((row) => row.assignedClaimId !== null)).toHaveLength(1);
  });

  it("refuses a fulfilment that belongs to another order", async () => {
    const { order, fulfillment } = await paidOrder();
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });

    await expect(
      accessDelivery(h!.deps, {
        token: verified.token,
        fulfillmentId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(fulfillment.id).toBeTruthy();
  });

  it("fails when the code pool is empty instead of inventing a code", async () => {
    const { order, fulfillment } = await paidOrder({ codes: [] });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    await expect(
      accessDelivery(h!.deps, {
        token: verified.token,
        fulfillmentId: fulfillment.id,
      }),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
  });

  it("stops after the delivery limit", async () => {
    const { order, fulfillment } = await paidOrder({
      maxDeliveries: 1,
      codes: ["CODE-ONE-1111"],
    });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    await expect(
      accessDelivery(h!.deps, {
        token: verified.token,
        fulfillmentId: fulfillment.id,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_LIMIT" });
  });

  it("returns a link product and a credentials product", async () => {
    const { order, fulfillment } = await paidOrder({ kind: "LINK" });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    const link = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    expect(link).toMatchObject({
      kind: "LINK",
      url: "https://drive.example.com/file",
    });

    await h!.db.db
      .update(schema.digitalProducts)
      .set({ deliveryKind: "CREDENTIALS" })
      .where(
        eq(
          schema.digitalProducts.id,
          (await h!.db.db.select().from(schema.digitalProducts))[0]!.id,
        ),
      );

    const credentials = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    expect(credentials.kind).toBe("CREDENTIALS");
  });

  it("serves a file through a signed, expiring link with a download limit", async () => {
    const { order, fulfillment, digital } = await paidOrder({ kind: "FILE" });
    tempDir = await mkdtemp(join(tmpdir(), "qansa-assets-"));
    const fileName = "panduan.pdf";
    await writeFile(join(tempDir, fileName), Buffer.from("%PDF-1.4 test"));
    await h!.db.db.insert(schema.digitalProductAssets).values({
      digitalProductId: digital.id,
      storageKey: fileName,
      fileName,
      mimeType: "application/pdf",
      sizeBytes: 13,
      sha256: "x",
    });

    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    const payload = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    expect(payload.kind).toBe("FILE");
    if (payload.kind !== "FILE") return;

    expect(payload.url).toContain(
      "https://api.qansa.web.id/api/claim/download/",
    );
    expect(payload.url).not.toContain(tempDir);
    const token = payload.url.split("/").pop()!;

    const resolved = await resolveDownload(h!.deps, token, "6.6.6.6");
    expect(resolved.fileName).toBe(fileName);
    expect(resolved.mimeType).toBe("application/pdf");

    // Second download still allowed (limit 2 from the seeded settings).
    await resolveDownload(h!.deps, token, "6.6.6.6");
    await expect(
      resolveDownload(h!.deps, token, "6.6.6.6"),
    ).rejects.toMatchObject({ code: "DOWNLOAD_LIMIT" });
  });

  it("rejects a tampered download token", async () => {
    await paidOrder();
    await expect(resolveDownload(h!.deps, "abc.def")).rejects.toMatchObject({
      code: "LINK_INVALID",
    });
  });

  it("refuses every reveal once the claim is revoked", async () => {
    const { order, fulfillment } = await paidOrder();
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    const payload = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    expect(payload.kind).toBe("CODE");

    const [claim] = await h!.db.db.select().from(schema.claims);
    await revokeClaim(h!.deps, {
      claimId: claim!.id,
      reason: "chargeback",
      actorLabel: "admin@qansa.web.id",
    });

    const again = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    }).catch((error) => error);
    expect(again.code).toBe("ORDER_NOT_ELIGIBLE");
    await expect(
      accessDelivery(h!.deps, {
        token: verified.token,
        fulfillmentId: fulfillment.id,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_REVOKED" });
  });

  it("reissues a revoked fulfilment for another attempt", async () => {
    const { order, fulfillment } = await paidOrder({
      codes: ["CODE-ONE-1111", "CODE-TWO-2222"],
    });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });

    const [claim] = await h!.db.db.select().from(schema.claims);
    await revokeClaim(h!.deps, {
      claimId: claim!.id,
      reason: "salah kirim",
      actorLabel: "admin",
    });
    await reissueFulfillment(h!.deps, {
      fulfillmentId: fulfillment.id,
      reason: "kirim ulang",
      actorLabel: "admin",
    });

    const [reloaded] = await h!.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.id, fulfillment.id));
    expect(reloaded!.status).toBe("CLAIMABLE");

    const second = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    const payload = await accessDelivery(h!.deps, {
      token: second.token,
      fulfillmentId: fulfillment.id,
    });
    if (payload.kind === "CODE") expect(payload.code).toBe("CODE-TWO-2222");
  });

  it("expires a fulfilment whose deadline passed", async () => {
    const { order, fulfillment } = await paidOrder();
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });

    // A session that is still valid, on a fulfilment whose window closed.
    await h!.db.db
      .update(schema.fulfillments)
      .set({ claimDeadline: new Date(FIXED_NOW.getTime() - 60_000) })
      .where(eq(schema.fulfillments.id, fulfillment.id));

    await expect(
      accessDelivery(h!.deps, {
        token: verified.token,
        fulfillmentId: fulfillment.id,
      }),
    ).rejects.toMatchObject({
      code: "CLAIM_EXPIRED",
    });

    const expired = await expireStaleFulfillments(h!.deps);
    expect(expired.fulfillments).toBe(0); // already flipped by the access attempt
    const [reloaded] = await h!.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.id, fulfillment.id));
    expect(reloaded!.status).toBe("EXPIRED");
  });

  it("expires every stale fulfilment in one sweep", async () => {
    const { order } = await paidOrder();
    await h!.db.db
      .update(schema.fulfillments)
      .set({ claimDeadline: new Date(FIXED_NOW.getTime() - 60_000) })
      .where(eq(schema.fulfillments.orderId, order.id));

    const expired = await expireStaleFulfillments(h!.deps);
    expect(expired.fulfillments).toBe(1);
    expect(expired.orders).toBe(1);
    const [reloaded] = await h!.db.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(reloaded!.state).toBe("EXPIRED");
  });

  it("writes an audit row for an administrative revoke", async () => {
    const { order, fulfillment } = await paidOrder();
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });

    const [claim] = await h!.db.db.select().from(schema.claims);
    await revokeClaim(h!.deps, {
      claimId: claim!.id,
      reason: "uji",
      actorLabel: "admin@qansa.web.id",
      ip: "7.7.7.7",
    });

    const [audit] = await h!.db.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "claim.revoke"));
    expect(audit!.actorLabel).toBe("admin@qansa.web.id");
    expect(audit!.targetId).toBe(claim!.id);
  });
});

describe("claim session isolation", () => {
  it("cannot reveal a fulfilment from a different order", async () => {
    const { order } = await paidOrder();
    h!.deps.gateway = new (
      await import("@qansa/shopee-adapter")
    ).FixtureShopeeGateway([
      sampleStore({
        orders: [
          ...sampleStore().orders!,
          {
            order_sn: "260101TEST0003",
            order_status: "READY_TO_SHIP",
            buyer_username: "rina_kurnia",
            recipient_phone: "********2250",
            create_time: 1,
            update_time: 2,
            items: [
              {
                item_id: 101,
                model_id: 1002,
                item_name: "E-Meterai 10.000",
                model_name: "5 E-Meterai",
                quantity: 1,
              },
            ],
          },
        ],
      }),
    ]);
    await processOrder(h!.deps, h.storeId, "260101TEST0003");

    const [other] = await h!.db.db
      .select()
      .from(schema.fulfillments)
      .where(
        and(
          eq(
            schema.fulfillments.orderId,
            (
              await h!.db.db
                .select()
                .from(schema.orders)
                .where(eq(schema.orders.orderSn, "260101TEST0003"))
            )[0]!.id,
          ),
        ),
      );

    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    await expect(
      accessDelivery(h!.deps, {
        token: verified.token,
        fulfillmentId: other!.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("download signing secret", () => {
  it("does not accept a token signed with another secret", async () => {
    const { order, fulfillment, digital } = await paidOrder({ kind: "FILE" });
    await h!.db.db.insert(schema.digitalProductAssets).values({
      digitalProductId: digital.id,
      storageKey: "a.pdf",
      fileName: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "y",
    });
    const verified = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
    });
    const payload = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });
    if (payload.kind !== "FILE") throw new Error("expected a file payload");

    const token = payload.url.split("/").pop()!;
    expect(DOWNLOAD_SECRET).toBe(h!.deps.config.downloadSigningSecret);
    const [, signature] = token.split(".");
    await expect(
      resolveDownload(h!.deps, `${token.split(".")[0]}.${signature}x`),
    ).rejects.toBeTruthy();
  });
});
