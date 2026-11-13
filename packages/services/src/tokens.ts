import { schema, type ShopeeStore } from "@qansa/db";
import { decryptSecret, encryptSecret } from "@qansa/core";
import { AppError } from "@qansa/core";
import type { StoreAccess } from "@qansa/shopee-adapter";
import { eq } from "drizzle-orm";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/** Refresh a token this long before it lapses, not after. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface StoreAccessResult {
  store: ShopeeStore;
  access: StoreAccess;
  expiresAt: Date;
  refreshed: boolean;
}

export async function markStoreError(
  deps: ServiceDeps,
  storeId: string,
  message: string,
): Promise<void> {
  await deps.db
    .update(schema.shopeeStores)
    .set({
      status: "ERROR",
      lastError: message.slice(0, 500),
      updatedAt: nowOf(deps),
    })
    .where(eq(schema.shopeeStores.id, storeId));
}

export async function saveToken(
  deps: ServiceDeps,
  storeId: string,
  token: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<Date> {
  const expiresAt = new Date(nowOf(deps).getTime() + token.expiresIn * 1000);
  const values = {
    storeId,
    accessTokenEnc: encryptSecret(
      token.accessToken,
      deps.config.appEncryptionKey,
    ),
    refreshTokenEnc: encryptSecret(
      token.refreshToken,
      deps.config.appEncryptionKey,
    ),
    expiresAt,
    lastRefreshedAt: nowOf(deps),
    updatedAt: nowOf(deps),
  };

  await deps.db
    .insert(schema.shopeeTokens)
    .values(values)
    .onConflictDoUpdate({
      target: schema.shopeeTokens.storeId,
      set: {
        accessTokenEnc: values.accessTokenEnc,
        refreshTokenEnc: values.refreshTokenEnc,
        expiresAt: values.expiresAt,
        lastRefreshedAt: values.lastRefreshedAt,
        updatedAt: values.updatedAt,
      },
    });

  return expiresAt;
}

/**
 * Returns a usable access token for a store, refreshing it when it is about to
 * expire. Refresh tokens are single use, so the new pair is persisted before
 * the caller uses it: losing the pair costs the seller another authorization.
 */
export async function getStoreAccess(
  deps: ServiceDeps,
  storeId: string,
): Promise<StoreAccessResult> {
  const [store] = await deps.db
    .select()
    .from(schema.shopeeStores)
    .where(eq(schema.shopeeStores.id, storeId))
    .limit(1);
  if (!store) throw AppError.notFound("Toko Shopee");

  const [token] = await deps.db
    .select()
    .from(schema.shopeeTokens)
    .where(eq(schema.shopeeTokens.storeId, storeId))
    .limit(1);
  if (!token) {
    throw new AppError(
      "STORE_NOT_CONNECTED",
      "Toko ini belum terhubung ke Shopee. Selesaikan otorisasi terlebih dahulu.",
      409,
    );
  }

  const accessToken = decryptSecret(
    token.accessTokenEnc,
    deps.config.appEncryptionKey,
  );
  const needsRefresh =
    token.expiresAt.getTime() - REFRESH_SKEW_MS <= nowOf(deps).getTime();

  if (!needsRefresh) {
    return {
      store,
      access: { shopId: store.shopId, accessToken },
      expiresAt: token.expiresAt,
      refreshed: false,
    };
  }

  const refreshToken = decryptSecret(
    token.refreshTokenEnc,
    deps.config.appEncryptionKey,
  );
  try {
    const refreshed = await deps.gateway.refreshToken({
      shopId: store.shopId,
      refreshToken,
    });
    const expiresAt = await saveToken(deps, storeId, refreshed);
    if (store.status !== "CONNECTED") {
      await deps.db
        .update(schema.shopeeStores)
        .set({ status: "CONNECTED", lastError: null, updatedAt: nowOf(deps) })
        .where(eq(schema.shopeeStores.id, storeId));
    }
    return {
      store,
      access: { shopId: store.shopId, accessToken: refreshed.accessToken },
      expiresAt,
      refreshed: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markStoreError(deps, storeId, `refresh failed: ${message}`);
    throw new AppError(
      "TOKEN_REFRESH_FAILED",
      "Gagal memperbarui token Shopee. Otorisasi ulang toko ini.",
      409,
    );
  }
}

export function storeIsConnected(store: ShopeeStore): boolean {
  return store.status === "CONNECTED";
}
