import { createTestDatabase, schema, type TestDatabase } from "@qansa/db";
import { encryptSecret } from "@qansa/core";
import { FixtureShopeeGateway, type FixtureStore } from "@qansa/shopee-adapter";
import type { ServiceDeps } from "../src/types.js";

export const KEY = "b".repeat(64);
export const FIXED_NOW = new Date("2026-01-01T00:00:00Z");
const FIXED_EPOCH = Math.floor(FIXED_NOW.getTime() / 1000);
export const DOWNLOAD_SECRET = "download-signing-secret-for-tests";

export interface Harness {
  deps: ServiceDeps;
  db: TestDatabase;
  storeId: string;
  close: () => Promise<void>;
  setNow: (date: Date) => void;
}

export const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * A store connected through the fixture gateway, with tokens already stored the
 * way the OAuth callback would store them. Everything downstream is the real
 * code path: real SQL, real migrations, real pipeline.
 */
export async function harness(fixture: FixtureStore[], options: { eligibleStatuses?: string[]; verificationPolicy?: "USERNAME" | "USERNAME_PHONE" } = {}): Promise<Harness> {
  const db = await createTestDatabase();
  let current = new Date(FIXED_NOW);

  const [store] = await db.db
    .insert(schema.shopeeStores)
    .values({
      shopId: fixture[0]?.shopId ?? 1,
      label: fixture[0]?.shopName ?? "test-store",
      shopName: fixture[0]?.shopName ?? "test-store",
      status: "CONNECTED",
      environment: "SANDBOX",
      verificationPolicy: options.verificationPolicy ?? "USERNAME",
      ...(options.eligibleStatuses ? { eligibleStatuses: options.eligibleStatuses } : {}),
    })
    .returning();

  await db.db.insert(schema.shopeeTokens).values({
    storeId: store!.id,
    accessTokenEnc: encryptSecret("fixture-access", KEY),
    refreshTokenEnc: encryptSecret("fixture-refresh", KEY),
    expiresAt: new Date("2026-01-01T12:00:00Z"),
  });

  const deps: ServiceDeps = {
    db: db.db,
    gateway: new FixtureShopeeGateway(fixture),
    config: {
      appEncryptionKey: KEY,
      downloadSigningSecret: DOWNLOAD_SECRET,
      uploadDir: "/tmp/qansa-test-uploads",
      claimOrigin: "https://claim.qansa.web.id",
      apiPublicOrigin: "https://api.qansa.web.id",
      gatewayMode: "fixture",
      orderLookbackHours: 72,
    },
    logger: silentLogger,
    now: () => current,
  };

  return {
    deps,
    db,
    storeId: store!.id,
    close: async () => db.close(),
    setNow: (date: Date) => {
      current = date;
    },
  };
}

export function sampleStore(overrides: Partial<FixtureStore> = {}): FixtureStore {
  return {
    shopId: 555001,
    shopName: "pixelbloomid",
    region: "ID",
    status: "NORMAL",
    products: [
      {
        item_id: 101,
        item_name: "E-Meterai 10.000",
        price: 11500,
        models: [
          { model_id: 1001, model_name: "1 E-Meterai", price: 11500, stock: 100 },
          { model_id: 1002, model_name: "5 E-Meterai", price: 55000, stock: 100 },
          { model_id: 1003, model_name: "10 E-Meterai", price: 105000, stock: 100 },
        ],
      },
    ],
    orders: [
      {
        order_sn: "260101TEST0001",
        order_status: "READY_TO_SHIP",
        buyer_username: "rina_kurnia",
        recipient_phone: "********2250",
        create_time: FIXED_EPOCH - 600,
        update_time: FIXED_EPOCH - 300,
        total_amount: 55000,
        items: [
          { item_id: 101, model_id: 1002, item_name: "E-Meterai 10.000", model_name: "5 E-Meterai", quantity: 1, price: 55000 },
        ],
      },
      {
        order_sn: "260101TEST0002",
        order_status: "UNPAID",
        buyer_username: "belum_bayar",
        recipient_phone: "********9911",
        create_time: FIXED_EPOCH - 600,
        update_time: FIXED_EPOCH - 300,
        total_amount: 11500,
        items: [{ item_id: 101, model_id: 1001, item_name: "E-Meterai 10.000", model_name: "1 E-Meterai", quantity: 1, price: 11500 }],
      },
    ],
    ...overrides,
  };
}

export async function createDigitalProduct(
  h: Harness,
  input: { name: string; kind: "FILE" | "LINK" | "CODE" | "CREDENTIALS" | "INSTRUCTIONS"; externalUrl?: string; maxDeliveries?: number; instructions?: string },
) {
  const [product] = await h.db.db
    .insert(schema.digitalProducts)
    .values({
      name: input.name,
      slug: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`,
      deliveryKind: input.kind,
      status: "ACTIVE",
      externalUrl: input.externalUrl ?? null,
      maxDeliveries: input.maxDeliveries ?? 3,
      instructions: input.instructions ?? "Terima kasih sudah membeli.",
    })
    .returning();
  return product!;
}

export async function addCodes(h: Harness, digitalProductId: string, codes: string[]) {
  for (const code of codes) {
    await h.db.db.insert(schema.digitalProductCodes).values({
      digitalProductId,
      secretEnc: encryptSecret(code, KEY),
      label: `****${code.slice(-4)}`,
    });
  }
}

export async function mapVariation(h: Harness, input: { itemId: number; modelId: number | null; digitalProductId: string; multiplier?: number }) {
  const [product] = await h.db.db
    .select({ id: schema.shopeeProducts.id })
    .from(schema.shopeeProducts)
    .where(eqItem(h.storeId, input.itemId))
    .limit(1);

  if (!product) throw new Error(`product ${input.itemId} not synced yet`);

  let variationId: string | null = null;
  if (input.modelId !== null) {
    const [variation] = await h.db.db
      .select({ id: schema.shopeeVariations.id })
      .from(schema.shopeeVariations)
      .where(and(eq(schema.shopeeVariations.productId, product.id), eq(schema.shopeeVariations.modelId, input.modelId)))
      .limit(1);
    variationId = variation?.id ?? null;
  }

  const [mapping] = await h.db.db
    .insert(schema.productMappings)
    .values({
      storeId: h.storeId,
      shopeeProductId: product.id,
      shopeeVariationId: variationId,
      digitalProductId: input.digitalProductId,
      quantityMultiplier: input.multiplier ?? 1,
    })
    .returning();
  return mapping!;
}

import { and, eq } from "drizzle-orm";

function eqItem(storeId: string, itemId: number) {
  return and(eq(schema.shopeeProducts.storeId, storeId), eq(schema.shopeeProducts.itemId, itemId));
}
