# Troubleshooting

Symptom first, cause second, fix third.

## Startup

| Symptom                                              | Cause                                    | Fix                                                                     |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `APP_ENCRYPTION_KEY must be 64 hex characters`       | Key missing or wrong length              | `openssl rand -hex 32`                                                  |
| `database schema mismatch (did the migrations run?)` | Migrations not applied                   | `docker compose run --rm migrate`                                       |
| `Can't find meta/_journal.json file`                 | `MIGRATIONS_DIR` points at nothing       | Set `MIGRATIONS_DIR=/app/migrations` (compose already does)             |
| `ECONNREFUSED postgres:5432`                         | Database not up yet or wrong host        | `docker compose ps`, check `DATABASE_URL` uses the compose service name |
| API boots, web says 502                              | `API_URL` wrong inside the web container | `API_URL=http://api:4000`                                               |
| `next start does not work with output: standalone`   | Local `next start` on a standalone build | Use `next dev`, or the docker image (`node apps/web/server.js`)         |

## Stores and tokens

| Symptom                                 | Cause                                                                  | Fix                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `STORE_NOT_CONNECTED`                   | No token row                                                           | Authorize the store (**Sambungkan / Otorisasi**)                                         |
| Store turns `ERROR` after a sync        | Token refresh rejected, or Shopee 5xx                                  | Check `stores.last_error`, then **Perbarui token**; if refresh fails again, re-authorize |
| `TOKEN_REFRESH_FAILED`                  | Refresh token already used or revoked                                  | Re-authorize: refresh tokens are single use                                              |
| `error_sign` on every call              | Wrong partner key, or wrong host                                       | Run `vendor/shopee-integration`: `npm run verify`; compare the console's _Request URL_   |
| `invalid_partner_id`                    | Partner id does not exist in that environment                          | Sandbox credentials only work on the sandbox host                                        |
| OAuth callback lands on `state_invalid` | Callback took longer than 15 minutes, or `SHOPEE_REDIRECT_URL` differs | Restart the authorization from the console                                               |
| `shop_mismatch` on callback             | The authorized shop is not the shop id registered                      | Create the store with the correct shop id                                                |

## Catalogue and mapping

| Symptom                                        | Cause                                                            | Fix                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Catalogue empty after sync                     | Sync still queued, or Shopee returned no NORMAL items            | Monitoring → recent sync job `stats`; check item status in Shopee |
| Order stays `VALIDATED`                        | No mapping for the variation                                     | Catalogue → map the exact variation                               |
| Order item shows `AMBIGUOUS`                   | Two live mappings for the same variation (data imported by hand) | Delete one; the API prevents creating a second                    |
| Fulfilment `PENDING` with `PRODUCT_NOT_ACTIVE` | Digital product is `DRAFT` or `ARCHIVED`                         | Set it to `ACTIVE`                                                |
| Product sync removes nothing                   | A truncated page never deletes                                   | Expected: only a complete catalogue marks missing items deleted   |

## Orders and pushes

| Symptom                                      | Cause                                                                           | Fix                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| No orders at all                             | Store not connected, or no orders in the lookback window                        | **Sinkron pesanan**, raise `ORDER_LOOKBACK_HOURS`                                    |
| Push never appears in Monitoring             | URL not registered, or the tunnel drops the body                                | Check the console's push settings and `SHOPEE_PUSH_URL`                              |
| Push recorded with `signature_valid = false` | Partner key mismatch, URL mismatch (scheme/path), or a proxy rewriting the body | Compare the registered URL with `SHOPEE_PUSH_URL`; do not let a proxy re-encode JSON |
| `401 invalid push signature`                 | Same as above                                                                   | Same                                                                                 |
| Push accepted, order unchanged               | Job failed; see Monitoring → dead letter                                        | Read the last error; fix the cause, then **Proses ulang** on the order               |
| Order stuck at `INELIGIBLE / NOT_PAID`       | Buyer has not paid                                                              | Nothing to do: the next sync moves it forward                                        |
| `STATE_HELD` events                          | A late push tried to move a claimed order backwards                             | Expected; the event is the audit record                                              |
| Buyer claims but sees “Produk belum siap”    | Fulfilment `PENDING`                                                            | Fix the product status, resync the order                                             |

## Buyer claims

