# Security

The system holds two things worth stealing: Shopee credentials that can read every order of a shop,
and digital products that are the actual merchandise. Both are treated as secrets, not as data.

## Threat model

| Actor                                              | Capability                          | What stops them                                                                               |
| -------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Someone who saw an order number in a chat or email | Can type a real order number        | Second factor (buyer username, optionally phone suffix) + per-IP and per-order limits         |
| A buyer with a valid claim                         | Can share a download link           | Signed link with 10-minute TTL, per-claim download limit, claim can be revoked                |
| A buyer who already collected                      | Can replay an old link              | Download route re-checks claim status and revocation on every request                         |
| An attacker who finds the admin host               | Can try passwords                   | Rate limit, scrypt (N=2^15), uniform error message, audit log                                 |
| A viewer account                                   | Can read data                       | RBAC: writes require a role that has the permission                                           |
| A cross-site page                                  | Can make the browser send a request | CSRF header must echo a cookie value; CORS allow list; SameSite=Lax                           |
| A malicious upload                                 | Can ship an executable              | Extension allow list, size cap, private storage, `Content-Disposition: attachment`, `nosniff` |
| A spoofed push                                     | Can inject fake orders              | HMAC over the exact public URL + raw body, with the partner key                               |

## Authentication and sessions

- Password hashes: `scrypt` (N=32768, r=8, p=1, 32-byte key, 16-byte salt), parameters stored inside
  the hash so they can be raised later. Comparison is timing-safe. Minimum 10 characters.
- Login answers identically for unknown email and wrong password, and runs a hash even when the user
  does not exist, so response time does not reveal accounts.
- Session token: 32 random bytes, `base64url`, sent as an httpOnly, SameSite=Lax cookie, Secure by
  default (`SESSION_COOKIE_SECURE=true`). The database stores only `sha256(token)`.
- TTL 12 hours. Logout revokes the row. A password change revokes every session of that user.
- `GET /api/auth/me` returns the role's permission list, so the console hides actions it cannot take
  (the API still enforces them).

## Authorisation

Four roles, permissions in code:

| Permission                                        | OWNER | ADMIN | OPERATOR | VIEWER |
| ------------------------------------------------- | ----- | ----- | -------- | ------ |
| overview / monitoring read                        | ✓     | ✓     | ✓        | ✓      |
| store read                                        | ✓     | ✓     | ✓        | ✓      |
| store write (connect, disconnect, sync, branding) | ✓     | ✓     | —        | —      |
| catalogue read                                    | ✓     | ✓     | ✓        | ✓      |
| mapping write                                     | ✓     | ✓     | ✓        | —      |
| product read                                      | ✓     | ✓     | ✓        | ✓      |
| product write (digital products, assets, codes)   | ✓     | ✓     | —        | —      |
| order read / resync                               | ✓     | ✓     | ✓        | —      |
| claim read                                        | ✓     | ✓     | ✓        | ✓      |
| claim revoke / reissue                            | ✓     | ✓     | ✓        | —      |
| settings write                                    | ✓     | —     | —        | —      |
| audit read                                        | ✓     | ✓     | —        | —      |
| user write                                        | ✓     | —     | —        | —      |

Every admin route declares the permission it needs as a `preHandler`; a missing check fails closed
because the handler throws when no user is attached.

## CSRF

A mutating request that carries a session cookie must also send `x-csrf-token` equal to the readable
`qansa_csrf` cookie (constant-time comparison). A cross-site form cannot read that cookie, and a
cross-origin `fetch` needs a preflight the CORS allow list refuses. Login is exempt because no session
exists yet.

## Secrets at rest

| Secret                                      | Storage                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Shopee access token                         | `shopee_tokens.access_token_enc` — AES-256-GCM, random IV per write, version tag as AAD    |
| Shopee refresh token                        | Same column pattern; single use, replaced on every refresh                                 |
| Activation codes, credentials               | `digital_product_codes.secret_enc` — same cipher; the admin list shows a masked label only |
| Passwords                                   | scrypt, never reversible                                                                   |
| Partner key, encryption key, signing secret | Environment only; never in the database, never in the browser                              |
| Session token                               | Only its sha256                                                                            |

