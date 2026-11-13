# Live Shopee integration checklist

Everything here is either verified against the code in this repository, verified against a Shopee
document snapshot (the one that publishes the `v2.logistics.ship_order` page), or explicitly marked
**to confirm in the partner console**. Nothing in this file is a guess about what the API can do.

Current state: `SHOPEE_GATEWAY_MODE=fixture`. The live path is implemented and unit-tested against a
fixture that imitates Shopee's shapes, but **no call has ever been made with real partner credentials**.
Treat "live" as unproven until section 6 passes.

## 1. What the partner account must provide

| Item                                | Where it comes from                   | Status     |
| ----------------------------------- | ------------------------------------- | ---------- |
| `SHOPEE_PARTNER_ID`                 | Partner console, app details          | missing    |
| `SHOPEE_PARTNER_KEY`                | Partner console, app details (secret) | missing    |
| App type with the right permissions | Console: app creation + review        | to confirm |
| Registered OAuth redirect URL       | Console: app settings                 | to confirm |

The app needs permission for the modules below. The permission column on the official reference pages
reads "ERP System; Seller In House System; Order Management; Swam ERP", which is the module group a
partner app must be approved for; which of those exactly is granted is decided in the console, not here.

| Module    | Endpoints this platform calls                                                   |
| --------- | ------------------------------------------------------------------------------- |
| Shop      | `shop/get_shop_info`                                                            |
| Order     | `order/get_order_list`, `order/get_order_detail`                                |
| Product   | `product/get_item_list`, `product/get_item_base_info`, `product/get_model_list` |
| Logistics | `logistics/get_shipping_parameter`, `logistics/ship_order`                      |
| Auth      | `shop/auth_partner`, `auth/token/get`, `auth/access_token/get`                  |

No other endpoint is used. There is no scraping, no undocumented path, and no call outside `/api/v2`.

## 2. Hosts

| Environment   | Host                                                 | Verified how                                                                                            |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Production    | `https://partner.shopeemobile.com`                   | A request without a valid timestamp answers `{"error":"error_param","message":"Timestamp is expired."}` |
| Sandbox       | `https://openplatform.sandbox.test-stable.shopee.sg` | Same answer shape; DNS resolves to `143.92.64.132`                                                      |
| Sandbox alias | `https://partner.test-stable.shopeemobile.com`       | Resolves to the same IP and answers identically, so the "different sandbox host" worry is a non-issue   |

Both sandbox names are aliases of one host, confirmed on 2026-11-13 with a plain HTTPS request. Override
with `SHOPEE_BASE_URL` if a region publishes a different one.

## 3. OAuth

1. Redirect the seller to
   `https://partner.shopeemobile.com/api/v2/shop/auth_partner?partner_id=<id>&timestamp=<unix>&sign=<hex>&redirect=<urlencoded callback>`
   where `sign = hex(HMAC-SHA256(partner_id + path + timestamp, partner_key))`. The redirect URL must be
   the exact one registered in the console.
2. Shopee redirects back to the callback with `code` and `shop_id`.
3. Exchange it: `POST /api/v2/auth/token/get` with `{ code, shop_id, partner_id }`, signed as a public
   call. The answer is flat (`access_token`, `refresh_token`, `expire_in`), not wrapped in `response`.
4. Persist both tokens encrypted with `APP_ENCRYPTION_KEY`. The platform stores them in `shopee_tokens`
   and never writes a plaintext token to disk or to a log.
5. Refresh: `POST /api/v2/auth/access_token/get` with `{ refresh_token, shop_id, partner_id }`. Shopee
   returns a **new refresh token**, and this platform persists it, so rotation is followed rather than
   the old token being reused. `tokenHealth` in Monitoring shows the remaining minutes per store.

## 4. Push (webhook)

- Register `https://api.qansa.web.id/webhook/shopee` as the push URL, exactly, including scheme and path.
- Signature: `hex(HMAC-SHA256(<full callback URL> + <raw request body>, partner_key))`, delivered in the
  `Authorization` header. The body must be the bytes received; re-serialising the JSON breaks it. This
  API keeps every raw body for that reason.
- Duplicates are expected: a push can be retried. They are detected by body hash and answered
  `duplicate` instead of being processed twice.
- The console's "Test push" button signs with a separate Test Push Partner Key; set
  `SHOPEE_PUSH_TEST_PARTNER_KEY` if you want that button to pass, otherwise it is rejected by design.

## 5. Environment to switch

```env
SHOPEE_GATEWAY_MODE=live
SHOPEE_ENV=production
SHOPEE_PARTNER_ID=<from console>
SHOPEE_PARTNER_KEY=<from console>
SHOPEE_PUSH_URL=https://api.qansa.web.id/webhook/shopee
SHOPEE_REDIRECT_URL=https://api.qansa.web.id/api/integration/shopee/callback
# optional, only for a region with a different host
# SHOPEE_BASE_URL=
```

`SHOPEE_PUSH_URL` also decides whether pushes are verified at all: unset means unverified, which the code
refuses to accept outside production.

## 6. The verification sequence, in order

1. `node vendor/shopee-integration/dist/diagnose.js` (or `pnpm --filter shopee-integration diagnose`) —
   proves `partner_id`/`partner_key` are accepted by `auth/token/get` and `shop/auth_partner`.
2. Connect one store through the console and confirm the shop appears with a token and a live
   `expiresAt`.
3. Run `node --env-file=.env scripts/preflight.mjs`. Every check must pass except "gateway mode", which
   stops warning once the mode is live.
4. Sync products, map one variation, and watch a real paid order appear through a push.
5. Open the claim portal as the buyer and take the product; confirm `SHIP_CONFIRMED` carries the resi.
6. Confirm in the Seller Centre that the order really moved to **Dikirim**. This is the step no fixture
   can prove: whether Shopee accepts the resi for that channel depends on the channel itself.
7. Only after step 6 should this deployment be called production-live.

## 7. Known unknowns, stated rather than assumed

- Whether `ship_order` accepts a platform-generated resi (`DIGITAL-<order_sn>`) on jasa kirim toko for
  these two shops. Shopee documents `non_integrated.tracking_number` as "assigned by the shipping
  carrier", so a placeholder may be refused. If it is, set `autoShipTrigger` to manual and ship in the
  seller centre, or supply real resi numbers.
- Whether the approved app carries the logistics permission. If `ship_order` answers
  `error_permission`, the console needs the Logistics module enabled for the app.
- Rate limits per app are published per endpoint; this platform bursts only during reconcile, and the
  reconciler pages through orders, so a limit hit is answered by the job retrying with backoff.
