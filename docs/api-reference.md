# API reference

Base URL: `https://api.qansa.web.id`. The web app calls the same routes through its
`/api/backend/*` proxy route handler, so browser requests are same-origin. The proxy reads `API_URL`
on every request: a Next rewrite would bake the build machine's value into the image.

Conventions:

- JSON in, JSON out. Errors are `{ "error": { "code": "...", "message": "...", "details": ... } }`.
- Validation failures are `422`; unknown routes `404`; unauthenticated `401`; wrong role `403`.
- Admin routes need the session cookie and, for mutations, `x-csrf-token` equal to the `qansa_csrf`
  cookie.
- Lists accept `page` (1-based) and `pageSize` (max 100) and answer
  `{ data, page, pageSize, total, hasMore }`.
- Money is a decimal string (`"55000.00"`), timestamps are ISO 8601 UTC.

## Public

| Method | Path                                 | Purpose                                                |
| ------ | ------------------------------------ | ------------------------------------------------------ |
| GET    | `/health`                            | Liveness, includes `gatewayMode` and `environment`     |
| GET    | `/ready`                             | Database probe, `503` when the database is unreachable |
| GET    | `/api/public/config`                 | Branding, claim limits, gateway mode                   |
| POST   | `/api/claim/verify`                  | Buyer verification (rate limited)                      |
| GET    | `/api/claim/session`                 | Items for the verified order                           |
| POST   | `/api/claim/fulfillments/:id/access` | Reveal one product                                     |
| POST   | `/api/claim/request`                 | Ask for manual verification (rate limited)             |
| POST   | `/api/claim/logout`                  | Drop the claim session                                 |
| GET    | `/api/claim/download/:token`         | Signed download                                        |
| POST   | `/webhook/shopee`                    | Shopee push receiver                                   |

### `POST /api/claim/verify`

```json
{
  "orderSn": "260101PXL0001",
  "buyerUsername": "rina_kurnia",
  "phoneSuffix": "2250"
}
```

`200` sets the `qansa_claim` cookie and returns `{ orderSn, expiresAt }`.

| Error code                                                 | Status | Meaning                                       |
| ---------------------------------------------------------- | ------ | --------------------------------------------- |
| `ORDER_NOT_FOUND`                                          | 404    | No such order in any connected store          |
| `USERNAME_MISSING` / `USERNAME_MISMATCH`                   | 400    | Second factor missing or wrong                |
| `PHONE_SUFFIX_INVALID` / `_MISMATCH` / `PHONE_UNAVAILABLE` | 400    | Strict policy could not be satisfied          |
| `ORDER_NOT_ELIGIBLE`                                       | 409    | Cancelled, refunded, or nothing left to claim |
| `ORDER_NOT_CLAIMABLE`                                      | 409    | Not yet paid, or no product mapped yet        |
| `TOO_MANY_ATTEMPTS`                                        | 429    | Per-IP or per-order window exhausted          |

### `POST /api/claim/request`

```json
{ "orderSn": "260101PXL0001", "buyerUsername": "rina_kurnia", "contact": "rina@example.com", "note": "nomor HP saya ganti" }
```

`201` when a request is created, `200` with `existing: true` when one is already waiting. An unknown
order and a wrong username both answer `404 ORDER_NOT_FOUND` with the same message: this endpoint must
not become an order-number oracle. Rate limited to 8 per 10 minutes per IP.

### `GET /api/claim/session`

```json
{
  "orderSn": "260101PXL0001",
  "buyerUsernameMasked": "rin******",
  "orderState": "FULFILLED",
  "storeLabel": "pixelbloomid",
  "expiresAt": "2026-11-12T17:40:00.000Z",
  "items": [
    {
      "fulfillmentId": "…",
      "productName": "E-Meterai 1 Lembar",
      "deliveryKind": "CODE",
      "quantity": 1,
      "status": "CLAIMABLE",
      "claimDeadline": "2026-12-12T17:10:00.000Z",
      "deliveriesUsed": 0,
      "deliveriesLeft": 3
    }
  ]
}
```

No code, no URL, no storage key appears here.

### `POST /api/claim/fulfillments/:id/access`

Returns `{ delivery: ... }`:

