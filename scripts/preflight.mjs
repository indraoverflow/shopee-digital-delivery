#!/usr/bin/env node
/**
 * Preflight for a real deployment, and the switch to live Shopee.
 *
 *   node --env-file=.env scripts/preflight.mjs
 *   API_URL=https://api.qansa.web.id node --env-file=.env scripts/preflight.mjs --public
 *
 * Two modes:
 *   local   checks the environment, the database, the queue and the stores through
 *           the API, exactly as a deployment would see them.
 *   public  (--public) additionally checks DNS/TLS through the public hostnames and
 *           proves the push endpoint accepts a signed push and refuses a forged one.
 *
 * Exit code is non-zero when a blocking check fails, so it can gate a deploy or a
 * go-live. Nothing here prints a secret: presence and length only.
 */

const API = (process.env.API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const EMAIL = process.env.ADMIN_EMAIL ?? "admin@qansa.web.id";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const PUBLIC_MODE = process.argv.includes("--public") || API.startsWith("https://");

const cookies = new Map();
const results = [];
/** Filled by the service checks so the push probe can address a real shop. */
let cachedShopId = null;

const green = (text) => `\u001b[32m${text}\u001b[0m`;
const red = (text) => `\u001b[31m${text}\u001b[0m`;
const amber = (text) => `\u001b[33m${text}\u001b[0m`;

function record(level, label, detail) {
  results.push({ level, label, detail });
  const mark = level === "ok" ? green("ok  ") : level === "warn" ? amber("warn") : red("FAIL");
  console.log(`  ${mark} ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const ok = (label, detail) => record("ok", label, detail);
const warn = (label, detail) => record("warn", label, detail);
const fail = (label, detail) => record("fail", label, detail);

function cookieHeader() {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function absorb(response) {
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(";");
    const [name, ...rest] = pair.split("=");
    if (name && rest.length > 0) cookies.set(name.trim(), rest.join("=").trim());
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
    signal: AbortSignal.timeout(15_000),
  });
  absorb(response);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload };
}

/* ------------------------------------------------------------------ environment */

function checkEnvironment() {
  console.log("\nenvironment");
  const env = process.env;

  const key = env.APP_ENCRYPTION_KEY ?? "";
  if (/^[0-9a-fA-F]{64}$/.test(key)) ok("APP_ENCRYPTION_KEY", "64 hex characters");
  else fail("APP_ENCRYPTION_KEY", `expected 64 hex characters, got ${key.length} characters`);

  const secret = env.DOWNLOAD_SIGNING_SECRET ?? "";
  if (secret.length >= 32) ok("DOWNLOAD_SIGNING_SECRET", `${secret.length} characters`);
  else fail("DOWNLOAD_SIGNING_SECRET", `at least 32 characters, got ${secret.length}`);

  if (env.NODE_ENV === "production") ok("NODE_ENV", "production");
  else warn("NODE_ENV", `${env.NODE_ENV ?? "unset"}: secure cookies and strict CORS behave differently`);

  if (env.SESSION_COOKIE_SECURE === "true") ok("SESSION_COOKIE_SECURE", "true");
  else warn("SESSION_COOKIE_SECURE", "false: only acceptable over plain HTTP");

  for (const name of ["ADMIN_ORIGIN", "CLAIM_ORIGIN", "API_PUBLIC_ORIGIN"]) {
    const value = env[name] ?? "";
    if (value.startsWith("https://")) ok(name, value);
    else if (env.NODE_ENV === "production") fail(name, `${value || "unset"} must be https in production`);
    else warn(name, value || "unset");
  }

  const pushUrl = env.SHOPEE_PUSH_URL ?? "";
  if (!pushUrl) {
    if (env.SHOPEE_GATEWAY_MODE === "live") fail("SHOPEE_PUSH_URL", "required in live mode: pushes would be refused");
    else warn("SHOPEE_PUSH_URL", "unset: pushes are accepted unverified outside production");
  } else if (!pushUrl.startsWith("https://")) {
    fail("SHOPEE_PUSH_URL", "must be the https URL registered in the Shopee console");
  } else {
    ok("SHOPEE_PUSH_URL", pushUrl);
  }

  if (!env.DATABASE_URL) fail("DATABASE_URL", "unset");

  if (env.SHOPEE_GATEWAY_MODE === "live") {
    console.log("\nshopee live credentials");
    if ((env.SHOPEE_PARTNER_ID ?? "0") !== "0" && env.SHOPEE_PARTNER_ID) ok("SHOPEE_PARTNER_ID", "set");
    else fail("SHOPEE_PARTNER_ID", "unset");

    const partnerKey = env.SHOPEE_PARTNER_KEY ?? "";
    if (partnerKey.length >= 20) ok("SHOPEE_PARTNER_KEY", `${partnerKey.length} characters`);
    else fail("SHOPEE_PARTNER_KEY", "missing or a placeholder");

    if (env.SHOPEE_ENV === "production") ok("SHOPEE_ENV", "production");
    else warn("SHOPEE_ENV", `${env.SHOPEE_ENV ?? "sandbox"}: orders will not match the live shop`);

    if (env.SHOPEE_PUSH_TEST_PARTNER_KEY) warn("SHOPEE_PUSH_TEST_PARTNER_KEY", "set: only for console test pushes, remove after go-live");
  } else {
    console.log("\nshopee live credentials");
    warn("SHOPEE_GATEWAY_MODE", `${env.SHOPEE_GATEWAY_MODE ?? "fixture"}: the pipeline runs against fixtures, not Shopee`);
  }
}

/* ----------------------------------------------------------------------- service */

async function checkService() {
  console.log("\nservice");
  const health = await call("GET", "/health");
  if (health.status === 200) ok("health", health.body);
  else fail("health", `${health.status} ${JSON.stringify(health.body)}`);

  const ready = await call("GET", "/ready");
  if (ready.status === 200) ok("database reachable");
  else fail("database", `${ready.status} ${JSON.stringify(ready.body)}`);

  if (!PASSWORD) {
    warn("admin login", "ADMIN_PASSWORD is unset: skipping the authenticated checks");
    return;
  }

  const login = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) {
    fail("admin login", `${login.status} ${JSON.stringify(login.body)}`);
    return;
  }
  if (login.body?.mfaRequired) {
    warn("admin login", "account has 2FA: the rest of the checks need a session cookie");
    return;
  }
  ok("admin login", login.body?.user?.email);

  const stores = await call("GET", "/api/admin/stores");
  const connected = (stores.body?.data ?? []).filter((store) => store.status === "CONNECTED");
  cachedShopId = connected[0]?.shopId ?? null;
  if (connected.length > 0) ok("connected stores", connected.map((store) => store.label ?? store.shopId).join(", "));
  else fail("connected stores", "none: nothing can be fulfilled");

  for (const store of connected) {
    const detail = await call("GET", `/api/admin/stores/${store.id}`);
    const token = detail.body?.token;
    const expiry = token?.minutesLeft ?? (token?.expiresAt ? (new Date(token.expiresAt).getTime() - Date.now()) / 60_000 : null);
    const name = store.label ?? store.shopId;
    if (typeof expiry !== "number" || Number.isNaN(expiry)) warn(`token ${name}`, "no token expiry reported");
    else if (expiry < 0) fail(`token ${name}`, `expired ${Math.abs(Math.round(expiry))} minutes ago`);
    else if (expiry < 60) warn(`token ${name}`, `expires in ${Math.round(expiry)} minutes`);
    else ok(`token ${name}`, `${Math.round(expiry / 60)} hours left`);
  }

  const monitoring = await call("GET", "/api/admin/monitoring");
  if (monitoring.status === 200) {
    const body = monitoring.body;
    if ((body.deadJobs ?? []).length > 0) fail("dead-letter jobs", `${body.deadJobs.length} waiting for an operator`);
    else ok("dead-letter jobs", "none");

    if (body.unmapped?.listings > 0) warn("unmapped listings", `${body.unmapped.listings} would block a paid order`);
    else ok("unmapped listings", "none");

    if ((body.alerts ?? []).length > 0) warn("monitoring alerts", body.alerts.map((alert) => alert.message).join(" | "));
    else ok("monitoring alerts", "none");

    if (body.webhooks?.configured === false) warn("push endpoint", "not configured in this deployment");
  } else {
    fail("monitoring", `${monitoring.status}`);
  }

  const chain = await call("GET", "/api/admin/security/audit-chain?limit=5000");
  if (chain.status === 200 && chain.body.valid) ok("audit chain", `${chain.body.checked} entries verified`);
  else fail("audit chain", JSON.stringify(chain.body));
}

/* ----------------------------------------------------------------------- public */

async function checkPublic() {
  console.log("\npublic hostnames");
  const claim = process.env.CLAIM_ORIGIN ?? "";
  const admin = process.env.ADMIN_ORIGIN ?? "";
  const api = process.env.API_PUBLIC_ORIGIN ?? "";

  // Each host gets a path it actually serves: the API root 404s by design, so
  // probing it would report a tunnel failure that is not one.
  for (const [label, origin, path] of [
    ["claim", claim, "/"],
    ["admin", admin, "/login"],
    ["api", api, "/health"],
  ]) {
    if (!origin) {
      warn(`${label} host`, "origin not set");
      continue;
    }
    try {
      const response = await fetch(`${origin.replace(/\/$/, "")}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      // Cloudflare answers 404 when DNS exists but the tunnel has no hostname for it.
      if (response.status === 404) fail(`${label} host`, "404: DNS exists but the tunnel ingress row is missing");
      else if (response.status >= 500) fail(`${label} host`, `${response.status}`);
      else ok(`${label} host`, `${response.status} ${response.headers.get("server") ?? ""}`.trim());
    } catch (error) {
      fail(`${label} host`, error instanceof Error ? error.message : String(error));
    }
  }

  // The push endpoint has to accept a signed body and refuse a forged one. A random
  // order number is used so a real order is never touched.
  console.log("\npush endpoint");
  const pushUrl = process.env.SHOPEE_PUSH_URL ?? "";
  const partnerKey = process.env.SHOPEE_PARTNER_KEY ?? "";
  if (!pushUrl || !partnerKey) {
    warn("push round-trip", "SHOPEE_PUSH_URL or SHOPEE_PARTNER_KEY unset");
    return;
  }

  const { createHmac } = await import("node:crypto");
  // A shop that exists, so the push is answered from the real code path instead of
  // being ignored for an unknown shop.
  const shopId = Number(process.env.PREFLIGHT_SHOP_ID ?? cachedShopId ?? 0);
  const body = JSON.stringify({
    code: 3,
    shop_id: shopId,
    timestamp: Math.floor(Date.now() / 1000),
    data: { ordersn: `PREFLIGHT${Date.now()}`, status: "READY_TO_SHIP" },
  });
  const signature = createHmac("sha256", partnerKey).update(pushUrl + body).digest("hex");

  const send = (auth) =>
    fetch(pushUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body,
      signal: AbortSignal.timeout(15_000),
    });

  const forged = await send("0".repeat(64));
  if (forged.status === 401) ok("forged push refused", "401");
  else fail("forged push refused", `${forged.status}: the endpoint accepted an unsigned body`);

  const genuine = await send(signature);
  if (genuine.status === 200) ok("signed push accepted", await genuine.text().then((text) => text.slice(0, 80)));
  else fail("signed push accepted", `${genuine.status}: check SHOPEE_PUSH_URL matches the registered URL exactly`);
}

/* ------------------------------------------------------------------------ report */

async function main() {
  console.log(`preflight: ${API} (${PUBLIC_MODE ? "public" : "local"})`);
  await checkEnvironment();
  try {
    await checkService();
  } catch (error) {
    fail("service checks", error instanceof Error ? error.message : String(error));
  }
  if (PUBLIC_MODE) {
    try {
      await checkPublic();
    } catch (error) {
      fail("public checks", error instanceof Error ? error.message : String(error));
    }
  }

  const failed = results.filter((entry) => entry.level === "fail");
  const warned = results.filter((entry) => entry.level === "warn");
  console.log(
    `\n${results.length} checks: ${results.length - failed.length - warned.length} ok, ${warned.length} warnings, ${failed.length} failures`,
  );
  if (failed.length > 0) {
    console.log(failed.map((entry) => `  - ${entry.label}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(failed.length === 0 && warned.length === 0 ? "preflight: PASS" : "preflight: PASS with warnings");
  }
}

main().catch((error) => {
  console.error("preflight: crashed", error);
  process.exitCode = 1;
});
