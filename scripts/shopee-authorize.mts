/**
 * Mint a Shopee consent URL, sandbox or live.
 *
 *   pnpm shopee:authorize live
 *   pnpm shopee:authorize sandbox 582c0269-e457-4f73-adcc-b161b6dd1e5a
 *
 * The store id is optional now: the callback resolves the store by the shop id
 * Shopee returns and creates it when it is new, so a live consent no longer
 * needs a row to exist before the seller clicks.
 *
 * Why this exists: the consent URL carries a `timestamp` Shopee accepts for
 * about five minutes, so a URL pasted into a message is often dead before the
 * seller reaches the login. The state is signed with the same secret the API
 * verifies (`sha256(appKey + ":oauth-state")`, payload `{storeId, exp}`) and
 * expires after fifteen minutes.
 *
 * Shopee's own Authorize button on the app page authorizes the *main account*
 * and returns `code` + `main_account_id` with no shop id, which is why a consent
 * started there cannot attach a shop. This link asks for shop-level consent and
 * returns `code` + `shop_id`.
 */
import { sha256Hex, signPayload } from "../packages/core/src/crypto.ts";
import { authorizationUrl } from "../vendor/shopee-integration/src/index.ts";

const environment = (process.argv[2] ?? "").toLowerCase();
if (environment !== "sandbox" && environment !== "live") {
  console.error("usage: pnpm shopee:authorize <sandbox|live> [store-uuid]");
  process.exit(2);
}

const storeId = process.argv[3] ?? "";
if (storeId && !/^[0-9a-f-]{36}$/i.test(storeId)) {
  console.error("store id must be a uuid, or omitted");
  process.exit(2);
}

const partnerId = Number(process.env.SHOPEE_PARTNER_ID ?? "");
const partnerKey = process.env.SHOPEE_PARTNER_KEY ?? "";
const appKey = process.env.APP_ENCRYPTION_KEY ?? "";
const redirectUrl =
  environment === "live"
    ? (process.env.SHOPEE_LIVE_REDIRECT_URL ?? "")
    : (process.env.SHOPEE_SANDBOX_REDIRECT_URL ?? "");
const baseUrl =
  environment === "live"
    ? (process.env.SHOPEE_LIVE_HOST ?? "https://partner.shopeemobile.com")
    : (process.env.SHOPEE_SANDBOX_HOST ??
      "https://openplatform.sandbox.test-stable.shopee.sg");

for (const [name, value] of Object.entries({
  SHOPEE_PARTNER_ID: partnerId,
  SHOPEE_PARTNER_KEY: partnerKey,
  APP_ENCRYPTION_KEY: appKey,
  redirect_url: redirectUrl,
})) {
  if (!value) {
    console.error(
      `${name} is not set; run this through pnpm shopee:authorize so .env is loaded`,
    );
    process.exit(2);
  }
}

const state = signPayload(sha256Hex(`${appKey}:oauth-state`), {
  ...(storeId ? { storeId } : {}),
  exp: Math.floor(Date.now() / 1000) + 900,
});

const url = authorizationUrl({
  partnerId,
  partnerKey,
  baseUrl,
  redirectUrl: `${redirectUrl}?state=${encodeURIComponent(state)}`,
});

console.log(
  `Open this within five minutes, signed in as the ${environment} seller that owns the shop:`,
);
console.log(url);
