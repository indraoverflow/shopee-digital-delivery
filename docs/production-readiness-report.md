# Production readiness report

Audit date: 2026-11-13. Repository `indraoverflow/shopee-digital-delivery` at commit `3f12335`, plus the
changes listed at the end of this file. Domains: `claim.qansa.web.id`, `admin.qansa.web.id`,
`api.qansa.web.id`.

Classification used throughout: **CRITICAL**, **HIGH**, **MEDIUM**, **LOW**, **VERIFIED**,
**EXTERNAL DEPENDENCY**.

## 1. Repository audit

Monorepo, pnpm workspaces, Node 22+.

| Area                        | State                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `apps/api`                  | 49 routes, Zod at every boundary, helmet, CORS allow list, per-route rate limits    |
| `apps/web`                  | Buyer portal + 14 admin pages, runtime proxy to the API (no build-time API URL)     |
| `apps/worker`               | Queue consumer: order pipeline, product sync, reconcile, retention, shipments       |
| `packages/core`             | Pure rules: state machine, eligibility, mapping, crypto, TOTP, audit chain, IP list |
| `packages/db`               | Drizzle schema, 25 tables, SQL migrations, pglite test harness                      |
| `packages/services`         | Domain logic shared by API and worker                                               |
| `packages/shopee-adapter`   | Gateway interface, live implementation, fixture implementation                      |
| `vendor/shopee-integration` | Signed client, OAuth, push signature, SDK helpers (submodule, v0.3.0)               |
| `docker`, `scripts`         | Compose stack, nginx (optional profile), preflight, smoke, backup, S3 check         |

Nothing was rebuilt and no functionality was rewritten. The audit added tests, a backup script, three
documents and one alert-threshold fix.

## 2. Test execution results

Run on the audit machine, not taken from earlier reports.

| Command                                      | Result                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`             | lockfile current, supply-chain policy check passed                                                 |
| `pnpm test`                                  | 255 passed / 22 files at audit time; **256 / 23 files** after the store-isolation test added below |
| `pnpm typecheck`                             | clean, every package and app                                                                       |
| `pnpm -r build`                              | vendor, API, worker, Next.js production build all Done                                             |
| `node --env-file=.env scripts/smoke.mjs`     | 29 checks, **PASS** against the public hostnames                                                   |
| `node --env-file=.env scripts/preflight.mjs` | 24 checks: 23 ok, 1 warning, 0 failures                                                            |
| `pnpm audit`                                 | 0 advisories (info/low/moderate/high/critical all zero)                                            |

The single preflight warning is `SHOPEE_GATEWAY_MODE=fixture`, which is accurate: no live partner
credentials exist.

## 3. Implementation status

Verified by running the journey against the deployed stack, not by reading code.

| Capability                                                 | Status                        | Evidence                                                                                                           |
| ---------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Push received at `https://api.qansa.web.id/webhook/shopee` | VERIFIED                      | signed push accepted, forged push rejected 401                                                                     |
| Signature verification                                     | VERIFIED                      | HMAC-SHA256 over URL + raw body, hex, constant-time compare; alternate test-push key supported                     |
| Order fetched and persisted                                | VERIFIED                      | `runOrderSync` persists paid and unpaid orders with the right states                                               |
| Variation identified, mapping resolved                     | VERIFIED                      | pipeline tests, quantity multiplier included                                                                       |
| Fulfillment created, order claimable                       | VERIFIED                      | pipeline tests; live order `260101PXL0001` reached `CLAIMABLE`                                                     |
| Buyer verification                                         | VERIFIED                      | live claim through `claim.qansa.web.id` (username policy, phone suffix optional per store)                         |
| Delivery: code, file, link, credentials, instructions      | VERIFIED                      | code path exercised live; other kinds covered by claim tests                                                       |
| Delivery recorded                                          | VERIFIED                      | `delivery_logs`, `DELIVERY_REVEALED` event, audit row                                                              |
| Duplicate push                                             | VERIFIED                      | second signed push answered `duplicate`, no second order                                                           |
| Duplicate order / re-sync                                  | VERIFIED                      | idempotent upserts, `STATE_HELD` events when a late push would drag a claimed order back                           |
| Cancelled order                                            | VERIFIED                      | Shopee `CANCELLED`/`IN_CANCEL`/`TO_RETURN` revoke fulfilments **and** claims, state → `CANCELLED`                  |
| Refunded order                                             | VERIFIED by the same path     | refunds arrive as `TO_RETURN` / `CANCELLED` in the order status                                                    |
| Unmapped product                                           | VERIFIED                      | order goes `VALIDATED` with `UNMAPPED` lines; monitoring raises `UNMAPPED_LISTINGS`                                |
| Multiple variations, multiple quantities                   | VERIFIED                      | one fulfilment per mapped line, quantity multiplier applied                                                        |
| Empty activation code pool                                 | VERIFIED                      | `OUT_OF_STOCK`, notified, claim refuses without burning the claim                                                  |
| Expired claim                                              | VERIFIED                      | deadline sweep expires fulfilments; session TTL enforced server-side                                               |
| Revoked claim                                              | VERIFIED                      | every reveal refused after revoke, reissue path exists                                                             |
| Reconciliation after a missing push                        | VERIFIED                      | `runOrderSync` window picks orders up; live reconcile observed filling `ORDER_SYNCED`                              |
| Shipment back to Shopee                                    | VERIFIED against fixture only | `SHIP_CONFIRMED` with resi; live unproven (see 4)                                                                  |
| Store isolation                                            | VERIFIED                      | new test: store B maps an item, store A's order with the same item/model ids yields no fulfilment and cannot claim |

