#!/usr/bin/env node
/**
 * Read-only probe of the e-Meterai dashboard API.
 *
 * The dashboard encrypts its own request bodies, so a plain JSON login is refused
 * before the password is looked at. This signs in the way the site does, says who the
 * account is and what it can see, and stops.
 *
 * It never calls generate-link: that call can spend paid quota, and spending it is the
 * operator's decision, not a script's.
 *
 * Usage: node scripts/emeterai-probe.mjs [credentials-file]
 * Credentials file: `email=...` and `password=...` lines.
 */
import { readFile } from "node:fs/promises";
import { decryptToObject, encrypt } from "./emeterai-crypto.mjs";

const CREDENTIALS = process.argv[2] ?? "/home/apps/.emeterai_login";
const ORIGIN = "https://e-meterai.co.id";
const API = "https://backendservice.e-meterai.co.id";

const mask = (value) =>
  value
    ? `${String(value).slice(0, 4)}...${String(value).slice(-4)} (${String(value).length})`
    : value;
const maskEmail = (email) => {
  const [name, domain] = String(email).split("@");
  return `${name?.slice(0, 2) ?? ""}***@${domain?.slice(0, 3) ?? ""}***`;
};

/**
 * Two shapes are accepted, because the owner may keep either:
 *   email=... / password=...
 *   a captured `curl ... --data '{"data":"<blob>"}'` from the browser
 * The blob is encrypted with the same static key the site ships, so it decrypts back to
 * the credentials. Nothing is printed either way.
 */
async function credentials(path) {
  const raw = await readFile(path, "utf8");

  const blob = raw.match(/"data"\s*:\s*"([^"]+)"/)?.[1];
  if (blob) {
    const inside = decryptToObject(blob);
    const email = inside?.email ?? inside?.user ?? inside?.username;
    const password = inside?.password;
    if (email && password) return { email, password, source: "captured curl" };
    throw new Error(
      `${path} has a data blob that did not decrypt to email/password`,
    );
  }

  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("curl"))
      continue;
    const at = trimmed.indexOf("=");
    if (at === -1) continue;
    map.set(
      trimmed.slice(0, at).trim().toLowerCase(),
      trimmed.slice(at + 1).trim(),
    );
  }
  const email = map.get("email") ?? map.get("username");
  const password = map.get("password");
  if (!email || !password)
    throw new Error(`${path} must contain email= and password= lines`);
  return { email, password };
}

const browserHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/plain, */*",
  origin: ORIGIN,
  referer: `${ORIGIN}/`,
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function readResult(body) {
  if (!body || typeof body !== "object" || !body.result) return body;
  try {
    return decryptToObject(body.result);
  } catch {
    return body.result;
  }
}

async function main() {
  const { email, password, source } = await credentials(CREDENTIALS);
  console.log(
    `credentials   ${maskEmail(email)} from ${CREDENTIALS}${source ? ` (${source})` : ""}`,
  );

  const login = await fetch(`${ORIGIN}/api/users/login`, {
    method: "POST",
    headers: browserHeaders,
    // The dashboard signs in with { user, password }, not { email, password }; the
    // captured request is the authority here, not intuition.
    body: JSON.stringify({
      data: encrypt({ user: email, password }, { randomIv: true }),
    }),
  });
  const body = await login.json().catch(() => ({}));
  console.log(
    `login         http ${login.status} statusCode ${body.statusCode ?? "-"} ${body.message ?? ""}`,
  );
  if (body.statusCode !== "00") {
    console.log(
      "login refused; nothing further attempted, no link created, nothing purchased.",
    );
    process.exit(0);
  }

  const decrypted = readResult(body);
  const user = decrypted?.result?.data?.login?.user ?? {};
  const token = body.token ?? decrypted?.result?.data?.login?.token;
  console.log(
    `account       ${user.firstName ?? "-"} | role ${user.role ?? "-"} | verified ${user.verify ?? "-"} | accounts ${user.accounts?.length ?? 0}`,
  );
  console.log(`token         ${mask(token)}`);

  const auth = { ...browserHeaders, authorization: `Bearer ${token}` };

  for (const [label, url] of [
    ["profile", `${API}/api/v2/reseller`],
    ["balance", `${ORIGIN}/api/function/saldopos`],
    ["links", `${ORIGIN}/api/reseller/links`],
  ]) {
    try {
      const response = await fetch(url, { headers: auth });
      const text = await response.text();
      let shown = text.slice(0, 240);
      try {
        const inner = readResult(JSON.parse(text));
        shown = JSON.stringify(inner).slice(0, 300);
      } catch {
        /* keep the raw slice */
      }
      console.log(
        `${label.padEnd(13)} http ${response.status} ${shown.replace(/"(token|authorization)":"[^"]+"/gi, '"$1":"***"')}`,
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
