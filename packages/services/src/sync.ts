import { schema } from "@qansa/db";
import type { ShopeeStore } from "@qansa/db";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { notify } from "./notify.js";
import { processOrderDetail, type ProcessSummary } from "./orders.js";
import { getStoreAccess, markStoreError } from "./tokens.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Catalog and order synchronisation. Both are driven by the worker, both are
 * idempotent, and both record their result on a sync_jobs row so the admin
 * dashboard can show what happened rather than guess.
 */

export interface SyncStats {
  [key: string]: number | string | boolean | null;
}

export async function createSyncJob(
  deps: ServiceDeps,
  input: { storeId: string; type: "PRODUCTS" | "ORDERS"; triggeredBy: string },
): Promise<string> {
  const [row] = await deps.db
    .insert(schema.syncJobs)
    .values({
      storeId: input.storeId,
      type: input.type,
      triggeredBy: input.triggeredBy,
      status: "QUEUED",
    })
    .returning({ id: schema.syncJobs.id });
  return row!.id;
}

async function finishSyncJob(
  deps: ServiceDeps,
  jobId: string | null,
  status: "RUNNING" | "SUCCEEDED" | "FAILED",
  patchValues: { stats?: SyncStats; error?: string | null },
): Promise<void> {
  if (!jobId) return;
  await deps.db
    .update(schema.syncJobs)
    .set({
      status,
      ...(patchValues.stats ? { stats: patchValues.stats } : {}),
      ...(patchValues.error !== undefined ? { error: patchValues.error } : {}),
      ...(status === "RUNNING"
        ? { startedAt: nowOf(deps) }
        : { finishedAt: nowOf(deps) }),
    })
    .where(eq(schema.syncJobs.id, jobId));
}

/**
 * Pulls the whole catalog. Products that Shopee no longer returns are soft
 * deleted, never removed: an order from last month still points at them and the
 * mapping history has to survive.
 */
export async function runProductSync(
  deps: ServiceDeps,
  input: { storeId: string; syncJobId?: string | null },
): Promise<SyncStats> {
  const jobId = input.syncJobId ?? null;
  await finishSyncJob(deps, jobId, "RUNNING", {});

  try {
    const { store, access } = await getStoreAccess(deps, input.storeId);
    const { products, truncated } = await deps.gateway.listProducts(access, {
      maxPages: 200,
    });

    const now = nowOf(deps);
    let created = 0;
    let updated = 0;
    let variations = 0;
    const seenItemIds: number[] = [];

    for (const product of products) {
      seenItemIds.push(product.itemId);

      const [existing] = await deps.db
        .select({ id: schema.shopeeProducts.id })
        .from(schema.shopeeProducts)
        .where(
          and(
            eq(schema.shopeeProducts.storeId, store.id),
            eq(schema.shopeeProducts.itemId, product.itemId),
          ),
        )
        .limit(1);

      const values = {
        storeId: store.id,
        itemId: product.itemId,
        name: product.name,
        status: product.status,
        imageUrl: product.imageUrl,
        hasModel: product.hasModel,
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        raw: product.raw,
        syncedAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      let productRowId: string;
      if (existing) {
        const [row] = await deps.db
          .update(schema.shopeeProducts)
          .set(values)
          .where(eq(schema.shopeeProducts.id, existing.id))
          .returning({ id: schema.shopeeProducts.id });
        productRowId = row!.id;
        updated += 1;
      } else {
        const [row] = await deps.db
          .insert(schema.shopeeProducts)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.shopeeProducts.storeId,
              schema.shopeeProducts.itemId,
            ],
            set: values,
          })
          .returning({ id: schema.shopeeProducts.id });
        productRowId = row!.id;
        created += 1;
      }

      for (const variation of product.variations) {
        await deps.db
          .insert(schema.shopeeVariations)
          .values({
            productId: productRowId,
            modelId: variation.modelId,
            name: variation.name,
            sku: variation.sku,
            price: variation.price,
            stock: variation.stock,
            raw: variation.raw,
            syncedAt: now,
            deletedAt: null,
          })
          .onConflictDoUpdate({
            target: [
              schema.shopeeVariations.productId,
              schema.shopeeVariations.modelId,
            ],
            set: {
              name: variation.name,
              sku: variation.sku,
              price: variation.price,
              stock: variation.stock,
              raw: variation.raw,
              syncedAt: now,
              deletedAt: null,
            },
          });
        variations += 1;

        // A variation that vanished from the listing must not stay mappable.
        const keptModelIds = product.variations.map((entry) => entry.modelId);
        if (keptModelIds.length > 0) {
          await deps.db
            .update(schema.shopeeVariations)
            .set({ deletedAt: now })
            .where(
              and(
                eq(schema.shopeeVariations.productId, productRowId),
                isNull(schema.shopeeVariations.deletedAt),
                notInArray(schema.shopeeVariations.modelId, keptModelIds),
              ),
            );
        }
      }
    }

    let removed = 0;
    if (!truncated && seenItemIds.length > 0) {
      const dropped = await deps.db
        .update(schema.shopeeProducts)
        .set({ deletedAt: now, status: "DELETED", updatedAt: now })
        .where(
          and(
            eq(schema.shopeeProducts.storeId, store.id),
            isNull(schema.shopeeProducts.deletedAt),
            notInArray(schema.shopeeProducts.itemId, seenItemIds),
          ),
        )
        .returning({ id: schema.shopeeProducts.id });
      removed = dropped.length;
    }

    await deps.db
      .update(schema.shopeeStores)
      .set({
        lastProductSyncAt: now,
        status: "CONNECTED",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(schema.shopeeStores.id, store.id));

    const stats: SyncStats = {
      items: products.length,
      created,
      updated,
      variations,
      removed,
      truncated,
    };
    await finishSyncJob(deps, jobId, "SUCCEEDED", { stats, error: null });
    deps.logger.info(stats, "product sync finished");
    return stats;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncJob(deps, jobId, "FAILED", { error: message });
    await markStoreError(
      deps,
      input.storeId,
      `product sync failed: ${message}`,
    );
    await notify(deps, {
      type: "sync.failed",
      title: `Sinkronisasi produk gagal (${message})`,
      data: {
        storeId: input.storeId,
        job: "SYNC_PRODUCTS",
        error: message.slice(0, 200),
      },
    });
    throw error;
  }
}

