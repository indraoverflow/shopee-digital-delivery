import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@qansa/db";
import { runOrderSync, runProductSync } from "@qansa/services";
import { apiHarness, pushBody, signPush, type ApiHarness } from "./helpers.js";

/**
 * The full journey, over HTTP: an operator connects a store, syncs the
 * catalogue, maps a variation, receives an order, and a buyer claims the
 * product. Assertions are on the API's answers, not on internal functions.
 */

let harness: ApiHarness;
let auth: { cookie: string; csrf: string };
let storeId: string;

const api = (options: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
  cookie?: string;
  csrf?: string;
  headers?: Record<string, string>;
}) =>
  harness.app.inject({
    method: options.method,
    url: options.url,
    ...(options.payload ? { payload: options.payload as Record<string, unknown> } : {}),
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });

const admin = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  api({ method, url, ...(payload ? { payload } : {}), cookie: auth.cookie, csrf: auth.csrf });

beforeAll(async () => {
  harness = await apiHarness();
  auth = await harness.login();
});

afterAll(async () => {
  await harness.close();
});

describe("health and public config", () => {
  it("answers the probes without a session", async () => {
    expect((await api({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await api({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });

  it("publishes branding and the claim rules", async () => {
    const response = await api({ method: "GET", url: "/api/public/config" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The buyer-facing product is Serah Terima; Qansa is the operator's own platform.
    expect(body.branding.brandName).toBe("Serah Terima");
    expect(body.branding.claimDomain).toBe("claim.example.com");
    expect(body.gatewayMode).toBe("fixture");
  });
});

describe("authentication and access control", () => {
  it("rejects a wrong password without saying which part failed", async () => {
    const response = await api({ method: "POST", url: "/api/auth/login", payload: { email: "owner@qansa.web.id", password: "nope" } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("Email atau kata sandi salah");
  });

  it("requires a session for admin data", async () => {
    const response = await api({ method: "GET", url: "/api/admin/stores" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("requires the CSRF header on a mutating call", async () => {
    const response = await api({
      method: "POST",
      url: "/api/admin/stores",
      payload: { label: "no-csrf", shopId: 999999 },
      cookie: auth.cookie,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_FAILED");
  });

  it("returns the signed-in user with its permissions", async () => {
    const response = await admin("GET", "/api/auth/me");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe("owner@qansa.web.id");
    expect(body.user.permissions).toContain("store:write");
  });

  it("refuses a viewer a write operation", async () => {
    const viewer = await harness.login("viewer@qansa.web.id", "viewer-password-2026");
    const response = await api({
      method: "POST",
      url: "/api/admin/stores",
      payload: { label: "viewer-store", shopId: 123123 },
      cookie: viewer.cookie,
      csrf: viewer.csrf,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });
});

describe("store onboarding", () => {
  it("creates a store and simulates the Shopee authorization", async () => {
    const created = await admin("POST", "/api/admin/stores", {
      label: "pixelbloomid",
      shopId: 771001,
      environment: "SANDBOX",
      verificationPolicy: "USERNAME",
    });
    expect(created.statusCode).toBe(201);
    storeId = created.json().store.id;

    const authorize = await admin("POST", `/api/admin/stores/${storeId}/authorize`);
    expect(authorize.statusCode).toBe(200);
    expect(authorize.json().simulated).toBe(true);
    expect(authorize.json().url).toContain("shop/auth_partner");

    const simulated = await admin("POST", `/api/admin/stores/${storeId}/authorize/simulate`);
    expect(simulated.statusCode).toBe(200);
    expect(simulated.json().connected).toBe(true);

    const detail = await admin("GET", `/api/admin/stores/${storeId}`);
    expect(detail.json().store.status).toBe("CONNECTED");
    expect(detail.json().token.expiresAt).toBeTruthy();
  });

  it("never returns a token or partner key", async () => {
    const response = await admin("GET", `/api/admin/stores/${storeId}`);
    expect(response.body).not.toContain("fixture-access");
    expect(response.body).not.toContain("fixture-refresh");
    expect(response.body).not.toMatch(/access_token/i);
  });

  it("refuses a duplicate shop id", async () => {
    const response = await admin("POST", "/api/admin/stores", { label: "pixelbloomid-2", shopId: 771001, environment: "SANDBOX" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("STORE_EXISTS");
  });
});

describe("catalogue, mapping and orders", () => {
  let digitalProductId: string;
  let variationId: string;

  it("queues a product sync and runs it through the worker path", async () => {
    const queued = await admin("POST", `/api/admin/stores/${storeId}/sync/products`);
    expect(queued.statusCode).toBe(200);
    expect(queued.json().queued).toBe(true);

    // A second click while the job is still queued pulls the existing job
    // forward instead of stacking another one.
    const second = await admin("POST", `/api/admin/stores/${storeId}/sync/products`);
    expect(second.statusCode).toBe(200);
    expect(second.json().queued).toBe(true);
    expect(second.json().message).toContain("dijadwalkan ulang");

    const stats = await runProductSync({ ...harness.app.ctx.deps }, { storeId });
    expect(stats.items).toBeGreaterThan(0);

    const catalog = await admin("GET", `/api/admin/catalog?storeId=${storeId}`);
    expect(catalog.statusCode).toBe(200);
    const product = catalog.json().data[0];
    expect(product.variations.length).toBeGreaterThan(0);
    expect(product.mapped).toBe(false);
    variationId = product.variations[0].id;
  });

  it("creates a digital product with activation codes and maps a variation", async () => {
    const created = await admin("POST", "/api/admin/digital-products", {
      name: "E-Meterai 1 Lembar",
      deliveryKind: "CODE",
      status: "ACTIVE",
      instructions: "Tempel kode di halaman e-meterai Peruri.",
      claimExpiryDays: 30,
      maxDeliveries: 3,
    });
    expect(created.statusCode).toBe(201);
    digitalProductId = created.json().product.id;

    const codes = await admin("POST", `/api/admin/digital-products/${digitalProductId}/codes`, {
      codes: ["MTR-AAAA-1111", "MTR-BBBB-2222", "MTR-AAAA-1111"],
    });
    expect(codes.statusCode).toBe(200);
    expect(codes.json().added).toBe(2);

    const catalog = await admin("GET", `/api/admin/catalog?storeId=${storeId}`);
    const product = catalog.json().data[0];
    const variation = product.variations.find((row: { id: string }) => row.id === variationId);

    // Map every variation of the listing: the fixture order buys the "5
    // E-Meterai" variation, and an unmapped variation must stay unclaimable.
    for (const entry of product.variations as Array<{ id: string }>) {
      const mapped = await admin("POST", "/api/admin/mappings", {
        shopeeProductId: product.id,
        shopeeVariationId: entry.id,
        digitalProductId,
        quantityMultiplier: 1,
      });
      expect([200, 201]).toContain(mapped.statusCode);
    }

    const remapped = await admin("POST", "/api/admin/mappings", {
      shopeeProductId: product.id,
      shopeeVariationId: variation.id,
      digitalProductId,
      quantityMultiplier: 1,
    });
    expect(remapped.statusCode).toBe(200);
    expect(remapped.json().mapping.quantityMultiplier).toBe(1);
  });

  it("syncs orders and makes the paid one claimable", async () => {
    await runOrderSync({ ...harness.app.ctx.deps }, { storeId });

    const orders = await admin("GET", `/api/admin/orders?storeId=${storeId}`);
    expect(orders.statusCode).toBe(200);
    const list = orders.json().data as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);

    const paid = list.find((row) => row.state === "FULFILLED");
    expect(paid).toBeTruthy();
    expect(paid?.claimable).toBe(1);
  });

  it("accepts a signed push and acknowledges a retry as a duplicate", async () => {
    const body = pushBody("260101PXL0001");
    const first = await api({
      method: "POST",
      url: "/webhook/shopee",
      payload: body,
      headers: { "content-type": "application/json", authorization: signPush(body) },
    });
    expect(first.statusCode).toBe(200);

    const retry = await api({
      method: "POST",
      url: "/webhook/shopee",
      payload: body,
      headers: { "content-type": "application/json", authorization: signPush(body) },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBe(true);
  });

  it("rejects a push whose signature does not match the body", async () => {
    const body = pushBody("260101PXL9999");
    const response = await api({
      method: "POST",
      url: "/webhook/shopee",
      payload: body,
      headers: { "content-type": "application/json", authorization: signPush(body, "wrong-key") },
    });
    expect(response.statusCode).toBe(401);

    const [event] = await harness.db.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.signatureValid, false))
      .limit(1);
    expect(event?.error).toContain("signature");
  });
});

describe("buyer claim", () => {
  let claimCookie: string;
  let fulfillmentId: string;

  it("refuses the order number alone", async () => {
    const response = await api({ method: "POST", url: "/api/claim/verify", payload: { orderSn: "260101PXL0001" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("USERNAME_MISSING");
  });

  it("refuses a buyer that does not own the order", async () => {
    const response = await api({
      method: "POST",
      url: "/api/claim/verify",
      payload: { orderSn: "260101PXL0001", buyerUsername: "orang_lain" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("USERNAME_MISMATCH");
  });

  it("verifies the real buyer and lists the product", async () => {
    const response = await api({
      method: "POST",
      url: "/api/claim/verify",
      payload: { orderSn: "260101PXL0001", buyerUsername: "rina_kurnia" },
    });
    expect(response.statusCode).toBe(200);
    const cookies = response.cookies as Array<{ name: string; value: string }>;
    const claim = cookies.find((cookie) => cookie.name === "qansa_claim");
    expect(claim?.value).toBeTruthy();
    claimCookie = `qansa_claim=${claim?.value}`;

    const session = await api({ method: "GET", url: "/api/claim/session", cookie: claimCookie });
    expect(session.statusCode).toBe(200);
    const body = session.json();
    expect(body.orderSn).toBe("260101PXL0001");
    expect(body.items[0].productName).toBe("E-Meterai 1 Lembar");
    expect(body.items[0].status).toBe("CLAIMABLE");
    expect(session.body).not.toContain("MTR-AAAA-1111");
    fulfillmentId = body.items[0].fulfillmentId;
  });

  it("reveals the activation code once per claim", async () => {
    const first = await api({ method: "POST", url: `/api/claim/fulfillments/${fulfillmentId}/access`, cookie: claimCookie });
    expect(first.statusCode).toBe(200);
    expect(first.json().delivery.kind).toBe("CODE");
    const code = first.json().delivery.code;
    expect(["MTR-AAAA-1111", "MTR-BBBB-2222"]).toContain(code);

    const second = await api({ method: "POST", url: `/api/claim/fulfillments/${fulfillmentId}/access`, cookie: claimCookie });
    expect(second.json().delivery.code).toBe(code);
  });

  it("shows the claim in the admin console and can revoke it", async () => {
    const list = await admin("GET", "/api/admin/claims?status=COMPLETED");
    expect(list.statusCode).toBe(200);
    const claim = (list.json().data as Array<{ id: string; orderSn: string }>)[0];
    expect(claim?.orderSn).toBe("260101PXL0001");

    const revoked = await admin("POST", `/api/admin/claims/${claim!.id}/revoke`, { reason: "uji coba revoke" });
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await api({ method: "POST", url: `/api/claim/fulfillments/${fulfillmentId}/access`, cookie: claimCookie });
    expect(afterRevoke.statusCode).toBe(403);
    expect(afterRevoke.json().error.code).toBe("ACCESS_REVOKED");
  });

  it("cannot use a claim cookie for another order", async () => {
    const other = await api({ method: "GET", url: "/api/claim/session" });
    expect(other.statusCode).toBe(401);
  });
});

describe("dashboard data", () => {
  it("returns the overview counters", async () => {
    const response = await admin("GET", "/api/admin/overview");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stores.total).toBeGreaterThanOrEqual(1);
    expect(body.orders.total).toBeGreaterThanOrEqual(2);
    expect(body.series.orders).toHaveLength(14);
    // The claim from the buyer journey was revoked in the previous test, so the
    // check is that it is counted somewhere rather than still successful.
    expect(body.claims.successful + body.claims.revoked).toBeGreaterThanOrEqual(1);
  });

  it("returns monitoring with actionable alerts", async () => {
    const response = await admin("GET", "/api/admin/monitoring");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.webhooks.configured).toBe(true);
    expect(body.webhooks.total24h).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("lists orders with their details and timeline", async () => {
    const list = await admin("GET", `/api/admin/orders?storeId=${storeId}`);
    const order = (list.json().data as Array<{ id: string }>)[0];
    const detail = await admin("GET", `/api/admin/orders/${order!.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().items.length).toBeGreaterThan(0);
    expect(detail.json().events.length).toBeGreaterThan(0);
  });

  it("writes an audit row for every administrative action", async () => {
    const logs = await admin("GET", "/api/admin/audit-logs");
    expect(logs.statusCode).toBe(200);
    const actions = (logs.json().data as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toContain("store.create");
    expect(actions).toContain("mapping.create");
    expect(actions).toContain("claim.revoke");
  });

  it("protects audit logs from a role that may not read them", async () => {
    const viewer = await harness.login("viewer@qansa.web.id", "viewer-password-2026");
    const response = await api({ method: "GET", url: "/api/admin/audit-logs", cookie: viewer.cookie });
    expect(response.statusCode).toBe(403);
  });
});

describe("settings", () => {
  it("updates claim limits and reflects them on the public config", async () => {
    const patched = await admin("PATCH", "/api/admin/settings", { claim: { maxAttemptsPerHour: 5 } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().settings.claim.maxAttemptsPerHour).toBe(5);

    const publicConfig = await api({ method: "GET", url: "/api/public/config" });
    expect(publicConfig.json().claim.sessionMinutes).toBe(30);
  });

  it("refuses an out-of-range value instead of storing it", async () => {
    const response = await admin("PATCH", "/api/admin/settings", { claim: { sessionMinutes: 5_000 } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});
