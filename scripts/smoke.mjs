#!/usr/bin/env node
/**
 * End-to-end smoke test against a running API and worker.
 *
 *   node scripts/smoke.mjs            # expects API on :4000, seeded database
 *   API_URL=http://localhost:4000 node scripts/smoke.mjs
 *
 * It walks the real business path over HTTP: log in, add a store, authorize it,
 * sync the catalogue, create and map a digital product, sync the order, then
 * claim it as the buyer. Every assertion is on an HTTP response, so a broken
 * route fails here rather than in production.
 */

const API = process.env.API_URL ?? "http://127.0.0.1:4000";
const EMAIL = process.env.ADMIN_EMAIL ?? "admin@qansa.web.id";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "local-admin-2026";

const cookies = new Map();
let failures = 0;

function cookieHeader() {
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function absorb(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const [pair] = entry.split(";");
    const [name, ...rest] = pair.split("=");
    if (name && rest.length > 0)
      cookies.set(name.trim(), rest.join("=").trim());
  }
}

async function call(method, path, body) {
  const headers = { accept: "application/json" };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers["x-csrf-token"] = cookies.get("qansa_csrf") ?? "";
    if (body !== undefined) headers["content-type"] = "application/json";
  }

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  absorb(response);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  return { status: response.status, body: payload };
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(
    `  FAIL ${label}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`,
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await fn();
    if (result) {
      check(label, true);
      return result;
    }
    await wait(750);
  }
  check(label, false, "timeout");
  return null;
}