export interface OrderSyncResult extends SyncStats {
  processed: number;
  failed: number;
  claimable: number;
}

/**
 * Reconciliation by `update_time`. Pushes are not guaranteed, so this is the
 * safety net: every order whose state changed in the window is re-read and run
 * through the same pipeline a push would trigger.
 */
export async function runOrderSync(
  deps: ServiceDeps,
  input: { storeId: string; syncJobId?: string | null; lookbackHours?: number },
): Promise<OrderSyncResult> {
  const jobId = input.syncJobId ?? null;
  await finishSyncJob(deps, jobId, "RUNNING", {});

  try {
    const { store, access } = await getStoreAccess(deps, input.storeId);
    const to = Math.floor(nowOf(deps).getTime() / 1000);
    const hours = input.lookbackHours ?? deps.config.orderLookbackHours;
    const from = to - Math.floor(hours * 3600);

    const listed = await deps.gateway.listOrdersByUpdateTime(access, {
      from,
      to,
      maxPages: 40,
    });
    let processed = 0;
    let failed = 0;
    let claimable = 0;

    for (let index = 0; index < listed.orderSns.length; index += 50) {
      const batch = listed.orderSns.slice(index, index + 50);
      const details = await deps.gateway.getOrders(access, batch);
      for (const detail of details) {
        try {
          const summary: ProcessSummary = await processOrderDetail(
            deps,
            store as ShopeeStore,
            detail,
          );
          processed += 1;
          if (summary.state === "FULFILLED" || summary.state === "CLAIMED")
            claimable += 1;
        } catch (error) {
          failed += 1;
          deps.logger.warn(
            {
              orderSn: detail.orderSn,
              err: error instanceof Error ? error.message : String(error),
            },
            "order failed inside a sweep",
          );
        }
      }
    }

    const now = nowOf(deps);
    await deps.db
      .update(schema.shopeeStores)
      .set({
        lastOrderSyncAt: now,
        status: "CONNECTED",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(schema.shopeeStores.id, store.id));

    const stats: OrderSyncResult = {
      listed: listed.orderSns.length,
      processed,
      failed,
      claimable,
      truncated: listed.truncated,
      windowHours: hours,
    };
    await finishSyncJob(deps, jobId, "SUCCEEDED", { stats, error: null });
    deps.logger.info(stats, "order sync finished");
    return stats;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncJob(deps, jobId, "FAILED", { error: message });
    await markStoreError(deps, input.storeId, `order sync failed: ${message}`);
    await notify(deps, {
      type: "sync.failed",
      title: `Sinkronisasi pesanan gagal (${message})`,
      data: {
        storeId: input.storeId,
        job: "SYNC_ORDERS",
        error: message.slice(0, 200),
      },
    });
    throw error;
  }
}

export async function storesNeedingSync(
  deps: ServiceDeps,
): Promise<ShopeeStore[]> {
  return deps.db
    .select()
    .from(schema.shopeeStores)
    .where(and(eq(schema.shopeeStores.status, "CONNECTED"), sql`true`));
}