`APP_ENCRYPTION_KEY` must be 32 bytes of hex; the API refuses to boot otherwise. Rotating it requires
re-encrypting the token and code tables (documented in `docs/deployment.md`).

Never exposed to the browser: access or refresh tokens, the partner key, storage keys, code plaintexts
before a claim, `delivery_logs.reference` values that point at storage.

## Push verification

`HMAC-SHA256(partner_key, public_url + raw_body)`, compared timing-safe against the `Authorization`
header, with the console test key as an alternate. The raw bytes are preserved by a custom JSON parser
so a re-serialised body cannot silently break the signature. Without `SHOPEE_PUSH_URL`, verification
is skipped **only** outside production and `monitoring.webhooks.configured` reports `false`.

## Claim abuse protection

- Verification requires the buyer username (and the last four phone digits under the stricter policy).
- Failures are counted per IP (default 8/hour) and per order (default 12/hour) before the check runs;
  the counters live in `claim_attempts`, so they survive restarts and work across API replicas.
- Every attempt is logged with order number, IP, user agent and reason.
- Sessions are 30 minutes, httpOnly, scoped to one order; the token is stored hashed.
- Reveals are capped per claim (`max_deliveries`); file downloads are capped separately.
- Claim, download and verify routes are rate limited at the Fastify layer as a second line.

## Downloads

- The link carries `{claim, fulfilment, exp}` signed with `DOWNLOAD_SIGNING_SECRET`.
- On every request the API re-checks: signature, expiry, claim status (revoked/expired), fulfilment
  status, and the download counter.
- Files are streamed from a private volume; the response sets `content-disposition: attachment`,
  `cache-control: private, no-store` and `x-content-type-options: nosniff`.
- The storage key is never sent to the client; path traversal is blocked by resolving under the root
  and refusing anything that escapes it.

## Uploads

- Multipart limit: one file, 50 MB.
- Extension allow list (`pdf`, `zip`, images, office formats, media, plain text) plus a content type
  derived from the extension, not from the client.
- The stored name is sanitised and prefixed with a UUID inside a date folder; the original name is
  kept only as a label.

## Transport and headers

- Helmet on the API; the web app sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
  and `Permissions-Policy` for every route.
- TLS terminates at nginx or the Cloudflare tunnel; the containers speak HTTP on the docker network.
- `trustProxy` is on so rate limits and logs see the real client IP behind the proxy.

## Audit

`audit_logs` records every administrative action with actor, action, target, metadata and IP: store
connect/disconnect/authorize, mapping changes, product changes, code imports, claim revocations,
reissues, settings changes, order resync, logins. `order_events` records every pipeline decision,
including the ones that did nothing (`STATE_HELD`) and why.

Each entry carries `seq`, `prev_hash` and `entry_hash`. The hash covers the previous entry's hash plus
a canonical form of the row (sorted metadata keys, ISO timestamp), so editing a row, deleting one, or
rewriting a sequence number breaks the chain and the next verification reports the first broken
sequence. Rows written before the chain existed carry no hash; verification reports them as
`unhashed` and starts at the first hashed row, rather than failing forever or pretending to cover them.
The console checks it from **Keamanan**, and `GET /api/admin/security/audit-chain` returns the result
for monitoring.

## Two-factor authentication

TOTP (RFC 6238, SHA-1, 6 digits, 30 seconds) is implemented in `packages/core/src/totp.ts` rather
than pulled in as a dependency, and verified by the RFC's own test vectors.

- The secret is stored encrypted with `APP_ENCRYPTION_KEY`, so a database dump alone does not yield a
  working authenticator seed.
- Enrolment only completes after the user proves the authenticator works by entering a valid code.
- Ten recovery codes are generated at that moment, shown once, and stored as hashes. Each is consumed
  on use and cannot be replayed.