| Symptom                                | Cause                                             | Fix                                                              |
| -------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| “Nomor pesanan tidak ditemukan”        | Order belongs to another store, or has not synced | Check the store filter on the order                              |
| `USERNAME_MISMATCH`                    | Buyer typed a different username                  | The username on the Shopee order is authoritative                |
| `PHONE_UNAVAILABLE`                    | Strict policy but Shopee returned no phone        | Keep the policy; approve a manual request from Verifikasi Manual |
| `TOO_MANY_ATTEMPTS`                    | More failures than the window allows              | Wait, or raise the limit in Settings                             |
| “Stok produk digital ini sedang habis” | Code pool empty                                   | Import codes in the digital product page                         |
| Download says expired                  | Link TTL passed (10 minutes)                      | Re-open the product from the portal                              |
| “Batas unduhan sudah tercapai”         | Download counter hit the limit                    | Admin can raise `maxDownloadsPerFulfillment` or reissue          |
| Everything 401 immediately             | `SESSION_COOKIE_SECURE=true` on plain HTTP        | Set it to `false` locally, or serve HTTPS                        |

## Console and API

| Symptom                        | Cause                                                      | Fix                                                                                            |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CSRF_FAILED`                  | CSRF cookie missing (cookie cleared, or a direct API call) | Reload the console; API clients must send `x-csrf-token`                                       |
| `Origin tidak diizinkan`       | Origin not in the allow list (proxy host, custom port)     | Add it to `CLAIM_ORIGIN`/`ADMIN_ORIGIN`/`EXTRA_ORIGINS`, or use a loopback port in development |
| 403 on a page action           | Role lacks the permission                                  | Check `/api/auth/me` → `permissions`                                                           |
| Charts empty, counters zero    | Nothing synced yet                                         | Connect a store and sync                                                                       |
| `next build` fails on types    | Local changes broke a contract                             | `pnpm typecheck` for the exact file                                                            |
| `IP_NOT_ALLOWED` on every call | `ADMIN_IP_ALLOWLIST` does not include your address         | Fix `.env` and restart the API; `/health` always answers                                       |
| Locked out with 2FA lost       | Authenticator gone and no recovery codes                   | An owner resets the password (`POST /api/admin/users/:id/password`), then re-enrol             |
| `CHALLENGE_EXPIRED`            | The 2FA step waited more than five minutes                 | Log in again; the challenge is single use                                                      |
| `OLD_KEY_MISSING`              | Rotation attempted without `APP_ENCRYPTION_KEY_OLD`        | Set it to the key currently in use, restart, then rotate                                       |
| `ASSET_UPLOAD_FAILED` (502)    | Bucket credentials or endpoint wrong, or path style needed | Check `S3_*`, set `S3_FORCE_PATH_STYLE=true` for MinIO                                         |
| Notification never arrives     | Not enabled, URL empty, event not selected                 | Keamanan sends a test and reports why: `disabled`, `no_url`, `filtered`, `http_error`          |

## Worker

| Symptom                                        | Cause                                                       | Fix                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Queue grows, nothing processes                 | Worker not running, or database unreachable from the worker | `docker compose ps worker`, check its log                                          |
| Jobs stuck `RUNNING`                           | Worker died mid-job                                         | Automatic: `recoverStuckJobs` requeues after 15 minutes                            |
| Same job retried forever                       | A permanent error is being treated as transient             | Dead letter after `maxAttempts`; look at `last_error`                              |
| Dead letter says `Toko Shopee tidak ditemukan` | The store was deleted after its sync job was queued         | Fixed: sync and order jobs drain with `store no longer exists` instead of retrying |
| Reconcile runs every few minutes               | Normal schedule (`ORDER_RECONCILE_MINUTES`)                 | Raise it if it is noisy                                                            |
| Worker and API disagree about time             | Container clocks                                            | Both use UTC from the host; check `date` in each container                         |

## Useful commands

```bash
docker compose logs -f api worker web
docker compose exec postgres psql -U qansa -d qansa_delivery

# what is queued right now
select type, status, count(*) from jobs group by 1,2 order by 1,2;

# why did this order not become claimable
select order_sn, state, shopee_status, ineligible_reason from orders where order_sn = '260101PXL0001';
select type, from_state, to_state, payload, created_at from order_events
  where order_id = (select id from orders where order_sn = '260101PXL0001') order by created_at;

# failed verifications for one order
select ip, reason, created_at from claim_attempts
  where order_sn = '260101PXL0001' and not success order by created_at desc limit 20;

# end-to-end check without clicking
node --env-file=.env scripts/smoke.mjs
```