```json
{ "delivery": { "kind": "CODE", "code": "MTR-AAAA-1111", "instructions": "Tempel di halaman Peruri." } }
{ "delivery": { "kind": "FILE", "fileName": "panduan.pdf", "sizeBytes": 184320, "url": "https://api.qansa.web.id/api/claim/download/<token>", "expiresAt": "2026-11-12T17:30:00.000Z" } }
{ "delivery": { "kind": "LINK", "url": "https://drive.example.com/file" } }
{ "delivery": { "kind": "CREDENTIALS", "username": "…", "password": "…" } }
```

Errors: `ACCESS_REVOKED` (403), `CLAIM_EXPIRED` (410), `DELIVERY_LIMIT` (429), `OUT_OF_STOCK` (409),
`PRODUCT_NOT_READY` (409), `UNAUTHORIZED` (401, session gone).

### `POST /webhook/shopee`

Raw JSON body, `Authorization: <HMAC-SHA256(partner_key, public_url + raw_body)>`. Answers `200` fast:

```json
{ "ok": true, "queued": true }
{ "ok": true, "duplicate": true }
{ "ok": true, "ignored": true }
```

`401` when the signature does not match; the body is still recorded with `signature_valid = false`.

## Authentication

| Method | Path                 | Body                                                                     |
| ------ | -------------------- | ------------------------------------------------------------------------ |
| POST   | `/api/auth/login`    | `{ email, password }` → sets `qansa_session` (httpOnly) and `qansa_csrf` |
| GET    | `/api/auth/me`       | → `{ user: { id, email, name, role, permissions[] } }`                   |
| POST   | `/api/auth/logout`   | revokes the session                                                      |
| POST   | `/api/auth/password` | `{ currentPassword, newPassword }`, revokes all sessions                 |

Login is rate limited (10 per 5 minutes per IP) and answers `INVALID_CREDENTIALS` for both unknown
email and wrong password.

When the account has 2FA enabled, `/api/auth/login` answers `200` with
`{ mfaRequired: true, challengeToken, expiresAt }` and **no session cookie**.

| Method | Path                          | Body                                  | Notes                                                     |
| ------ | ----------------------------- | ------------------------------------- | --------------------------------------------------------- |
| POST   | `/api/auth/2fa/challenge`     | `{ challengeToken, token }`           | Exchanges a challenge for a session; 20 per 5 minutes      |
| GET    | `/api/auth/2fa`               | –                                     | `{ enabled, recoveryCodesRemaining }`                      |
| POST   | `/api/auth/2fa/enroll`        | –                                     | `{ secret, otpauth, issuer, account }`, unconfirmed         |
| POST   | `/api/auth/2fa/enroll/confirm`| `{ token }`                           | Enables 2FA, returns ten recovery codes exactly once       |
| POST   | `/api/auth/2fa/recovery-codes`| `{ token }`                           | Replaces every unused recovery code                        |
| POST   | `/api/auth/2fa/disable`       | `{ password }`                        | Requires the account password                              |

`MFA_INVALID` (401) carries `details.remaining`; `CHALLENGE_EXPIRED` (401) means start the login again.

## Stores

| Method | Path                                       | Permission    | Purpose                                                                          |
| ------ | ------------------------------------------ | ------------- | -------------------------------------------------------------------------------- |
| GET    | `/api/admin/stores`                        | `store:read`  | List with token expiry and order counts                                          |
| POST   | `/api/admin/stores`                        | `store:write` | `{ label, shopId, environment, brandName?, supportEmail?, verificationPolicy? }` |
| GET    | `/api/admin/stores/:id`                    | `store:read`  | Store, token expiry, order stats                                                 |
| PATCH  | `/api/admin/stores/:id`                    | `store:write` | Branding, verification policy, eligible statuses                                 |
| POST   | `/api/admin/stores/:id/authorize`          | `store:write` | Returns `{ url, simulated }` (OAuth consent)                                     |
| POST   | `/api/admin/stores/:id/authorize/simulate` | `store:write` | Fixture gateway only                                                             |
| POST   | `/api/admin/stores/:id/refresh`            | `store:write` | Refresh the token now                                                            |
| POST   | `/api/admin/stores/:id/disconnect`         | `store:write` | Delete tokens, mark `DISCONNECTED`                                               |
| GET    | `/api/integration/shopee/callback`         | public        | OAuth redirect target; validates signed state                                    |
| POST   | `/api/admin/stores/:id/sync/products`      | `store:write` | Queue a catalogue sync                                                           |
| POST   | `/api/admin/stores/:id/sync/orders`        | `store:write` | Queue a reconciliation sweep                                                     |
| GET    | `/api/admin/sync-jobs`                     | `store:read`  | Sync history, filterable by store and status                                     |
| GET    | `/api/admin/stores/token-health`           | `store:read`  | Mintes left per store token                                                      |