- A login with 2FA enabled returns a challenge instead of a session: a row in `login_challenges` with
  a hashed token, a five minute TTL, single use, and a five attempt limit. A stolen cookie from that
  stage is worthless after the real login completes.
- Disabling 2FA requires the account password, and every step is audited.

## Console hardening

- `ADMIN_IP_ALLOWLIST` accepts addresses and CIDR blocks for IPv4 and IPv6. When set, console calls
  from anywhere else get 403. The Shopee push endpoint and the public claim routes are exempt,
  because their callers are Shopee and buyers.
- `docker/nginx.conf` adds `limit_req` zones for the claim and console hostnames and the standard
  security headers, for deployments that terminate TLS there instead of at Cloudflare.
- Per-route rate limits: login 10 per 5 minutes, 2FA challenge 20 per 5 minutes, manual verification
  request 8 per 10 minutes, global 240 per minute.

## Retention

`RETENTION_SWEEP` runs daily in the worker and is also a console button. It removes expired claim
sessions, expired console sessions, expired login challenges, webhook bodies older than 90 days and
succeeded jobs older than 30 days, and it expires manual requests nobody answered. Orders, claims,
fulfilments, delivery logs and audit rows are never deleted: the financial and support record stays
complete. Dead-letter jobs are kept, because they are the only evidence of a failure.

## Key rotation

`POST /api/admin/security/rotate-key` re-encrypts Shopee access and refresh tokens, activation codes
and 2FA secrets from `APP_ENCRYPTION_KEY_OLD` to `APP_ENCRYPTION_KEY` in a single transaction. A dry
run reports the row counts and rolls everything back, so the procedure can be rehearsed. A failure
mid-run leaves every row on the old key: the service keeps working instead of half-rotating.

## Object storage

Digital assets can live on local disk or on any S3-compatible bucket (`ASSET_STORE=s3`). The signer is
implemented directly on the S3 REST API with SigV4, so no SDK ships in the image. Downloads are never
served from a public bucket URL: the API checks the claim and the signature first and then proxies the
object, so revoking a claim takes effect immediately.

## Manual verification

The phone factor depends on what Shopee returns, and some orders carry no phone at all. The buyer is
never left without a path: they can file a manual request, an operator checks the order out of band,
and approval opens a time-boxed window in which the username alone is accepted for that one order. The
buyer still has to match the buyer username, the order still has to be paid and claimable, every step
is audited, and the window is closed by the retention sweep once it passes.

## Known gaps

| Gap                                               | Impact                                              | Mitigation path                                            |
| ------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| WAF is deployment-side                            | Volumetric abuse reaches Fastify if exposed directly | Cloudflare in front (recommended), or nginx `limit_req`    |
| Codes are revealed once, then stored by the buyer | Cannot be recalled                                  | Standard for licence keys; revocation stops future reveals |
| Single logical encryption key                      | One rotation event for everything                   | Rotation is implemented; key ids would allow a staged run  |
| Audit chain is tamper-evident, not tamper-proof   | Someone with database write access can rewrite all  | Ship the head hash to an append-only store if needed       |
| Manual approval depends on operator judgement     | A careless operator can approve the wrong person    | Reviewed by role, time-boxed, fully audited                |

## Checklist before going live

- [ ] `APP_ENCRYPTION_KEY` and `DOWNLOAD_SIGNING_SECRET` generated with `openssl rand -hex 32`
- [ ] `SESSION_COOKIE_SECURE=true` and HTTPS on every hostname
- [ ] `SHOPEE_GATEWAY_MODE=live`, partner key in the environment only
- [ ] `SHOPEE_PUSH_URL` set to the exact registered URL
- [ ] `EXTRA_ORIGINS` empty (only claim/admin should be allowed)
- [ ] Owner password rotated after the first login
- [ ] PostgreSQL not published publicly (`127.0.0.1` binding in compose)
- [ ] Backups of the database and the uploads volume tested with a restore
- [ ] `curl -s https://api.qansa.web.id/health` shows the expected mode
