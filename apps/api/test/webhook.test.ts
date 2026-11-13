import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@qansa/db";
import { apiHarness, PARTNER_KEY, PUSH_URL, pushBody, signPush, type ApiHarness } from "./helpers.js";

/**
 * The push receiver is the one endpoint exposed to the internet with no session,
 * so its order of checks matters: signature first, duplicate second. Getting that
 * backwards answered a replayed forged body with "duplicate", which confirms to
 * the sender that the payload had been seen.
 */

let h: ApiHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** The receiver only queues a push for a store that exists in this environment. */
async function seedStore(shopId = 771001) {
  await h!.db.db
    .insert(schema.shopeeStores)
    .values({ shopId, label: `pixelbloomid-${shopId}`, shopName: "pixelbloomid", status: "CONNECTED", environment: "SANDBOX" })
    .returning();
}

const push = (body: string, signature = signPush(body)) =>
  h!.app.inject({
    method: "POST",
    url: "/webhook/shopee",
    headers: { "content-type": "application/json", authorization: signature },
    payload: body,
  });

describe("push receiver", () => {
  it("accepts a correctly signed push and queues the order", async () => {
    h = await apiHarness();
    await seedStore();
    const response = await push(pushBody("260101PXL0001"));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, queued: true });

    const events = await h.db.db.select().from(schema.webhookEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ signatureValid: true, status: "PROCESSED", orderSn: "260101PXL0001" });
  });

  it("acknowledges a retry without storing or queueing it twice", async () => {
    h = await apiHarness();
    const body = pushBody("260101PXL0001");
    await push(body);
    const retry = await push(body);

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ok: true, duplicate: true });

    const events = await h.db.db.select().from(schema.webhookEvents);
    expect(events).toHaveLength(1);
  });

  it("rejects a forged body with 401 and records it once", async () => {
    h = await apiHarness();
    const body = pushBody("260101PXL0009");
    const response = await push(body, "0".repeat(64));

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid push signature" });

    const events = await h.db.db.select().from(schema.webhookEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ signatureValid: false, status: "FAILED" });
  });

  it("still answers 401 when the same forged body is replayed", async () => {
    h = await apiHarness();
    const body = pushBody("260101PXL0009");
    await push(body, "0".repeat(64));
    const replay = await push(body, "0".repeat(64));

    // The bug this covers: the duplicate guard ran before the signature check, so
    // a replay leaked `duplicate: true` instead of refusing.
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "invalid push signature" });
  });

  it("still processes the genuine push after the same body was rejected once", async () => {
    h = await apiHarness();
    await seedStore();
    const body = pushBody("260101PXL0001");

    expect((await push(body, "3".repeat(64))).statusCode).toBe(401);
    const genuine = await push(body);

    expect(genuine.statusCode).toBe(200);
    expect(genuine.json()).toEqual({ ok: true, queued: true });

    const events = await h.db.db.select().from(schema.webhookEvents);
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.signatureValid)).toHaveLength(1);
  });

  it("rejects a valid body signed with the wrong partner key", async () => {
    h = await apiHarness();
    const body = pushBody("260101PXL0001");
    const response = await push(body, signPush(body, "not-the-partner-key"));

    expect(response.statusCode).toBe(401);
  });

  it("rejects a body signed for a different URL", async () => {
    h = await apiHarness();
    const body = pushBody("260101PXL0001");
    const other = signPush(body).replace(/^./, (character) => (character === "a" ? "b" : "a"));
    expect(other).not.toBe(signPush(body));
    expect((await push(body, other)).statusCode).toBe(401);
  });

  it("refuses every push in production when SHOPEE_PUSH_URL is unset", async () => {
    h = await apiHarness({ NODE_ENV: "production", SHOPEE_PUSH_URL: undefined, SESSION_COOKIE_SECURE: "true" });
    const body = pushBody("260101PXL0001");
    const response = await push(body);

    // Cannot verify any signature, so it fails closed instead of trusting callers.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "push endpoint is not configured" });

    const events = await h.db.db.select().from(schema.webhookEvents);
    expect(events).toHaveLength(0);
  });

  it("accepts an unsigned push outside production, marking it unverified", async () => {
    h = await apiHarness({ SHOPEE_PUSH_URL: undefined, NODE_ENV: "test" });
    await seedStore();
    const response = await push(pushBody("260101PXL0001"), "");

    expect(response.statusCode).toBe(200);
    const [event] = await h.db.db.select().from(schema.webhookEvents);
    expect(event).toMatchObject({ signatureValid: true, status: "PROCESSED" });
    expect(PARTNER_KEY).toBe("fixture-partner-key");
    expect(PUSH_URL).toContain("/webhook/shopee");
  });

  it("ignores a push for a shop that is not registered", async () => {
    h = await apiHarness();
    const body = pushBody("260101PXL0001", 999002);
    const response = await push(body);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ignored: true });

    const [event] = await h.db.db.select().from(schema.webhookEvents);
    expect(event?.status).toBe("IGNORED");
    expect(event?.error).toContain("no store registered");
    expect(await h.db.db.select().from(schema.jobs)).toHaveLength(0);
  });
});
