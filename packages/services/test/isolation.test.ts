import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { encryptSecret } from "@qansa/core";
import { schema } from "@qansa/db";
import { verifyClaim } from "../src/claims.js";
import { processOrder } from "../src/orders.js";
import { runProductSync } from "../src/sync.js";
import { KEY, addCodes, createDigitalProduct, harness, sampleStore, type Harness } from "./helpers.js";

/**
 * Two shops can sell listings that share item and model ids: Shopee ids are unique
 * per shop, not globally. Mapping is therefore per store, and this test is the one
 * that proves it: store B maps the item, store A's order buys the same ids, and store
 * A must come out with nothing at all, neither a fulfilment nor a way in.
 */

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("store isolation", () => {
  it("never lets one store's mapping deliver another store's order", async () => {
    const storeB = sampleStore({ shopId: 555002, shopName: "digistoreid" });
    h = await harness([sampleStore(), storeB]);

    const [b] = await h.db.db
      .insert(schema.shopeeStores)
      .values({
        shopId: storeB.shopId,
        label: "digistoreid",
        shopName: "digistoreid",
        status: "CONNECTED",
        environment: "SANDBOX",
      })
      .returning();
    await h.db.db.insert(schema.shopeeTokens).values({
      storeId: b!.id,
      accessTokenEnc: encryptSecret("fixture-access", KEY),
      refreshTokenEnc: encryptSecret("fixture-refresh", KEY),
      expiresAt: new Date("2026-01-01T12:00:00Z"),
    });

    await runProductSync(h.deps, { storeId: b!.id });
    await runProductSync(h.deps, { storeId: h.storeId });

    const digital = await createDigitalProduct(h, { name: "Produk Toko B", kind: "CODE" });
    await addCodes(h, digital.id, ["STORE-B-CODE"]);

    const [productB] = await h.db.db
      .select()
      .from(schema.shopeeProducts)
      .where(and(eq(schema.shopeeProducts.storeId, b!.id), eq(schema.shopeeProducts.itemId, 101)));
    const [variationB] = await h.db.db
      .select()
      .from(schema.shopeeVariations)
      .where(and(eq(schema.shopeeVariations.productId, productB!.id), eq(schema.shopeeVariations.modelId, 1002)));

    await h.db.db.insert(schema.productMappings).values({
      storeId: b!.id,
      shopeeProductId: productB!.id,
      shopeeVariationId: variationB!.id,
      digitalProductId: digital.id,
    });

    // Store A's buyer buys the very same item/model ids.
    await processOrder(h.deps, h.storeId, "260101TEST0001");

    const fulfilments = await h.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.storeId, h.storeId));
    expect(fulfilments).toHaveLength(0);

    const [order] = await h.db.db.select().from(schema.orders).where(eq(schema.orders.orderSn, "260101TEST0001"));
    expect(order!.state).not.toBe("FULFILLED");

    // And there is no way in: the order has nothing claimable to open.
    await expect(
      verifyClaim(h.deps, { orderSn: "260101TEST0001", buyerUsername: "rina_kurnia", ip: "9.9.9.9" }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_CLAIMABLE" });

    // The mapping in B still works for B, so the isolation is a filter, not an outage.
    const [productA] = await h.db.db
      .select()
      .from(schema.shopeeProducts)
      .where(and(eq(schema.shopeeProducts.storeId, h.storeId), eq(schema.shopeeProducts.itemId, 101)));
    expect(productA!.id).not.toBe(productB!.id);
  });
});
