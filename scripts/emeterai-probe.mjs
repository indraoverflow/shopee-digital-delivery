#!/usr/bin/env node
/**
 * One-shot discovery against the e-Meterai dashboard API.
 *
 * It answers one question honestly: can this account be driven from a server, and
 * what does the login answer look like? It logs in, reads the balance, and stops
 * there. It does not create a link or buy anything, because a generate-link call can
 * consume a paid quota and that decision belongs to the operator.
 *
 * Output masks every token, cookie and email domain, so the transcript can be
 * pasted into an issue or a chat without handing out a session.
 *
 * Usage: node scripts/emeterai-probe.mjs [path-to-credentials]
 * Credentials file: two lines, `email=...` and `password=...`.
 */
import { readFile } from "node:fs/promises";

const CREDENTIALS = process.argv[2] ?? "/home/apps/.emeterai_login";
const LOGIN_BASE = "https://backendservice.e-meterai.co.id";
const STAMP_BASE = "https://stampservice.e-meterai.co.id";

function mask(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
}

function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  return `${name?.slice(0, 2) ?? ""}***@${domain ? `${domain.slice(0, 3)}***` : "***"}`;
}

async function readCredentials(path) {
  const raw = await readFile(path, "utf8");
  const entries = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at === -1) continue;
    entries.set(
      trimmed.slice(0, at).trim().toLowerCase(),
      trimmed.slice(at + 1).trim(),
    );
  }
  const email = entries.get("email") ?? entries.get("username");
  const password = entries.get("password");
  if (!email || !password)
    throw new Error(`${path} must contain email= and password= lines`);
  return { email, password };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 400);
  }
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (/token|jwt|csrf|password|secret|session|uspomena/i.test(key))
        out[key] = mask(String(inner));
      else out[key] = scrub(inner);
    }
    return out;
  }
  return value;
}

async function main() {
  const { email, password } = await readCredentials(CREDENTIALS);
  console.log(`credentials   ${maskEmail(email)} from ${CREDENTIALS}`);

  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (response) => {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  };

  // The dashboard fetches a CSRF token first and sends it back in a `csrf-token`
  // header, so a login without it is rejected before the password is even considered.
  const csrfResponse = await fetch(`${LOGIN_BASE}/csrf`, {
    headers: { accept: "application/json", origin: "https://e-meterai.co.id" },
  });
  absorb(csrfResponse);
  const csrfBody = safeJson(await csrfResponse.text());
  const csrfToken =
    jar.get("csrf-token") ??
    (typeof csrfBody === "object" ? (csrfBody?.token ?? null) : null);
  console.log(
    `csrf          http ${csrfResponse.status} ${csrfToken ? "token captured" : "no token"}`,
  );

  // Everything a browser would send with that call. The Origin and Referer are the
  // cheapest thing a server-side probe usually forgets, and the only difference
  // worth one more attempt before asking the owner for a captured request.
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    "accept-language": "id-ID,id;q=0.9,en;q=0.8",
    origin: "https://e-meterai.co.id",
    referer: "https://e-meterai.co.id/",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ...(csrfToken ? { "csrf-token": String(csrfToken) } : {}),
    ...(cookieHeader() ? { cookie: cookieHeader() } : {}),
  };

  // The dashboard sends { email, password }; a 400 tells us the field names differ.
  const login = await fetch(`${LOGIN_BASE}/api/users/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  absorb(login);
  const loginBody = safeJson(await login.text());
  console.log(`login         http ${login.status} ${login.statusText}`);
  console.log(
    `login body    ${JSON.stringify(scrub(loginBody)).slice(0, 900)}`,
  );
  if (jar.size > 0) console.log(`cookies       ${[...jar.keys()].join(", ")}`);

  const token =
    (loginBody &&
      typeof loginBody === "object" &&
      (loginBody.token ?? loginBody.access_token ?? loginBody?.data?.token)) ||
    null;

  if (!token) {
    console.log(
      "\nNo token in the answer: the field names or the CSRF requirement differ from the guess.",
    );
    console.log(
      "Nothing further was attempted; no link was created and nothing was purchased.",
    );
    process.exit(0);
  }

  console.log(`token         ${mask(String(token))}`);

  const authHeaders = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    origin: "https://e-meterai.co.id",
  };
  if (cookieHeader()) authHeaders.cookie = cookieHeader();

  for (const [label, url] of [
    ["balance", `${STAMP_BASE}/function/saldopos`],
    ["profile", `${LOGIN_BASE}/api/v2/reseller`],
  ]) {
    try {
      const response = await fetch(url, { headers: authHeaders });
      const body = safeJson(await response.text());
      console.log(
        `${label.padEnd(13)} http ${response.status} ${JSON.stringify(scrub(body)).slice(0, 400)}`,
      );
    } catch (error) {
      console.log(
        `${label.padEnd(13)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    "\nStopped before generate-link on purpose: that call can spend paid quota.",
  );
}

main().catch((error) => {
  console.error(
    "probe failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
