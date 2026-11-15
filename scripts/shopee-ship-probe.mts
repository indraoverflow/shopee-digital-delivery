/**
 * Shipping probe. Answers two questions without moving anything:
 *
 *   1. which shipping block this order's channel accepts (pickup, dropoff or a
 *      non-integrated channel such as "jasa kirim toko"), and
 *   2. with `--ship`, whether Shopee accepts a DIGITAL-<order_sn> resi on that
 *      channel.
 *
 * Read-only unless --ship is passed, and --ship refuses to run without --yes,
 * because shipping an order starts Shopee's delivery clock for a real buyer.
 *
 * Input on stdin: {"shopId": 123, "orderSn": "...", "access": "<encrypted>"}
 */
import { readFileSync } from "node:fs";
import { decryptSecret } from "../packages/core/src/crypto.ts";
import { createGateway } from "../packages/shopee-adapter/src/index.ts";

const raw = readFileSync(0, "utf8").trim();
if (!raw) {
  console.log(
    "no ready-to-ship order found for this environment; nothing to probe",
  );
  process.exit(0);
}
const input = JSON.parse(raw) as {
  shopId: number;
  orderSn: string;
  access: string;
};
const ship = process.argv.includes("--ship");
const confirmed = process.argv.includes("--yes");
if (ship && !confirmed) {
  console.error(
    "refusing to ship without --yes: this moves a real buyer's order",
  );
  process.exit(2);
}

const gateway = createGateway({
  mode: "live",
  partnerId: Number(process.env.SHOPEE_PARTNER_ID ?? ""),
  partnerKey: process.env.SHOPEE_PARTNER_KEY ?? "",
  baseUrl:
    process.env.SHOPEE_PROBE_BASE_URL ?? "https://partner.shopeemobile.com",
});

const access = {
  shopId: input.shopId,
  accessToken: decryptSecret(
    input.access,
    process.env.APP_ENCRYPTION_KEY ?? "",
  ),
};

if (!gateway.getShippingOptions) {
  console.error("this gateway has no shipping support");
  process.exit(2);
}

try {
  const options = await gateway.getShippingOptions(access, input.orderSn);
  console.log("shipping options:", JSON.stringify(options));
} catch (error) {
  console.log(
    "shipping options failed:",
    (error as { code?: string }).code ?? (error as Error).message,
  );
}

if (ship && gateway.shipOrder) {
  try {
    const result = await gateway.shipOrder(access, input.orderSn, {
      trackingNumber: `DIGITAL-${input.orderSn}`,
    });
    console.log("ship_order:", JSON.stringify(result));
  } catch (error) {
    const code = (error as { code?: string }).code ?? null;
    const message = error instanceof Error ? error.message : String(error);
    console.log("ship_order failed:", JSON.stringify({ code, message }));
  }
}