const main = async () => {
  console.log(`smoke: ${API}`);

  const health = await call("GET", "/health");
  check("health responds", health.status === 200, health.body);

  const login = await call("POST", "/api/auth/login", {
    email: EMAIL,
    password: PASSWORD,
  });
  check("admin login", login.status === 200, login.body);
  if (login.status !== 200) return;

  const stores = await call("GET", "/api/admin/stores");
  check("list stores", stores.status === 200, stores.body);

  // 771001 is the fixture store; override with SMOKE_SHOP_ID for a live shop.
  const shopId = Number(process.env.SMOKE_SHOP_ID ?? 771001);
  let store =
    stores.body.data.find((row) => row.shopId === shopId) ??
    (
      await call("POST", "/api/admin/stores", {
        label: "pixelbloomid",
        shopId,
        environment: "SANDBOX",
        verificationPolicy: "USERNAME",
      })
    ).body.store;
  check("store exists", Boolean(store?.id), store);

  const detail = await call("GET", `/api/admin/stores/${store.id}`);
  if (detail.body.store.status !== "CONNECTED") {
    const connect = await call(
      "POST",
      `/api/admin/stores/${store.id}/authorize/simulate`,
    );
    check("store authorized (fixture)", connect.status === 200, connect.body);
  } else {
    check("store authorized (fixture)", true);
  }

  const productSync = await call(
    "POST",
    `/api/admin/stores/${store.id}/sync/products`,
  );
  check("product sync queued", productSync.status === 200, productSync.body);

  const catalog = await waitFor("catalogue synced by the worker", async () => {
    const result = await call(
      "GET",
      `/api/admin/catalog?storeId=${store.id}&pageSize=50`,
    );
    return result.body.data?.length > 0 ? result.body.data : null;
  });

  if (!catalog) return;

  const listing =
    catalog.find((row) => row.variations.length > 0) ?? catalog[0];
  check("catalogue has variations", listing.variations.length > 0, listing);

  const products = await call("GET", "/api/admin/digital-products?pageSize=50");
  let digital = products.body.data.find(
    (row) => row.name === "Smoke Test E-Meterai",
  );
  if (!digital) {
    const created = await call("POST", "/api/admin/digital-products", {
      name: "Smoke Test E-Meterai",
      deliveryKind: "CODE",
      status: "ACTIVE",
      claimExpiryDays: 30,
      maxDeliveries: 3,
    });
    check("digital product created", created.status === 201, created.body);
    digital = created.body.product;
  }

  const codes = await call(
    "POST",
    `/api/admin/digital-products/${digital.id}/codes`,
    {
      codes: ["SMOKE-CODE-1111", "SMOKE-CODE-2222", "SMOKE-CODE-3333"],
    },
  );
  check("codes stored", codes.status === 200, codes.body);

  for (const variation of listing.variations) {
    const mapped = await call("POST", "/api/admin/mappings", {
      shopeeProductId: listing.id,
      shopeeVariationId: variation.id,
      digitalProductId: digital.id,
      quantityMultiplier: 1,
    });
    check(
      `variation mapped: ${variation.name}`,
      [200, 201].includes(mapped.status),
      mapped.body,
    );
  }

  const orderSync = await call(
    "POST",
    `/api/admin/stores/${store.id}/sync/orders`,
  );
  check("order sync queued", orderSync.status === 200, orderSync.body);

  const orders = await waitFor("orders synced by the worker", async () => {
    const result = await call(
      "GET",
      `/api/admin/orders?storeId=${store.id}&pageSize=50`,
    );
    // COMPLETED also qualifies: a repeated smoke run meets an order that was
    // already claimed once, and the same claim must still work.
    const claimable = result.body.data?.filter((row) =>
      ["FULFILLED", "CLAIMED", "COMPLETED"].includes(row.state),
    );
    return claimable?.length ? claimable : null;
  });

  if (!orders) return;

  const order = orders[0];
  check("order is claimable", order.claimable + order.claimed > 0, order);

  const orderDetail = await call("GET", `/api/admin/orders/${order.id}`);
  const buyer = orderDetail.body.order.buyerUsername;
  check("order detail has buyer", Boolean(buyer), orderDetail.body.order);

  const verify = await call("POST", "/api/claim/verify", {
    orderSn: order.orderSn,
    buyerUsername: buyer,
  });
  check("buyer verified", verify.status === 200, verify.body);

  const session = await call("GET", "/api/claim/session");
  check(
    "claim session lists items",
    session.status === 200 && session.body.items.length > 0,
    session.body,
  );

  const item = session.body.items?.[0];
  const delivery = item
    ? await call("POST", `/api/claim/fulfillments/${item.fulfillmentId}/access`)
    : { status: 0 };
  check(
    "product revealed",
    delivery.status === 200 &&
      Boolean(delivery.body.delivery?.code ?? delivery.body.delivery?.url),
    delivery.body,
  );

  const claims = await call(
    "GET",
    "/api/admin/claims?status=COMPLETED&pageSize=5",
  );
  check(
    "claim recorded for admin",
    claims.status === 200 && claims.body.data.length > 0,
    claims.body,
  );

  const overview = await call("GET", "/api/admin/overview");
  check(
    "overview counters",
    overview.status === 200 && overview.body.orders.total > 0,
    overview.body?.orders,
  );

  const monitoring = await call("GET", "/api/admin/monitoring");
  check(
    "monitoring responds",
    monitoring.status === 200,
    monitoring.body?.alerts,
  );

  // --- security surface ---------------------------------------------------
  const twoFactor = await call("GET", "/api/auth/2fa");
  check(
    "2FA status readable",
    twoFactor.status === 200 && typeof twoFactor.body.enabled === "boolean",
    twoFactor.body,
  );

  const chain = await call("GET", "/api/admin/security/audit-chain");
  check(
    "audit chain verifies",
    chain.status === 200 && chain.body.valid === true && chain.body.checked > 0,
    chain.body,
  );

  const users = await call("GET", "/api/admin/users");
  check(
    "console users listed",
    users.status === 200 && users.body.data.some((row) => row.email === EMAIL),
    users.body,
  );

  const retention = await call("GET", "/api/admin/security/retention");
  check(
    "retention preview responds",
    retention.status === 200 && typeof retention.body.preview?.webhookEvents === "number",
    retention.body,
  );

  const notifications = await call("POST", "/api/admin/security/notify-test", {});
  check(
    "notification test answers a reason, never a crash",
    notifications.status === 200 && typeof notifications.body.delivered === "boolean",
    notifications.body,
  );

  // --- manual verification queue -----------------------------------------
  const requests = await call(
    "GET",
    "/api/admin/claim-requests?status=PENDING&pageSize=5",
  );
  check(
    "manual verification queue readable",
    requests.status === 200 && Array.isArray(requests.body.data),
    requests.body,
  );

  const unknownRequest = await call("POST", "/api/claim/request", {
    orderSn: "999999SMOKE0001",
    buyerUsername: "tidak_ada",
    contact: "smoke@example.com",
  });
  check(
    "unknown order refused without leaking",
    unknownRequest.status === 404 &&
      unknownRequest.body.error?.code === "ORDER_NOT_FOUND",
    unknownRequest.body,
  );

  console.log(
    failures === 0 ? "\nsmoke: PASS" : `\nsmoke: ${failures} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exitCode = 1;
});
