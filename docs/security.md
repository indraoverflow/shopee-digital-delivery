# Security

The system holds two things worth stealing: Shopee credentials that can read every order of a shop,
and digital products that are the actual merchandise. Both are treated as secrets, not as data.

## Threat model

| Actor | Capability | What stops them |
|---|---|---|
| Someone who saw an order number in a chat or email | Can type a real order number | Second factor (buyer username, optionally phone suffix) + per-IP and per-order limits |
| A buyer with a valid claim | Can share a download link | Signed link with 10-minute TTL, per-claim download limit, claim can be revoked |
| A buyer who already collected | Can replay an old link | Download route re-checks claim status and revocation on every request |
| An attacker who finds the admin host | Can try passwords | Rate limit, scrypt (N=2^15), uniform error message, audit log |
| A viewer account | Can read data | RBAC: writes require a role that has the permission |
| A cross-site page | Can make the browser send a request | CSRF header must echo a cookie value; CORS allow list; SameSite=Lax |
| A malicious upload | Can ship an executable | Extension allow list, size cap, private storage, `Content-Disposition: attachment`, `nosniff` |
| A spoofed push | Can inject fake orders | HMAC over the exact public URL + raw body, with the partner key |

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

| Permission | OWNER | ADMIN | OPERATOR | VIEWER |
|---|---|---|---|---|
| overview / monitoring read | ✓ | ✓ | ✓ | ✓ |
| store read | ✓ | ✓ | ✓ | ✓ |
| store write (connect, disconnect, sync, branding) | ✓ | ✓ | — | — |
| catalogue read | ✓ | ✓ | ✓ | ✓ |
| mapping write | ✓ | ✓ | ✓ | — |
| product read | ✓ | ✓ | ✓ | ✓ |
| product write (digital products, assets, codes) | ✓ | ✓ | — | — |
| order read / resync | ✓ | ✓ | ✓ | — |
| claim read | ✓ | ✓ | ✓ | ✓ |
| claim revoke / reissue | ✓ | ✓ | ✓ | — |
| settings write | ✓ | — | — | — |
| audit read | ✓ | ✓ | — | — |
| user write | ✓ | — | — | — |

Every admin route declares the permission it needs as a `preHandler`; a missing check fails closed
because the handler throws when no user is attached.

## CSRF

A mutating request that carries a session cookie must also send `x-csrf-token` equal to the readable
`qansa_csrf` cookie (constant-time comparison). A cross-site form cannot read that cookie, and a
cross-origin `fetch` needs a preflight the CORS allow list refuses. Login is exempt because no session
exists yet.

## Secrets at rest

| Secret | Storage |
|---|---|
| Shopee access token | `shopee_tokens.access_token_enc` — AES-256-GCM, random IV per write, version tag as AAD |
| Shopee refresh token | Same column pattern; single use, replaced on every refresh |
| Activation codes, credentials | `digital_product_codes.secret_enc` — same cipher; the admin list shows a masked label only |
| Passwords | scrypt, never reversible |
| Partner key, encryption key, signing secret | Environment only; never in the database, never in the browser |
| Session token | Only its sha256 |

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

## Known gaps

| Gap | Impact | Mitigation path |
|---|---|---|
| No 2FA on console accounts | A stolen password is enough | Add TOTP; the session table already supports revocation |
| No WAF in front of the API | Volumetric abuse reaches Fastify | Cloudflare in front, or nginx `limit_req` |
| Phone factor depends on Shopee's mask | Orders without a phone cannot use the strict policy | Fail closed (implemented); support flow for manual proof |
| No IP allow list for the console | Anywhere-access | Optional nginx allow list for `admin.` |
| Codes are revealed once, then stored by the buyer | Cannot be recalled | Standard for licence keys; revocation stops future reveals |
| Single shared encryption key | One rotation event for everything | Add a key id prefix to `v1.` and decrypt by id |
| Audit log is append-only by convention | A database owner can edit it | Ship to an append-only store if that threat matters |

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
