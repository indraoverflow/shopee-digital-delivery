import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@qansa/db";
import { apiHarness, type ApiHarness } from "./helpers.js";

/**
 * Monitoring is the screen an operator actually trusts, so its thresholds matter
 * more than its data. One rejected push is what a port scanner and the preflight
 * probe produce; a burst means the shared secret is wrong or someone is probing on
 * purpose, and only the burst is worth waking up for.
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

async function monitoring() {
  const response = await h.app.inject({
    method: "GET",
    url: "/api/admin/monitoring",
    headers: { cookie: session.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function seedRejectedPush(count: number, receivedAt = new Date()) {
  await h.db.db.insert(schema.webhookEvents).values(
    Array.from({ length: count }, (_, index) => ({
      code: index % 2 === 0 ? 4 : 9,
      shopId: 771001,
      signatureValid: false,
      bodyHash: `rejected-${index}`,
      error: "invalid signature",
      receivedAt,
    })),
  );
}

describe("monitoring thresholds", () => {
  it("stays quiet on a single rejected push", async () => {
    await seedRejectedPush(1);
    const body = await monitoring();
    expect(
      body.alerts.map((alert: { code: string }) => alert.code),
    ).not.toContain("WEBHOOK_SIGNATURE");
  });

  it("ignores yesterday's probes, however many there were", async () => {
    // A week of preflight runs must never look like an attack.
    await seedRejectedPush(20, new Date(Date.now() - 3 * 3_600_000));
    const body = await monitoring();
    expect(
      body.alerts.map((alert: { code: string }) => alert.code),
    ).not.toContain("WEBHOOK_SIGNATURE");
  });

  it("raises the alarm on a burst of rejected pushes, and says how many", async () => {
    await seedRejectedPush(4);
    const body = await monitoring();
    const alert = body.alerts.find(
      (entry: { code: string }) => entry.code === "WEBHOOK_SIGNATURE",
    );
    expect(alert?.level).toBe("critical");
    expect(alert?.message).toContain("4");
  });

  it("reports nothing to ship when no order is waiting", async () => {
    const body = await monitoring();
    expect(body.shipping).toMatchObject({ awaitingShipment: 0, sample: [] });
  });
});
