# Implementation report

Written after the stack was built, tested and run. Numbers below are from the actual runs, not from
the plan.

## 1. Architecture overview

```
Shopee ──push──▶ API (/webhook/shopee) ──▶ jobs table ──▶ worker ──▶ Shopee Order API
   ▲                                              │
   └────── REST (signed) ◀── shopee-adapter ◀─────┘
                                    │
Buyer ──▶ claim.qansa.web.id ──▶ Next ──▶ API ──▶ PostgreSQL + private asset volume
Admin ──▶ admin.qansa.web.id ──▶ Next ──┘
```

- **Two apps, three runtimes**: `apps/web` (Next 16), `apps/api` (Fastify 5), `apps/worker` (queue
  consumer). The API and worker share the same image and the same service layer.
- **Domain logic** lives in `packages/services`; pure rules (state machine, eligibility, mapping,
  verification, crypto) in `packages/core`, which has no I/O.
- **Shopee protocol** stays in the vendored `shopee-integration` submodule (pinned at `v0.2.0`,
  commit `9e72ad7`), behind a `ShopeeGateway` interface with a live and a fixture implementation.
- **Postgres is the only stateful service**: queue, sessions, claims and delivery logs all live there.
  No Redis, no broker.

## 2. Repository structure

```
apps/api        Fastify: 40 routes, auth, webhook, bootstrap entry
apps/worker     queue loop, handlers, maintenance schedule
apps/web        Next.js: claim portal + admin console, host routing in proxy.ts
packages/core   order state machine, eligibility, mapping, claim rules, crypto
packages/db     22-table Drizzle schema, 1 SQL migration, pglite test harness, seed
packages/services  pipeline, claims, sync, queue, settings, audit, asset storage
packages/shopee-adapter  gateway interface, live + fixture implementations
vendor/shopee-integration  git submodule (signed client, OAuth, push verification)
docker/         api.Dockerfile, web.Dockerfile, nginx.conf
docs/           8 documents + 5 screenshots
scripts/smoke.mjs  end-to-end check against a running stack
```

## 3. Implemented features

| Area                                                                                             | Status                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Multi-store onboarding, OAuth URL + state, token refresh, disconnect, OAuth callback             | Implemented; live exchange untested (no credentials) |
| Fixture gateway for the whole flow, clearly labelled in the UI                                   | Implemented and verified                             |
| Product catalogue sync (items, variations, soft delete, stats, sync jobs)                        | Implemented and verified                             |
| Digital products: file/link/code/credentials/instructions, codes, assets, preview, archive       | Implemented and verified                             |
| Mapping: per variation and per listing, multiplier, ambiguity detection, unmapped reporting      | Implemented and verified                             |
| Order pipeline: push, dedupe, idempotent upsert, eligibility, fulfilments, state machine, events | Implemented and verified                             |
| Reconciliation by `update_time`, scheduled and manual                                            | Implemented and verified                             |
| Buyer verification (username, optional phone suffix), sessions, rate limits, attempt log         | Implemented and verified                             |
| Delivery: expiring signed file links, external links, codes with atomic assignment, limits       | Implemented and verified                             |
| Admin: overview, stores, catalogue, products, orders, claims, monitoring, settings, audit        | Implemented and verified                             |
| Revoke / reissue / expiry sweep                                                                  | Implemented and verified                             |
| Worker: retries, dead letters, stale-lock recovery, token refresh, maintenance                   | Implemented and verified                             |
| Two-factor authentication (TOTP, recovery codes, login challenge)                                | Implemented and verified                             |
| Console user management (create, role, deactivate, password reset, last-owner guard)             | Implemented and verified                             |
| Manual verification queue for buyers Shopee's masked phone strands                               | Implemented and verified                             |
| Hash-chained audit log with a verify endpoint                                                    | Implemented and verified                             |
| Retention sweep as a worker job and a console action                                             | Implemented and verified                             |
| Encryption key rotation with dry run                                                             | Implemented and verified against pglite              |
| S3-compatible object storage (SigV4 implemented directly)                                        | Implemented, verified against a signing fake         |
| Outbound notification webhook with HMAC                                                          | Implemented and verified                             |
| Optional console IP allow list (IPv4/IPv6 CIDR)                                                  | Implemented and verified                             |
| nginx rate-limit zones and security headers                                                      | Implemented, `nginx -t` validated                    |

Not implemented, on purpose: email/SMTP delivery (the webhook covers Slack, n8n and WhatsApp),
additional marketplaces, and a WAF (that belongs in front of the stack, not inside it).

## 4. Database

25 tables across two migrations (`0000_init.sql`, `0001_two_factor_manual_audit_chain.sql`), applied
against PostgreSQL 17 and against pglite in tests.

Identity: `users`, `sessions`, `login_challenges`. Shopee: `shopee_stores`, `shopee_tokens`, `shopee_products`,
`shopee_variations`, `product_mappings`. Content: `digital_products`, `digital_product_assets`,
`digital_product_codes`. Orders: `orders`, `order_items`, `order_events`, `fulfillments`,
`claim_sessions`, `claims`, `claim_attempts`, `delivery_logs`, `claim_requests`. Operations: `jobs`, `webhook_events`,
`sync_jobs`, `audit_logs`, `system_settings`.