## 4. Live Shopee integration status

**EXTERNAL DEPENDENCY** — no partner credentials were available, so no live call was made and none is
claimed. What was verified:

- Hosts: production and both sandbox names answer the Shopee API error shape; the two sandbox names
  resolve to the same IP, so the "wrong sandbox host" suspicion is unfounded.
- OAuth paths, token exchange, refresh-with-rotation and push signature match the documented scheme and
  the vendored client's tested implementation.
- The legacy `SHOPEE_GATEWAY_MODE=fixture` store is labelled SIMULATED everywhere in the UI.

Unproven until credentials exist: whether the approved app carries logistics permission, and whether
Shopee accepts a platform-generated resi on jasa kirim toko. `docs/live-shopee-checklist.md` is the
ordered procedure to close this, including the one step that cannot be skipped: confirm in the Seller
Centre that the order really moved to **Dikirim**.

## 5. End-to-end validation results

The live journey, run today against the public stack:

1. Buyer claimed `260101PXL0001` at `https://claim.qansa.web.id` with the username policy.
2. The fulfilment became `CLAIMED`, the order `COMPLETED`, and the code was revealed once.
3. The shipment job ran on the first attempt and `shopee_status` became `SHIPPED` with resi
   `DIGITAL-260101PXL0001`, `actorType SYSTEM` in the audit log.
4. Monitoring went to `awaitingShipment: 0`, alerts empty.

The negative paths were exercised too: wrong username, unpaid order, wrong phone suffix, forged push,
replayed push, unknown order number, claim without a resi (422), claim after revoke.

## 6. Security findings

| Finding                                                            | Class                        | Note                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Password hashing with scrypt, timing-safe compares                 | VERIFIED                     |                                                                                                       |
| Session cookie HttpOnly/SameSite, `Secure` in production           | VERIFIED                     |                                                                                                       |
| CSRF token required on mutations, tested                           | VERIFIED                     |                                                                                                       |
| RBAC with 5 roles and per-route permissions                        | VERIFIED                     | viewer refused on write routes (tested)                                                               |
| TOTP second factor, recovery codes single-use                      | VERIFIED                     |                                                                                                       |
| Shopee tokens and activation codes encrypted at rest (AES-256-GCM) | VERIFIED                     | key rotation endpoint with dry run                                                                    |
| Signed, expiring download links bound to a claim                   | VERIFIED                     | shared links stop working after revoke                                                                |
| Claim enumeration protection                                       | VERIFIED                     | unknown order and wrong buyer answer identically; attempts rate-limited per IP and per order          |
| Rate limiting                                                      | VERIFIED (app level)         | claim verify 12/min, login 10/5min, claim request 8/10min, webhook 600/min                            |
| SQL injection                                                      | VERIFIED                     | Drizzle parameterised queries throughout; no string-built SQL                                         |
| XSS                                                                | VERIFIED for output encoding | React escaping, no `dangerouslySetInnerHTML` in the app                                               |
| Audit log integrity                                                | VERIFIED                     | hash chain per `seq`, tamper detected by test and by preflight                                        |
| Secrets in logs or responses                                       | VERIFIED                     | no token, code or key printed; errors carry codes, not payloads                                       |
| Dependency vulnerabilities                                         | VERIFIED                     | `pnpm audit`: 0                                                                                       |
| 2FA not enabled on the only owner account                          | **HIGH**                     | operational, must be switched on before real traffic                                                  |
| `ADMIN_IP_ALLOWLIST` empty                                         | **MEDIUM**                   | console reachable from any IP; set it if the operator has a fixed one                                 |
| No `Content-Security-Policy` on the web app                        | **MEDIUM**                   | X-Frame-Options DENY and nosniff are present; CSP is the remaining hardening step                     |
| nginx rate limits are not in the deployed path                     | **LOW**                      | the tunnel targets the app ports directly; app-level limits still apply; nginx is an optional profile |

