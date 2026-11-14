/**
 * Mint a sandbox consent URL for one store.
 *
 *   pnpm shopee:authorize <store-uuid>
 *
 * Why this exists: the consent URL carries a `timestamp` that Shopee accepts for
 * about five minutes, and the redirect must point at the sandbox API host, not
 * the live one. Copying a URL from a document therefore expires before anyone
 * reaches the seller login, and an unsigned redirect is refused by the callback
 * (`callback_incomplete`) because the state is what binds the returning shop to
 * a store row.
 *
 * The state is signed with the same secret the API verifies
 * (`sha256(appKey + ":oauth-state")`, payload `{storeId, exp}`), so a link minted
 * here is accepted by the deployed callback. It expires on its own: the state
 * after 15 minutes, Shopee's signature after about five.
 *
 * Reads SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, APP_ENCRYPTION_KEY and
 * SHOPEE_SANDBOX_REDIRECT_URL from the environment; run it through the
 * `shopee:authorize` npm script so `.env` is loaded.
 */
import { sha256Hex, signPayload } from "../packages/core/src/crypto.ts";
import { authorizationUrl } from "../vendor/shopee-integration/src/index.ts";

const storeId = process.argv[2] ?? "";
if (!/^[0-9a-f-]{36}$/i.test(storeId)) {
  console.error("usage: pnpm shopee:authorize <store-uuid>");
  process.exit(2);
}

const partnerId = Number(process.env.SHOPEE_PARTNER_ID ?? "");
const partnerKey = process.env.SHOPEE_PARTNER_KEY ?? "";
const appKey = process.env.APP_ENCRYPTION_KEY ?? "";
const redirectUrl = process.env.SHOPEE_SANDBOX_REDIRECT_URL ?? "";

for (const [name, value] of Object.entries({
  SHOPEE_PARTNER_ID: partnerId,
  SHOPEE_PARTNER_KEY: partnerKey,
  APP_ENCRYPTION_KEY: appKey,
  SHOPEE_SANDBOX_REDIRECT_URL: redirectUrl,
})) {
  if (!value) {
    console.error(
      `${name} is not set; run this through pnpm shopee:authorize so .env is loaded`,
    );
    process.exit(2);
  }
}

const state = signPayload(sha256Hex(`${appKey}:oauth-state`), {
  storeId,
  exp: Math.floor(Date.now() / 1000) + 900,
});

const raw = authorizationUrl({
  partnerId,
  partnerKey,
  baseUrl:
    process.env.SHOPEE_SANDBOX_HOST ??
    "https://openplatform.sandbox.test-stable.shopee.sg",
  redirectUrl: `${redirectUrl}?state=${encodeURIComponent(state)}`,
});

console.log(
  "Open this within five minutes, signed in as the sandbox seller that owns the shop:",
);
console.log(raw);
