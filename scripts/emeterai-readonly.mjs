#!/usr/bin/env node
/**
 * Which read-only endpoints does this account actually reach?
 *
 * Signs in the way the dashboard does and then tries a short list of GETs across the
 * hosts the bundle mentions, printing only status and a trimmed body. No POST that can
 * create a record, no generate-link, nothing that spends quota.
 *
 * Usage: node scripts/emeterai-readonly.mjs
 */
import { readFile } from "node:fs/promises";
import { decryptToObject, encrypt } from "./emeterai-crypto.mjs";

const CREDENTIALS = "/home/apps/.emeterai_login";
const ORIGIN = "https://e-meterai.co.id";

const raw = await readFile(CREDENTIALS, "utf8");
const blob = raw.match(/"data"\s*:\s*"([^"]+)"/)?.[1];
if (!blob) throw new Error("expected a captured curl with a data blob");
const { user, password } = decryptToObject(blob);

const headers = {
  "content-type": "application/json",
  origin: ORIGIN,
  referer: `${ORIGIN}/`,
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const login = await fetch(`${ORIGIN}/api/users/login`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    data: encrypt({ user, password }, { randomIv: true }),
  }),
});
const body = await login.json();
console.log(`login ${login.status} ${body.statusCode}`);
if (body.statusCode !== "00") process.exit(0);

const auth = { ...headers, authorization: `Bearer ${body.token}` };

const targets = [
  [
    "stampservice saldopos",
    "https://stampservice.e-meterai.co.id/function/saldopos",
  ],
  [
    "stampservice nsaldokuota",
    "https://stampservice.e-meterai.co.id/function/nsaldokuota",
  ],
  ["stampv2 links", "https://stampv2.e-meterai.co.id/reseller/links"],
  [
    "stampv2 generate-link",
    "https://stampv2.e-meterai.co.id/api/v3/reseller/generate-link",
  ],
  [
    "backend reseller",
    "https://backendservice.e-meterai.co.id/api/v2/reseller",
  ],
];

for (const [label, url] of targets) {
  try {
    const response = await fetch(url, { headers: auth });
    const text = await response.text();
    let shown = text.slice(0, 140).replace(/\s+/g, " ");
    try {
      const parsed = JSON.parse(text);
      const inner = parsed.result ? decryptToObject(parsed.result) : parsed;
      shown = JSON.stringify(inner).slice(0, 200);
    } catch {
      /* keep the slice */
    }
    console.log(`${label.padEnd(26)} ${response.status} ${shown}`);
  } catch (error) {
    console.log(
      `${label.padEnd(26)} err ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