## 7. Infrastructure findings

| Finding                                                       | Class                        | Note                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose stack: postgres, migrate (run-once), api, worker, web | VERIFIED                     | api/web healthy, worker up, migrate exits 0                                                                                                                                            |
| Restart policies                                              | VERIFIED                     | `unless-stopped` on long-running services, `no` on migrate                                                                                                                             |
| Health checks                                                 | VERIFIED                     | `pg_isready`, api `/health`, web `/`; worker relies on queue metrics                                                                                                                   |
| Postgres bound to `127.0.0.1:55433`                           | VERIFIED                     | not exposed publicly                                                                                                                                                                   |
| Migrations run before api starts                              | VERIFIED                     | `depends_on` with `service_completed_successfully`                                                                                                                                     |
| Container hardened (non-root, production build)               | VERIFIED                     | multi-stage images, `NODE_ENV=production`                                                                                                                                              |
| Cloudflare Tunnel                                             | VERIFIED                     | three hostnames 200, origin only reachable through the tunnel                                                                                                                          |
| Backups                                                       | **was MEDIUM, now VERIFIED** | `scripts/backup.sh` dumps, lists the dump to prove it is readable, archives uploads and copies the key file; a restore into a scratch database recovered 25 tables and the live orders |
| Backup schedule                                               | **MEDIUM**                   | script exists and works, nothing runs it on a schedule yet                                                                                                                             |
| Logging                                                       | VERIFIED                     | pino JSON, level per env, no secrets                                                                                                                                                   |
| Monitoring                                                    | VERIFIED                     | queue depth, dead letter, token expiry, webhook health, unmapped listings, awaiting shipment                                                                                           |

## 8. Domain configuration findings

| Item                                                          | Class    | Note                                                                                                    |
| ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| No `qansa.id` anywhere in code, compose, docs or env examples | VERIFIED | grep over the whole tree; every reference is `qansa.web.id`                                             |
| Canonical domains in `.env.example`                           | VERIFIED | claim/admin/api on `qansa.web.id`                                                                       |
| CORS allow list matches the three hostnames                   | VERIFIED | `EXTRA_ORIGINS` covers local dev                                                                        |
| Cookies survive only on https                                 | VERIFIED | `SESSION_COOKIE_SECURE=true`; documented so nobody debugs a "failed login" that is a plain-http browser |
| Hostname boundaries                                           | VERIFIED | portal, console and API are separate origins; the browser only talks first-party through the web proxy  |

## 9. Remaining blockers

1. **EXTERNAL DEPENDENCY** — partner credentials and app approval, then the seven-step sequence in
   `docs/live-shopee-checklist.md`. Until step 6 there, the live integration is unproven.
2. **HIGH** — enable 2FA on the owner account and record the recovery codes.
3. **MEDIUM** — schedule `scripts/backup.sh` (cron or systemd timer) and keep a copy off the host.
4. **MEDIUM** — add a Content-Security-Policy to the web app.
5. **MEDIUM** — set `ADMIN_IP_ALLOWLIST` if the operator IP is stable.
6. **LOW** — decide whether the deployment keeps nginx in front (rate shaping and one place for TLS) or
   removes it and relies on app-level limits.
7. **LOW** — confirm the resi format accepted by jasa kirim toko; if Shopee refuses placeholders, run
   shipping manually or feed real resi numbers.

## 10. Production readiness assessment

- **Ready for a supervised pilot with real buyers, on fixture shipping**: yes. Claim journey, delivery,
  revocation, revocation-on-cancel, monitoring and audit are proven end to end.
- **Ready to run live Shopee fulfilment unattended**: **no**. The live path is implemented and tested
  against a faithful fixture, but no real order has passed through it. Claiming readiness without that
  would be a guess, and this document does not make it.
- **Blocking for production, beyond credentials**: 2FA on the owner account, a scheduled backup.

## Changes made during this audit

- `packages/services/test/isolation.test.ts` — proves one store's mapping can never deliver another
  store's order (the §5 requirement that had no test).
- `scripts/backup.sh` — dump, verify, archive uploads, copy the key file, prune; restore verified into a
  scratch database.
- `apps/api/src/routes/overview.ts` — `WEBHOOK_SIGNATURE` now needs 3 rejections in 15 minutes, so the
  preflight probe no longer leaves a red alarm for a day.
- `apps/api/test/monitoring.test.ts` — threshold behaviour, including yesterday's probes.
- Documentation: this report, `docs/live-shopee-checklist.md`, `docs/remaining-work.md`, README and
  implementation report test counts, deployment backup section.