Constraints that carry the correctness: `(store_id, order_sn)`, `(order_id, line_key)`,
`(order_item_id, digital_product_id)`, one live mapping per variation/listing (partial unique), one
`webhook_events.body_hash`, one pending job per dedupe key.

## 5. API endpoints

49 routes across public, claim, webhook, auth (including 2FA), users, manual verification, security,
stores, catalogue, digital products, orders, claims, overview, monitoring and settings. Full table with
payloads in `docs/api-reference.md`.

## 6. Test results

```
packages/core        74 tests   state machine, eligibility, mapping, verification, crypto, TOTP, audit chain, IP allow list
packages/db           7 tests   migrations, constraints, cascades, partial unique indexes
packages/services    91 tests   pipeline, claims, shipping, 2FA enrolment/login, users, manual verification, retention, rotation, S3, notifications
apps/api             66 tests   HTTP journey, 2FA login, users, manual queue, security, monitoring thresholds, shipping
apps/worker          12 tests   queue dedupe, retry/dead letter, stale locks, handlers, scheduling, shipment jobs
apps/web              5 tests   the runtime API proxy
                    ─────────
                    255 tests   all passing
```

Also run and passing:

- `pnpm -r typecheck` — every package and app, strict mode.
- `npx eslint .` — no errors, no warnings.
- `pnpm -r build` — vendor client, API and worker bundles, Next.js production build (Node 22).
- `scripts/smoke.mjs` — 30 checks against a live API + worker + PostgreSQL 17: store connect, product
  sync through the queue, mapping, order sync, buyer verification, code reveal, claim listing, overview,
  monitoring, 2FA status, audit chain, users, retention, notification test, manual queue.
- `scripts/verify-s3.ts` — 6 checks against a real S3-compatible server (SeaweedFS): bucket, upload,
  byte-for-byte round trip, stream, delete. The hand-written SigV4 signer is exercised end to end.
- Browser walkthrough — the claim portal verified a real order and displayed the activation code; the
  console logged in and rendered overview, catalogue, orders and monitoring with live data.
- `docker compose up -d --build` — postgres, one-shot migrate, api, worker, web all healthy.

## 7. Security implementation

scrypt passwords; optional TOTP second factor with hashed single-use recovery codes and a short-lived,
single-use login challenge; console user management with a last-owner guard and session revocation on
deactivation or password reset; opaque session tokens stored as sha256; CSRF double submit on every
mutation; RBAC with four roles enforced per route; AES-256-GCM for Shopee tokens, activation codes and
2FA secrets, with a transactional rotation procedure and a dry run; HMAC push verification over the raw
body; order-scoped claim sessions; per-IP and per-order attempt limits in the database; signed expiring
download links re-checked against the claim on every fetch; upload extension allow list and
path-traversal guard; Helmet and explicit headers; optional console IP allow list for IPv4/IPv6 CIDR;
nginx rate-limit zones; hash-chained audit log with a verification endpoint. Residual gaps and
mitigations listed in `docs/security.md`.

## 8. Deployment

`docker compose up -d --build` with a filled `.env` brings up the whole stack; the `migrate` service
applies migrations and seeds the owner before the API starts. Three hostnames (`claim.`, `admin.`,
`api.qansa.web.id`) served by nginx or a Cloudflare tunnel. Backups cover the database and the uploads
volume, plus the encryption key. Checklist in `docs/deployment.md`.

## 9. Remaining external dependencies

1. Shopee partner approval and `partner_id`/`partner_key` for the target environment.
2. Registered push URL and redirect URL in the Shopee console.
3. DNS + TLS for the three hostnames.

## 10. Known limitations

- No live Shopee round trip was executed here; the live path is implemented and type-checked but only
  fixture-tested. First real order must be watched in Monitoring.
- The phone factor depends on Shopee returning a masked phone; without it the strict policy fails
  closed and the buyer has to be verified manually.
- One file per file-product, 50 MB. Object storage is implemented and verified against a real
  S3-compatible server, but the default deployment still uses the local volume.
- Notifications are a single outbound webhook; there is no SMTP client.
- 2FA is per account and opt-in, not enforced. A deployment that needs it can require enrolment by
  policy, but there is no "all users must" switch yet.
- Next 16.4.6 fails to prerender on Node 26; `.nvmrc` pins Node 22 and the images use Node 22.

## 11. Production readiness

Ready to run: schema, migrations, authentication with optional 2FA, RBAC, the pipeline, delivery,
manual verification, monitoring, retention, key rotation, backups and deployment are implemented and
tested (213 automated tests, 30 smoke checks, 6 object-storage checks), and the stack boots healthy
under compose.

What still stands between this and taking real orders is external: Shopee partner credentials, the
registered push and redirect URLs, and DNS/TLS. Nothing in the repository blocks on them, and the first
live order should be watched in Monitoring with `SHOPEE_GATEWAY_MODE=live`.

Not yet proven: a real Shopee order. Treat the first live week as a supervised rollout — keep the
fixture store for demos, connect one real store, watch Monitoring for `webhook_events` with
`signature_valid = true`, then confirm one paid order end to end before enabling a second store.
