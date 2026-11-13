import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@qansa/db";
import {
  createClaimRequest,
  findApprovedWindow,
  listClaimRequests,
  pendingClaimRequestCount,
  reviewClaimRequest,
} from "../src/claim-requests.js";
import { verifyClaim } from "../src/claims.js";
import { runProductSync } from "../src/sync.js";
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

/**
 * A paid order on a store that demands the phone suffix, which is exactly the
 * situation manual verification exists for: Shopee masked the number to
 * "********2250" and the buyer may not know which digits are theirs.
 */
async function paidOrderOnPhoneStore() {
  h = await harness([sampleStore()], { verificationPolicy: "USERNAME_PHONE" });
  await runProductSync(h.deps, { storeId: h.storeId });

  const digital = await createDigitalProduct(h, {
    name: "Produk Manual",
    kind: "CODE",
  });
  await addCodes(h, digital.id, ["MANUAL-CODE-1"]);
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
  return { digital, order: order! };
}

describe("createClaimRequest", () => {
  it("accepts a request for a claimable order", async () => {
    const { order } = await paidOrderOnPhoneStore();

    const created = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "rina@example.com",
      note: "Nomor HP saya ganti",
      ip: "10.1.1.1",
    });

    expect(created.status).toBe("PENDING");
    expect(created.existing).toBe(false);

    const [row] = await h!.db.db
      .select()
      .from(schema.claimRequests)
      .where(eq(schema.claimRequests.id, created.id));
    expect(row!.contact).toBe("rina@example.com");
    expect(await pendingClaimRequestCount(h!.deps)).toBe(1);

    const events = await h!.db.db
      .select({ type: schema.orderEvents.type })
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order.id));
    expect(events.map((event) => event.type)).toContain("CLAIM_REQUESTED");
  });

  it("answers an unknown order and a wrong username identically", async () => {
    const { order } = await paidOrderOnPhoneStore();

    const unknown = await createClaimRequest(h!.deps, {
      orderSn: "260101NOPE9999",
      buyerUsername: "rina_kurnia",
      contact: "a@b.co",
    }).catch((error) => error);
    const wrongBuyer = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "orang_lain",
      contact: "a@b.co",
    }).catch((error) => error);

    expect(unknown).toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
    expect(wrongBuyer).toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
    expect(unknown.message).toBe(wrongBuyer.message);

    expect(await pendingClaimRequestCount(h!.deps)).toBe(0);
  });

  it("refuses an order that is not paid yet", async () => {
    h = await harness([sampleStore()], {
      verificationPolicy: "USERNAME_PHONE",
    });
    await runProductSync(h.deps, { storeId: h.storeId });
    await processOrder(h.deps, h.storeId, "260101TEST0002");

    await expect(
      createClaimRequest(h.deps, {
        orderSn: "260101TEST0002",
        buyerUsername: "belum_bayar",
        contact: "a@b.co",
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_ELIGIBLE" });
  });

  it("returns the existing request instead of creating a second one", async () => {
    const { order } = await paidOrderOnPhoneStore();
    const first = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "a@b.co",
    });
    const second = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "a@b.co",
    });

    expect(second.existing).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await pendingClaimRequestCount(h!.deps)).toBe(1);
  });
});