Sync responses: `{ queued: true, jobId, syncJobId }`, or `{ queued: true, message: "dijadwalkan ulang" }`
when an already queued job was pulled forward, or `{ queued: false, message: "sedang berjalan" }`.

## Catalogue and mapping

| Method | Path                                | Permission      | Notes                                                                                    |
| ------ | ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/admin/catalog`                | `catalog:read`  | `storeId`, `query`, `mapped=all\|mapped\|unmapped`, paging                               |
| GET    | `/api/admin/catalog/unmapped-count` | `catalog:read`  | Count of listings without a mapping                                                      |
| GET    | `/api/admin/mappings`               | `catalog:read`  | Flat list with product, variation and store labels                                       |
| POST   | `/api/admin/mappings`               | `mapping:write` | Upsert: `{ shopeeProductId, shopeeVariationId?, digitalProductId, quantityMultiplier? }` |
| DELETE | `/api/admin/mappings/:id`           | `mapping:write` | Remove a mapping                                                                         |

`POST` answers `201` on create and `200` on update. A second live mapping for the same variation is
rejected by the unique index, not silently merged.

## Digital products

| Method | Path                                            | Permission      | Notes                                                                                                         |
| ------ | ----------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/admin/digital-products`                   | `product:read`  | With mapping count, code stock, asset summary                                                                 |
| POST   | `/api/admin/digital-products`                   | `product:write` | `{ name, deliveryKind, status, description?, instructions?, externalUrl?, claimExpiryDays?, maxDeliveries? }` |
| GET    | `/api/admin/digital-products/:id`               | `product:read`  | Detail + assets + mappings + code counts                                                                      |
| PATCH  | `/api/admin/digital-products/:id`               | `product:write` | Partial update; `ARCHIVED` sets `archivedAt`                                                                  |
| DELETE | `/api/admin/digital-products/:id`               | `product:write` | Archive (never hard delete)                                                                                   |
| POST   | `/api/admin/digital-products/:id/assets`        | `product:write` | `multipart/form-data`, field `file`, 50 MB, allow-listed extensions                                           |
| POST   | `/api/admin/digital-products/:id/codes`         | `product:write` | `{ codes: string[], replace?: boolean }`                                                                      |
| GET    | `/api/admin/digital-products/:id/codes`         | `product:read`  | Masked labels + assignment state                                                                              |
| DELETE | `/api/admin/digital-products/:id/codes/:codeId` | `product:write` | Only while unassigned                                                                                         |
| GET    | `/api/admin/digital-products/:id/preview`       | `product:read`  | What the buyer would see, plus warnings                                                                       |

## Orders

| Method | Path                           | Permission   | Notes                                                        |
| ------ | ------------------------------ | ------------ | ------------------------------------------------------------ |
| GET    | `/api/admin/orders`            | `order:read` | `state`, `storeId`, `query`, `mapping=all\|unmapped\|mapped` |
| GET    | `/api/admin/orders/:id`        | `order:read` | Order, items, fulfilments, claims, events, deliveries        |
| POST   | `/api/admin/orders/:id/resync` | `order:write` | Requeue the pipeline for one order                          |
| POST   | `/api/admin/orders/:id/ship`   | `order:write` | Arrange shipment in Shopee (logistics `ship_order`)          |

`POST /api/admin/orders/:id/ship` is the only route that writes back to Shopee. It answers
`{ ok: true, shopeeStatus: "SHIPPED", packageNumber, alreadyShipped }`, is idempotent (a second call
reports `alreadyShipped: true` without calling Shopee), refuses an order that was not delivered yet
(`ORDER_NOT_READY`, 409), and maps a channel that cannot be arranged through the API
(`error_logistics_not_supported`) to a message telling the operator to ship it in the seller centre.
`order:write` belongs to OWNER, ADMIN and OPERATOR; a VIEWER can read orders but not act on them.

## Claims

