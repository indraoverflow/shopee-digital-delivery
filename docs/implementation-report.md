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

| Area | Status |
|---|---|
| Multi-store onboarding, OAuth URL + state, token refresh, disconnect, OAuth callback | Implemented; live exchange untested (no credentials) |
| Fixture gateway for the whole flow, clearly labelled in the UI | Implemented and verified |
| Product catalogue sync (items, variations, soft delete, stats, sync jobs) | Implemented and verified |
| Digital products: file/link/code/credentials/instructions, codes, assets, preview, archive | Implemented and verified |
| Mapping: per variation and per listing, multiplier, ambiguity detection, unmapped reporting | Implemented and verified |
| Order pipeline: push, dedupe, idempotent upsert, eligibility, fulfilments, state machine, events | Implemented and verified |
| Reconciliation by `update_time`, scheduled and manual | Implemented and verified |
| Buyer verification (username, optional phone suffix), sessions, rate limits, attempt log | Implemented and verified |
| Delivery: expiring signed file links, external links, codes with atomic assignment, limits | Implemented and verified |
| Admin: overview, stores, catalogue, products, orders, claims, monitoring, settings, audit | Implemented and verified |
| Revoke / reissue / expiry sweep | Implemented and verified |
| Worker: retries, dead letters, stale-lock recovery, token refresh, maintenance | Implemented and verified |

Not implemented, on purpose: multi-user invitation flow beyond seeded accounts, 2FA, S3 storage
backend, additional marketplaces, email notifications.

## 4. Database

22 tables, one migration (`0000_init.sql`), applied against PostgreSQL 17 and against pglite in tests.

Identity: `users`, `sessions`. Shopee: `shopee_stores`, `shopee_tokens`, `shopee_products`,
`shopee_variations`, `product_mappings`. Content: `digital_products`, `digital_product_assets`,
`digital_product_codes`. Orders: `orders`, `order_items`, `order_events`, `fulfillments`,
`claim_sessions`, `claims`, `claim_attempts`, `delivery_logs`. Operations: `jobs`, `webhook_events`,
`sync_jobs`, `audit_logs`, `system_settings`.

Constraints that carry the correctness: `(store_id, order_sn)`, `(order_id, line_key)`,
`(order_item_id, digital_product_id)`, one live mapping per variation/listing (partial unique), one
`webhook_events.body_hash`, one pending job per dedupe key.

## 5. API endpoints

40 routes across public, claim, webhook, auth, stores, catalogue, digital products, orders, claims,
overview, monitoring and settings. Full table with payloads in `docs/api-reference.md`.

## 6. Test results

```
packages/core        40 tests   state machine, eligibility, mapping, verification, crypto
packages/db           7 tests   migrations, constraints, cascades, partial unique indexes
packages/services    35 tests   product sync, order pipeline, claims, delivery, revocation, expiry
apps/api             28 tests   HTTP journey: login, store, sync, mapping, push, claim, monitoring
apps/worker          10 tests   queue dedupe, retry/dead letter, stale locks, handlers, scheduling
                    ─────────
                    120 tests   all passing
```

Also run and passing:

- `pnpm -r typecheck` — every package and app, strict mode.
- `npx eslint .` — no errors, no warnings.
- `pnpm -r build` — vendor client, API and worker bundles, Next.js production build (Node 22).
- `scripts/smoke.mjs` — 23 checks against a live API + worker + PostgreSQL 17: store connect, product
  sync through the queue, mapping, order sync, buyer verification, code reveal, claim listing, overview
  and monitoring.
- Browser walkthrough — the claim portal verified a real order and displayed the activation code; the
  console logged in and rendered overview, catalogue, orders and monitoring with live data.
- `docker compose up -d --build` — postgres, one-shot migrate, api, worker, web all healthy.

## 7. Security implementation

scrypt passwords; opaque session tokens stored as sha256; CSRF double submit on every mutation; RBAC
with four roles enforced per route; AES-256-GCM for Shopee tokens and activation codes; HMAC push
verification over the raw body; order-scoped claim sessions; per-IP and per-order attempt limits in the
database; signed expiring download links re-checked against the claim on every fetch; upload extension
allow list and path-traversal guard; Helmet and explicit headers; audit log for every administrative
action. Gaps and mitigations listed in `docs/security.md`.

## 8. Deployment

`docker compose up -d --build` with a filled `.env` brings up the whole stack; the `migrate` service
applies migrations and seeds the owner before the API starts. Three hostnames (`claim.`, `admin.`,
`api.qansa.web.id`) served by nginx or a Cloudflare tunnel. Backups cover the database and the uploads
volume, plus the encryption key. Checklist in `docs/deployment.md`.

## 9. Remaining external dependencies

1. Shopee partner approval and `partner_id`/`partner_key` for the target environment.
2. Registered push URL and redirect URL in the Shopee console.
3. DNS + TLS for the three hostnames.
4. A decision on object storage if the catalogue outgrows the local volume.

## 10. Known limitations

- No live Shopee round trip was executed here; the live path is implemented and type-checked but only
  fixture-tested. First real order must be watched in Monitoring.
- The phone factor depends on Shopee returning a masked phone; without it the strict policy fails
  closed.
- One file per file-product, 50 MB, local volume only.
- No 2FA, no invitation UI, no email notifications.
- Next 16.4.6 fails to prerender on Node 26; `.nvmrc` pins Node 22 and the images use Node 22.

## 11. Production readiness

Ready to run: schema, migrations, authentication, RBAC, the pipeline, delivery, monitoring, backups and
deployment are implemented and tested, and the stack boots healthy under compose.

Not yet proven: a real Shopee order. Treat the first live week as a supervised rollout — keep the
fixture store for demos, connect one real store, watch Monitoring for `webhook_events` with
`signature_valid = true`, then confirm one paid order end to end before enabling a second store.
