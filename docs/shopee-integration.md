# Shopee integration

Two things live side by side:

- **`vendor/shopee-integration`** — the protocol layer: signing, OAuth, push signature, endpoint
  wrappers. A git submodule pinned to a commit of `indraoverflow/shopee-integration`.
- **`packages/shopee-adapter`** — the business-facing interface: normalised orders and products, plus
  a fixture implementation.

## Audit of the existing repository

Inspected at commit `9e72ad7` (tag `v0.2.0`), the state this repository pins.

### What was already there and is reused as-is

| Capability | Where | Notes |
|---|---|---|
| HMAC-SHA256 signing for the three API classes | `src/signature.ts` | Base string per class, timestamp in unix seconds, no body in the signature |
| Signed HTTP client | `src/client.ts` | Unwraps `response`, accepts flat bodies, raises `ShopeeApiError` with the Shopee code |
| Authorization URL | `src/auth.ts` | Public-class signature over `partner_id + path + timestamp` |
| Code exchange and refresh | `src/auth.ts` | Accepts the flat token body (`access_token` at the top level) |
| Push signature | `src/webhook.ts` | `HMAC(partner_key, url + rawBody)`, timing-safe compare, alternate key for console test pushes |
| Order listing | `src/shop.ts` | Paged by `update_time` with a cursor and a page cap |
| Diagnostics | `src/verify.ts`, `src/diagnose.ts` | Distinguishes a wrong key from a wrong host, checks clock skew |

That list is the reason this repository exists: the sandbox host differs from the one most guides
print, the token endpoints answer flat, and every one of those mistakes looks like "wrong credentials".

### What it did not have, and was added

| Gap | Addition |
|---|---|
| No order detail call | `src/orders.ts` — `getOrderDetails`, batched 50 per call, with buyer, address and item fields |
| No catalogue reads | `src/products.ts` — `listItems`, `listAllItems`, `getItemDetails`, `getItemModels` |
| Nothing consumed it | This repository |
| Dependabot findings on the old commit | Tracked upstream; none reach the runtime bundle's public surface |

Both additions follow the existing conventions (shop-class signature, capped page walks, typed
responses) and are covered by 11 new tests upstream, which run in that repository's own CI.

### Why it is a submodule rather than an npm dependency

- The package is not published, and making it public-on-npm would mean a release step for every
  protocol fix.
- A submodule pins an exact commit: `git log` here records which protocol code was reviewed.
- `pnpm` links it into the workspace, so `pnpm --filter shopee-integration build` produces the
  compiled `dist/` and type information the adapter imports.

CI checks out with `submodules: recursive`; Docker builds copy `vendor/` before installing.

## The adapter boundary

```ts
interface ShopeeGateway {
  buildAuthorizationUrl(input: { redirectUrl: string }): string;
  exchangeCode(input: { code: string; shopId: number }): Promise<TokenSet>;
  refreshToken(input: { shopId: number; refreshToken: string }): Promise<TokenSet>;
  getShopInfo(access: StoreAccess): Promise<ShopInfoSummary>;
  listOrdersByUpdateTime(access: StoreAccess, window: { from: number; to: number }): Promise<{ orderSns: string[] }>;
  getOrders(access: StoreAccess, orderSns: string[]): Promise<NormalisedOrder[]>;
  listProducts(access: StoreAccess): Promise<{ products: NormalisedProduct[]; truncated: boolean }>;
}
```

Everything the business code knows about Shopee is in that interface. `NormalisedOrder` flattens the
five ways Shopee spells a quantity, converts unix seconds to `Date`, and gives every line a stable
`lineKey` (`itemId:modelId`), which is what makes the pipeline idempotent.

Two implementations:

- `LiveShopeeGateway` — the vendored client plus normalisation. Errors become `ShopeeGatewayError`
  with a `retryable` flag, so the queue knows whether a retry can help.
- `FixtureShopeeGateway` — deterministic stores `pixelbloomid` (771001) and `digistoreid` (771002),
  with products, variations, one paid order and one unpaid order. Every test and the demo use it.

A store's gateway is chosen by `SHOPEE_GATEWAY_MODE`. The console shows the mode in the page header
and on each fixture store, so a simulation is never mistaken for a live connection.

## Endpoints used

| Purpose | Endpoint | Class |
|---|---|---|
| Consent screen | `GET /api/v2/shop/auth_partner` | public |
| Code exchange | `POST /api/v2/auth/token/get` | public |
| Token refresh | `POST /api/v2/auth/access_token/get` | public |
| Shop identity | `GET /api/v2/shop/get_shop_info` | shop |
| Order list (reconciliation) | `GET /api/v2/order/get_order_list` | shop |
| Order detail | `GET /api/v2/order/get_order_detail` | shop |
| Item list | `GET /api/v2/product/get_item_list` | shop |
| Item details | `GET /api/v2/product/get_item_base_info` | shop |
| Variations | `GET /api/v2/product/get_model_list` | shop |

