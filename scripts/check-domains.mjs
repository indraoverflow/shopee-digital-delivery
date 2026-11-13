#!/usr/bin/env node
/**
 * Probe the public hostnames a domain needs, from outside the machine's own DNS cache.
 *
 *   node scripts/check-domains.mjs example.com
 *   node scripts/check-domains.mjs qansa.web.id
 *
 * DNS is read through DNS-over-HTTPS so a resolver cache on this host cannot make a
 * half-finished migration look healthy. HTTP is checked for the exact status each
 * hostname is supposed to answer with.
 */

const domain = process.argv[2];
if (!domain) {
  console.error("usage: node scripts/check-domains.mjs <domain>");
  process.exit(2);
}

const hosts = [
  { host: `api.${domain}`, path: "/health", expect: 200, what: "API health" },
  { host: `api.${domain}`, path: "/ready", expect: 200, what: "database reachable" },
  { host: `sandbox-api.${domain}`, path: "/health", expect: 200, what: "sandbox API health" },
  { host: `claim.${domain}`, path: "/", expect: 200, what: "buyer portal" },
  { host: `admin.${domain}`, path: "/login", expect: 200, what: "operator console" },
];

async function dns(name, type) {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`,
    { headers: { accept: "application/dns-json" } },
  );
  const body = await response.json();
  return { status: body.Status, answers: body.Answer ?? [] };
}

async function head(url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return response.status;
  } catch (error) {
    return `ERR ${error.message}`;
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

for (const entry of hosts) {
  const { answers } = await dns(entry.host, "A");
  const address = answers.find((answer) => answer.type === 1)?.data ?? null;
  const status = await head(`https://${entry.host}${entry.path}`);
  const ok = status === entry.expect;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${entry.host}${entry.path} — ${entry.what}: ` +
      `dns ${address ?? "no A record"}, http ${status}, expected ${entry.expect}`,
  );
}