describe("manual approval", () => {
  it("lets the buyer claim with the username alone inside the window", async () => {
    const { order } = await paidOrderOnPhoneStore();

    // Without an approval, the phone policy fails closed.
    await expect(
      verifyClaim(h!.deps, {
        orderSn: order.orderSn,
        buyerUsername: "rina_kurnia",
        ip: "10.2.2.1",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^PHONE_/),
    });

    const created = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "rina@example.com",
    });
    const [reviewer] = await h!.db.db
      .insert(schema.users)
      .values({
        email: "ops@qansa.web.id",
        name: "Operator",
        role: "OPERATOR",
        passwordHash: "x",
      })
      .returning();

    const reviewed = await reviewClaimRequest(h!.deps, {
      requestId: created.id,
      decision: "APPROVED",
      note: "Sudah dicek di chat Shopee",
      actor: { id: reviewer!.id, email: reviewer!.email },
    });
    expect(reviewed.status).toBe("APPROVED");
    expect(reviewed.approvedUntil).toBeInstanceOf(Date);
    expect(await findApprovedWindow(h!.deps, order.id)).toBeInstanceOf(Date);

    const claim = await verifyClaim(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      ip: "10.2.2.2",
    });
    expect(claim.token).toBeTruthy();

    const [session] = await h!.db.db
      .select()
      .from(schema.claimSessions)
      .where(eq(schema.claimSessions.id, claim.sessionId));
    expect(session!.method).toBe("MANUAL");

    // The earlier failure is still on record; the approval adds a successful one.
    const attempts = await h!.db.db.select().from(schema.claimAttempts);
    expect(
      attempts
        .filter((attempt) => attempt.success)
        .map((attempt) => attempt.method),
    ).toEqual(["MANUAL"]);

    const events = await h!.db.db
      .select({ type: schema.orderEvents.type })
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, order.id));
    expect(events.map((event) => event.type)).toContain(
      "CLAIM_MANUALLY_APPROVED",
    );
  });

  it("stops working once the window closes", async () => {
    const { order } = await paidOrderOnPhoneStore();
    const created = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "rina@example.com",
    });
    const [reviewer] = await h!.db.db
      .insert(schema.users)
      .values({
        email: "ops-exp@qansa.web.id",
        name: "Op",
        role: "OPERATOR",
        passwordHash: "x",
      })
      .returning();

    await reviewClaimRequest(h!.deps, {
      requestId: created.id,
      decision: "APPROVED",
      hours: 1,
      actor: { id: reviewer!.id, email: reviewer!.email },
    });

    h!.setNow(new Date(FIXED_NOW.getTime() + 2 * 3600_000));
    expect(await findApprovedWindow(h!.deps, order.id)).toBeNull();
    await expect(
      verifyClaim(h!.deps, {
        orderSn: order.orderSn,
        buyerUsername: "rina_kurnia",
        ip: "10.3.3.3",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^PHONE_/),
    });
  });

  it("does not override a username mismatch", async () => {
    const { order } = await paidOrderOnPhoneStore();
    const created = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "rina@example.com",
    });
    const [reviewer] = await h!.db.db
      .insert(schema.users)
      .values({
        email: "ops2@qansa.web.id",
        name: "Op",
        role: "OPERATOR",
        passwordHash: "x",
      })
      .returning();

    await reviewClaimRequest(h!.deps, {
      requestId: created.id,
      decision: "APPROVED",
      actor: { id: reviewer!.id, email: reviewer!.email },
    });

    await expect(
      verifyClaim(h!.deps, {
        orderSn: order.orderSn,
        buyerUsername: "penyusup",
        ip: "10.4.4.4",
      }),
    ).rejects.toMatchObject({
      code: "USERNAME_MISMATCH",
    });
  });

  it("keeps the buyer out after a rejection", async () => {
    const { order } = await paidOrderOnPhoneStore();
    const created = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "rina@example.com",
    });
    const [reviewer] = await h!.db.db
      .insert(schema.users)
      .values({
        email: "ops3@qansa.web.id",
        name: "Op",
        role: "OPERATOR",
        passwordHash: "x",
      })
      .returning();

    const reviewed = await reviewClaimRequest(h!.deps, {
      requestId: created.id,
      decision: "REJECTED",
      note: "Bukan pemilik akun",
      actor: { id: reviewer!.id, email: reviewer!.email },
    });
    expect(reviewed.status).toBe("REJECTED");
    expect(reviewed.approvedUntil).toBeNull();
    expect(await findApprovedWindow(h!.deps, order.id)).toBeNull();
  });

  it("refuses to review the same request twice", async () => {
    const { order } = await paidOrderOnPhoneStore();
    const created = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "rina@example.com",
    });
    const [reviewer] = await h!.db.db
      .insert(schema.users)
      .values({
        email: "ops4@qansa.web.id",
        name: "Op",
        role: "OPERATOR",
        passwordHash: "x",
      })
      .returning();
    const actor = { id: reviewer!.id, email: reviewer!.email };

    await reviewClaimRequest(h!.deps, {
      requestId: created.id,
      decision: "APPROVED",
      actor,
    });
    await expect(
      reviewClaimRequest(h!.deps, {
        requestId: created.id,
        decision: "REJECTED",
        actor,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_REVIEWED" });
  });

  it("lists requests with order context and honours the status filter", async () => {
    const { order } = await paidOrderOnPhoneStore();
    const created = await createClaimRequest(h!.deps, {
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      contact: "rina@example.com",
    });
    const [reviewer] = await h!.db.db
      .insert(schema.users)
      .values({
        email: "ops5@qansa.web.id",
        name: "Op",
        role: "OPERATOR",
        passwordHash: "x",
      })
      .returning();

    const pending = await listClaimRequests(h!.deps, {
      status: "PENDING",
      page: 1,
      pageSize: 10,
    });
    expect(pending.total).toBe(1);
    expect(pending.data[0]).toMatchObject({
      orderSn: order.orderSn,
      buyerUsername: "rina_kurnia",
      storeLabel: "pixelbloomid",
    });

    await reviewClaimRequest(h!.deps, {
      requestId: created.id,
      decision: "APPROVED",
      actor: { id: reviewer!.id, email: reviewer!.email },
    });

    expect(
      (
        await listClaimRequests(h!.deps, {
          status: "PENDING",
          page: 1,
          pageSize: 10,
        })
      ).total,
    ).toBe(0);
    const approved = await listClaimRequests(h!.deps, {
      status: "APPROVED",
      page: 1,
      pageSize: 10,
    });
    expect(approved.total).toBe(1);
    expect(approved.data[0]!.reviewer).toBe("ops5@qansa.web.id");
  });
});