Pushes: code `3` (order status) and code `2` (shop deauthorization) are handled; any other code is
recorded and ignored, visible in Monitoring.

## Signature details that matter

- The push signature covers **`PUBLIC_URL + rawBody`** with the partner key. Reserialising the JSON
  breaks it, so the API installs a JSON parser that keeps the raw bytes (`request.rawBody`) and the
  handler verifies before anything else.
- `SHOPEE_PUSH_URL` must match the registered URL exactly, including scheme and path. Behind a proxy,
  that is the public URL, not the container's.
- API calls sign `partner_id + path + timestamp` (+ `access_token` + `shop_id` for shop calls). Extra
  query params (paging, filters) never enter the signature.
- Shopee rejects a signature older than five minutes; a skewed clock looks exactly like a wrong key.
- Signature is checked **before** the duplicate guard. Verifying the body hash first made a replayed
  forged body answer `duplicate: true` instead of `401`, which confirmed to the sender that the payload
  had been seen. A rejected push is recorded once, for forensics, and never queued, under its own
  hash namespace so a forged attempt cannot occupy the hash of a body Shopee later sends for real.
- With `SHOPEE_PUSH_URL` unset, a production deployment refuses every push with `503` rather than
  accepting unauthenticated ones. Outside production the push is accepted and logged as unverified, so
  the fixture demo keeps working.

## What this platform does not call

Order handling is read-only toward Shopee. The only writes are OAuth token exchange and refresh; there
is no `ship_order`, no cancellation, no price or stock update. A digital order therefore stays in
`READY_TO_SHIP` on Shopee until the seller ships it there, even after the buyer has collected the
product through the portal. Monitoring surfaces those orders (`AWAITING_SHIPMENT`) because Shopee
cancels an unshipped order, and that would refund a product that was already delivered.

## Going live: the remaining steps

1. **Partner app.** In the Shopee Open Platform console, create/approve the app for the production
   environment. Note `partner_id` and `partner_key`.
2. **Permissions.** Request order and product read scopes. Without order read there is no push payload
   to act on; without product read there is nothing to map.
3. **Push URL.** Register `https://api.qansa.web.id/webhook/shopee` in the push settings. Use the
   console's Verify button; if it fails, `SHOPEE_PUSH_TEST_PARTNER_KEY` is missing.
4. **Redirect URL.** Set `https://api.qansa.web.id/api/integration/shopee/callback` as the OAuth
   redirect. It must be a bare domain (Shopee rejects paths in some consoles); the state parameter
   carries the store.
5. **Environment variables.**

   ```bash
   SHOPEE_GATEWAY_MODE=live
   SHOPEE_ENV=production
   SHOPEE_PARTNER_ID=<from console>
   SHOPEE_PARTNER_KEY=<from console>
   SHOPEE_PUSH_URL=https://api.qansa.web.id/webhook/shopee
   SHOPEE_REDIRECT_URL=https://api.qansa.web.id/api/integration/shopee/callback
   API_PUBLIC_ORIGIN=https://api.qansa.web.id
   ```

6. **Verify credentials before connecting a store.** From the vendored package:

   ```bash
   cd vendor/shopee-integration
   PARTNER_ID=... PARTNER_KEY=... npm run verify
   ```

   A pass means the key belongs to that partner in that environment. `error_sign` on every host means
   the key is wrong; `invalid_partner_id` means the id does not exist in that environment.
7. **Authorize one store** through the console, then run a product sync and one order reconciliation
   and compare counts against Seller Center before enabling automatic fulfilment for real customers.

## Sandbox notes

- The sandbox host is usually `https://openplatform.sandbox.test-stable.shopee.sg`. Read *Request
  URL* in the console's API Test Tool rather than trusting a guide; `SHOPEE_BASE_URL` overrides it.
- `partner.test-stable.shopeemobile.com` finds the partner but rejects valid signatures, which looks
  like a wrong key. That is the single most common false diagnosis.
- Sandbox shops have no real digital listings; the fixture gateway is usually faster for building the
  catalogue and mapping UI.

## Assumptions

- Order detail returns `buyer_username` for the store's own orders. Verification depends on it.
- The recipient phone is usually masked (`********1234`). Only the visible digits can be compared,
  which is why the phone policy uses the last four.
- Item and variation ids are stable per shop; the pipeline keys on them.
- Shopee does not push product changes reliably, so catalogue sync is scheduled, not event-driven.
