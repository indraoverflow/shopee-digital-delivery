#!/usr/bin/env node
/**
 * Probe the public hostnames a domain needs, from outside the machine's own DNS cache.
 *
 *   node scripts/check-domains.mjs example.com
 *   node scripts/check-domains.mjs qansa.web.id
 *
 * Two deliberate choices:
 *
 *  - DNS is read over DNS-over-HTTPS, so a resolver cache on this host cannot make a
 *    half-finished migration look healthy.
 *  - HTTP is made with `curl --resolve`, pinning the DoH answer, because the router this
 *    homelab sits behind answers 0.0.0.0 for some proxied hostnames. That is a local
 *    resolver quirk, not a fault at the edge: buyers use public DNS and are unaffected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const domain = process.argv[2];

if (!domain) {
  console.error("usage: node scripts/check-domains.mjs <domain>");
  process.exit(2);
}

const hosts = [
  { host: `api.${domain}`, path: "/health", expect: 200, what: "API health" },
  {
    host: `api.${domain}`,
    path: "/ready",
    expect: 200,
    what: "database reachable",
  },
  {
    host: `sandbox-api.${domain}`,
    path: "/health",
    expect: 200,
    what: "sandbox API health",
  },
  { host: `claim.${domain}`, path: "/", expect: 200, what: "buyer portal" },
  {
    host: `admin.${domain}`,
    path: "/login",
    expect: 200,
    what: "operator console",
  },
  {
    host: `api.${domain}`,
    path: "/webhook/shopee",
    method: "POST",
    // The route parses the payload before it checks the signature, so an empty body is a
    // 400. Any refusal is fine; what must not happen is 200 or 5xx.
    expect: 400,
    what: "malformed push refused",
  },
];

async function dns(name, type) {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`,
    {
      headers: { accept: "application/dns-json" },
    },
  );
  const body = await response.json();
  return { status: body.Status, answers: body.Answer ?? [] };
}

async function httpWithPinnedAddress(host, path, address, method) {
  const args = [
    "-s",
    "-S",
    "-m",
    "20",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "--resolve",
    `${host}:443:${address}`,
  ];
  if (method)
    args.push("-X", method, "-H", "content-type: application/json", "-d", "{}");
  args.push(`https://${host}${path}`);
  try {
    const { stdout } = await run("curl", args);
    return stdout.trim();
  } catch (error) {
    return `curl ${error.code ?? "error"}`;
  }
}

console.log(`domain: ${domain}\n`);

const ns = await dns(domain, "NS");
const nameservers = ns.answers.map((answer) => answer.data);
console.log(
  nameservers.length
    ? `nameservers: ${nameservers.join(", ")}`
    : "nameservers: none resolved yet (delegation not visible from here)",
);

let failures = 0;
for (const entry of hosts) {
  const { answers } = await dns(entry.host, "A");
  const address = answers.find((answer) => answer.type === 1)?.data ?? null;
  if (!address) {
    failures += 1;
    console.log(`FAIL ${entry.host}${entry.path} — ${entry.what}: no A record`);
    continue;
  }
  const status = await httpWithPinnedAddress(
    entry.host,
    entry.path,
    address,
    entry.method,
  );
  const ok = status === String(entry.expect);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${entry.host}${entry.path} — ${entry.what}: ` +
      `edge ${address}, http ${status}, expected ${entry.expect}`,
  );
}

console.log(
  failures === 0
    ? "\nall hosts answer as expected"
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
