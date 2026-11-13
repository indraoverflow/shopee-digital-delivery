#!/usr/bin/env node
/**
 * Which host actually serves each of the four calls the e-Meterai dashboard makes?
 *
 * The bundle lists paths and bases separately, and the pairs are not obvious: the
 * reseller link API answered on one host while the same path 404s on another. This
 * tries each path on each host with no payload, so a 4xx/5xx JSON answer means "route
 * exists" and an HTML 404 means "wrong host". Nothing here writes or spends.
 *
 * Usage: node scripts/emeterai-paths.mjs
 */
import { readFile } from "node:fs/promises";
import { decryptToObject, encrypt } from "./emeterai-crypto.mjs";

const CREDENTIALS = "/home/apps/.emeterai_login";
const ORIGIN = "https://e-meterai.co.id";

const raw = await readFile(CREDENTIALS, "utf8");
const blob = raw.match(/"data"\s*:\s*"([^"]+)"/)?.[1];
const { user, password } = decryptToObject(blob);

const base = {
  "content-type": "application/json",
  origin: ORIGIN,
  referer: `${ORIGIN}/`,
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const login = await fetch(`${ORIGIN}/api/users/login`, {
  method: "POST",
  headers: base,
  body: JSON.stringify({
    data: encrypt({ user, password }, { randomIv: true }),
  }),
});
const loginBody = await login.json();
if (loginBody.statusCode !== "00")
  throw new Error(`login refused: ${loginBody.statusCode}`);
const auth = { ...base, authorization: `Bearer ${loginBody.token}` };

const hosts = [
  ORIGIN,
  "https://backendservice.e-meterai.co.id",
  "https://stampv2.e-meterai.co.id",
  "https://stampservice.e-meterai.co.id",
  "https://inventory.e-meterai.co.id",
];

const probes = [
  ["GET", "/api/v3/reseller/generate-link"],
  ["GET", "/reseller/links?createdBy=1"],
  ["POST", "/function/saldopos"],
  ["GET", "/api/v2/reseller"],
];

const looksLikeRoute = (status, text) => {
  if (status === 404 && /<html|<!DOCTYPE/i.test(text)) return false;
  return true;
};

for (const [method, path] of probes) {
  console.log(`\n${method} ${path}`);
  for (const host of hosts) {
    try {
      const response = await fetch(`${host}${path}`, {
        method,
        headers: auth,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      const text = await response.text();
      const marker = looksLikeRoute(response.status, text)
        ? "route"
        : "html404";
      const shown = text.slice(0, 110).replace(/\s+/g, " ");
      console.log(
        `  ${host.replace("https://", "").padEnd(34)} ${String(response.status).padEnd(4)} ${marker}  ${shown}`,
      );
    } catch (error) {
      console.log(
        `  ${host.replace("https://", "").padEnd(34)} err  ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