| Method | Path                                  | Permission    | Notes                                           |
| ------ | ------------------------------------- | ------------- | ----------------------------------------------- |
| GET    | `/api/admin/claims`                   | `claim:read`  | `status`, `query` (order number), `storeId`     |
| GET    | `/api/admin/claims/:id`               | `claim:read`  | Claim, order, product, fulfilment, delivery log |
| GET    | `/api/admin/fulfillments`             | `claim:read`  | Fulfilments by status                           |
| POST   | `/api/admin/claims/:id/revoke`        | `claim:write` | `{ reason }`; kills issued links                |
| POST   | `/api/admin/fulfillments/:id/reissue` | `claim:write` | `{ reason, extendDays? }`; back to `CLAIMABLE`  |
| GET    | `/api/admin/claim-attempts`           | `claim:read`  | Verification attempts, `success` filter         |

## Operations

| Method | Path                        | Permission        | Notes                                                          |
| ------ | --------------------------- | ----------------- | -------------------------------------------------------------- |
| GET    | `/api/admin/overview`       | `overview:read`   | Counters, 14-day series, recent orders, activity               |
| GET    | `/api/admin/monitoring`     | `monitoring:read` | Webhooks, queue, dead jobs, failed syncs, token health, alerts |
| GET    | `/api/admin/webhook-events` | `monitoring:read` | `limit` (max 200)                                              |
| GET    | `/api/admin/settings`       | `overview:read`   | Effective settings plus defaults                               |
| PATCH  | `/api/admin/settings`       | `settings:write`  | `{ branding?, claim?, sync?, notify? }`                        |
| GET    | `/api/admin/audit-logs`     | `audit:read`      | `action`, `actorId` filters                                    |
| GET    | `/api/admin/claim-requests` | `claim:read`      | `status`, paging, joined with order and reviewer               |
| POST   | `/api/admin/claim-requests/:id/review` | `claim:write` | `{ decision: APPROVED\|REJECTED, note?, hours? }`      |
| GET    | `/api/admin/users`          | `user:write`      | Accounts, role, 2FA state, last owner flag                     |
| POST   | `/api/admin/users`          | `user:write`      | `{ email, name, role, password? }` → generated password once   |
| PATCH  | `/api/admin/users/:id`      | `user:write`      | `{ name?, role?, isActive? }`; refuses the last owner          |
| POST   | `/api/admin/users/:id/password` | `user:write`  | Resets the password and revokes every session                  |
| GET    | `/api/admin/security/audit-chain` | `audit:read` | `limit`; replays the hash chain, reports `brokenAt`            |
| GET    | `/api/admin/security/retention`   | `settings:write` | What a sweep would delete                                 |
| POST   | `/api/admin/security/retention`   | `settings:write` | `{ confirm: "HAPUS" }` runs the sweep                      |
| POST   | `/api/admin/security/rotate-key`  | `settings:write` | `{ confirm: "ROTASI", dryRun?, oldKey? }`                  |
| POST   | `/api/admin/security/notify-test` | `settings:write` | Sends one notification, reports `delivered` / `reason`     |

## Error codes worth handling in a client

| Code                                 | Status    | UI reaction                                               |
| ------------------------------------ | --------- | --------------------------------------------------------- |
| `UNAUTHORIZED`                       | 401       | Send the operator to `/login`, the buyer back to the form |
| `FORBIDDEN`                          | 403       | Hide the action; the role cannot do it                    |
| `CSRF_FAILED`                        | 403       | Reload the console (stale CSRF cookie)                    |
| `RATE_LIMITED` / `TOO_MANY_ATTEMPTS` | 429       | Show the wait message, disable the form                   |
| `VALIDATION_ERROR`                   | 422       | Field-level messages in `details[].path`                  |
| `STORE_NOT_CONNECTED`                | 409       | Prompt to authorize the store                             |
| `OUT_OF_STOCK`                       | 409       | Support message; alert the operator                       |
| `ACCESS_REVOKED` / `CLAIM_EXPIRED`   | 403 / 410 | Explain and offer support contact                         |
| `MFA_INVALID` / `CHALLENGE_EXPIRED`  | 401       | Stay on the code step, or restart the login               |
| `IP_NOT_ALLOWED`                     | 403       | The console is restricted by `ADMIN_IP_ALLOWLIST`         |
| `LAST_OWNER` / `USER_EXISTS`         | 409       | Explain why the change is refused                         |
