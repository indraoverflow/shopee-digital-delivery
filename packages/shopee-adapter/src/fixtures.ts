import { FixtureShopeeGateway, LiveShopeeGateway, type FixtureStore, type ShopeeGateway } from "./gateway.js";

/**
 * Two sample stores shaped like the real ones (a digital storefront with
 * variation-priced packages). They exist so the pipeline, the mapping UI and
 * the claim portal can be demonstrated end to end before partner approval, and
 * so the automated tests run against deterministic order numbers.
 *
 * Nothing here is presented as a live Shopee connection: a store whose gateway
 * mode is "fixture" is labelled SIMULATED everywhere in the UI.
 */
const now = Math.floor(Date.now() / 1000);

export const fixtureStores: FixtureStore[] = [
  {
    shopId: 771001,
    shopName: "pixelbloomid",
    region: "ID",
    status: "NORMAL",
    products: [
      {
        item_id: 101,
        item_name: "E-Meterai 10.000 - Resmi Peruri",
        status: "NORMAL",
        price: 11500,
        models: [
          { model_id: 1001, model_name: "1 E-Meterai", price: 11500, stock: 500, sku: "MTR-1" },
          { model_id: 1002, model_name: "5 E-Meterai", price: 55000, stock: 200, sku: "MTR-5" },
          { model_id: 1003, model_name: "10 E-Meterai", price: 105000, stock: 100, sku: "MTR-10" },
        ],
      },
      {
        item_id: 102,
        item_name: "Template Notion - Freelance Finance Tracker",
        status: "NORMAL",
        price: 49000,
        models: [{ model_id: 2001, model_name: "Akses Seumur Hidup", price: 49000, stock: 999, sku: "NTN-FIN" }],
      },
    ],
    orders: [
      {
        order_sn: "260101PXL0001",
        order_status: "READY_TO_SHIP",
        buyer_username: "rina_kurnia",
        recipient_phone: "********2250",
        create_time: now - 3600,
        update_time: now - 1800,
        total_amount: 55000,
        currency: "IDR",
        payment_method: "ShopeePay",
        items: [
          { item_id: 101, model_id: 1002, item_name: "E-Meterai 10.000 - Resmi Peruri", model_name: "5 E-Meterai", quantity: 1, price: 55000 },
        ],
      },
      {
        order_sn: "260101PXL0002",
        order_status: "UNPAID",
        buyer_username: "belum_bayar",
        recipient_phone: "********9911",
        create_time: now - 900,
        update_time: now - 600,
        total_amount: 49000,
        currency: "IDR",
        items: [{ item_id: 102, model_id: 2001, item_name: "Template Notion - Freelance Finance Tracker", model_name: "Akses Seumur Hidup", quantity: 1, price: 49000 }],
      },
    ],
  },
  {
    shopId: 771002,
    shopName: "digistoreid",
    region: "ID",
    status: "NORMAL",
    products: [
      {
        item_id: 201,
        item_name: "Lisensi Canva Pro 1 Tahun - Sharing",
        status: "NORMAL",
        price: 35000,
        models: [{ model_id: 3001, model_name: "1 Tahun", price: 35000, stock: 50, sku: "CNV-1Y" }],
      },
    ],
    orders: [
      {
        order_sn: "260101DGS0001",
        order_status: "COMPLETED",
        buyer_username: "agus_wijaya",
        recipient_phone: "********7788",
        create_time: now - 7200,
        update_time: now - 3600,
        total_amount: 35000,
        currency: "IDR",
        payment_method: "Transfer Bank",
        items: [{ item_id: 201, model_id: 3001, item_name: "Lisensi Canva Pro 1 Tahun - Sharing", model_name: "1 Tahun", quantity: 1, price: 35000 }],
      },
    ],
  },
];

export interface GatewayConfig {
  /** "live" talks to Shopee; "fixture" runs the same code path against fixtures. */
  mode: "live" | "fixture";
  partnerId: number;
  partnerKey: string;
  baseUrl: string;
}

export function createGateway(config: GatewayConfig): ShopeeGateway {
  if (config.mode === "fixture") {
    return new FixtureShopeeGateway(fixtureStores, { partnerId: config.partnerId });
  }
  return new LiveShopeeGateway({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    baseUrl: config.baseUrl,
  });
}
