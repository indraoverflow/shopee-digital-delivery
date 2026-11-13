#!/usr/bin/env node
/**
 * Mint one e-Meterai buyer link and print the URL, using the endpoint the dashboard
 * calls: GET https://e-meterai.co.id/api/v3/reseller/generate-link?data=<encrypted>.
 *
 * This spends one unit of the account balance, so it is manual only: no test, no
 * preflight, no CI job calls it.
 *
 * Usage: node scripts/emeterai-mint.mjs [qty] [credentials-file]
 */
import { readFile } from "node:fs/promises";
import { decryptToObject, encrypt } from "./emeterai-crypto.mjs";

const qty = Number(process.argv[2] ?? 1);
const CREDENTIALS = process.argv[3] ?? "/home/apps/.emeterai_login";
const ORIGIN = "https://e-meterai.co.id";

if (!Number.isInteger(qty) || qty < 1 || qty > 50)
  throw new Error("qty must be an integer 1..50");

const raw = await readFile(CREDENTIALS, "utf8");
const blob = raw.match(/"data"\s*:\s*"([^"]+)"/)?.[1];
const { user, password } = blob
  ? decryptToObject(blob)
  : Object.fromEntries(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );

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
    data: encrypt({ user: user ?? "", password }, { randomIv: true }),
  }),
});
const loginBody = await login.json();
console.log(`login    ${login.status} statusCode=${loginBody.statusCode}`);
if (loginBody.statusCode !== "00") process.exit(1);

const auth = { ...headers, authorization: `Bearer ${loginBody.token}` };

const balance = await fetch(`${ORIGIN}/api/function/saldopos`, {
  method: "POST",
  headers: auth,
});
const balanceBody = await balance.json().catch(() => ({}));
console.log(
  `balance  ${balance.status} saldo=${balanceBody?.result?.saldo ?? "?"} notstamp=${balanceBody?.result?.notstamp ?? "?"}`,
);

const data = encodeURIComponent(
  encrypt({ fullpath: true, qty, partial: false }, { randomIv: true }),
);
const mint = await fetch(
  `${ORIGIN}/api/v3/reseller/generate-link?data=${data}`,
  { headers: auth },
);
const text = await mint.text();

let body;
try {
  body = JSON.parse(text);
} catch {
  console.log(`mint     ${mint.status} non-json ${text.slice(0, 160)}`);
  process.exit(1);
}

console.log(
  `mint     ${mint.status} ${body.status ?? body.statusCode} ${body.message ?? ""}`,
);
const result = body.result ?? {};
const raw_links = result.linkUrl ?? result.links ?? result;
const links = Array.isArray(raw_links)
  ? raw_links
  : [raw_links].filter(Boolean);
console.log(`result   ${JSON.stringify(result).slice(0, 300)}`);

for (const entry of links) {
  const ref =
    typeof entry === "string" ? entry : (entry.linkUrl ?? entry.refid ?? entry);
  console.log(`buyer    ${ORIGIN}/pdfViewer?refid=${ref}`);
}
console.log(`qty      ${qty}`);
