import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, sha256Hex, signPayload, verifyPayload } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { ApiConfig } from "../env.js";
import { currentUser, requirePermission } from "../auth.js";
import { metaOf, paginate, paginationSchema } from "./common.js";
import { createSyncJob, enqueue, getStoreAccess, saveToken, markStoreError } from "@qansa/services";

/**
 * Store management: connect a Shopee shop through OAuth, keep an eye on its
 * token, and trigger catalogue/order sync. Tokens never leave the server: the
 * API reports only their expiry.
 */

const createStoreSchema = z.object({
  label: z.string().trim().min(2).max(80),
  shopId: z.coerce.number().int().positive(),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
  brandName: z.string().trim().max(80).optional(),
  supportEmail: z.string().trim().email().max(200).optional(),
  supportWhatsapp: z.string().trim().max(40).optional(),
  verificationPolicy: z.enum(["USERNAME", "USERNAME_PHONE", "MANUAL"]).default("USERNAME"),
});

const updateStoreSchema = z.object({
  label: z.string().trim().min(2).max(80).optional(),
  brandName: z.string().trim().max(80).nullable().optional(),
  supportEmail: z.string().trim().email().max(200).nullable().optional(),
  supportWhatsapp: z.string().trim().max(40).nullable().optional(),
  verificationPolicy: z.enum(["USERNAME", "USERNAME_PHONE", "MANUAL"]).optional(),
  eligibleStatuses: z.array(z.string().min(2).max(40)).min(1).max(12).optional(),
  claimDomain: z.string().trim().max(120).nullable().optional(),
});

/** The OAuth state is a signed, short-lived token, so a forged callback cannot attach a shop. */
function stateSecret(config: ApiConfig): string {
  return sha256Hex(`${config.service.appEncryptionKey}:oauth-state`);
}

export function buildAuthorizeState(config: ApiConfig, storeId: string): string {
  return signPayload(stateSecret(config), { storeId, exp: Math.floor(Date.now() / 1000) + 900 });
}

function readAuthorizeState(config: ApiConfig, state: string): string {
  const verified = verifyPayload<{ storeId: string; exp: number }>(stateSecret(config), state);
  if (!verified.ok) throw new AppError("OAUTH_STATE_INVALID", "Tautan otorisasi tidak valid atau sudah kedaluwarsa", 400);
  return verified.payload.storeId;
}

export async function storeRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "store:read");
  const write = requirePermission(ctx, "store:write");

  app.get("/api/admin/stores", { preHandler: read }, async () => {
    const stores = await ctx.db.select().from(schema.shopeeStores).orderBy(schema.shopeeStores.createdAt);
    const tokens = await ctx.db.select({ storeId: schema.shopeeTokens.storeId, expiresAt: schema.shopeeTokens.expiresAt }).from(schema.shopeeTokens);
    const expiry = new Map(tokens.map((row) => [row.storeId, row.expiresAt]));

    const counts = await ctx.db
      .select({ storeId: schema.orders.storeId, total: count() })
      .from(schema.orders)
      .groupBy(schema.orders.storeId);
    const orderCounts = new Map(counts.map((row) => [row.storeId, Number(row.total)]));

    return {
      data: stores.map((store) => ({
        id: store.id,
        shopId: store.shopId,
        label: store.label,
        shopName: store.shopName,
        region: store.region,
        environment: store.environment,
        status: store.status,
        brandName: store.brandName,
        verificationPolicy: store.verificationPolicy,
        eligibleStatuses: store.eligibleStatuses,
        lastProductSyncAt: store.lastProductSyncAt,
        lastOrderSyncAt: store.lastOrderSyncAt,
        lastError: store.lastError,
        tokenExpiresAt: expiry.get(store.id) ?? null,
        orders: orderCounts.get(store.id) ?? 0,
      })),
      gatewayMode: ctx.config.gatewayMode,
    };
  });

  app.post("/api/admin/stores", { preHandler: write }, async (request, reply) => {
    const body = createStoreSchema.parse(request.body);
    const user = currentUser(request);

    const [row] = await ctx.db
      .insert(schema.shopeeStores)
      .values({
        shopId: body.shopId,
        label: body.label,
        environment: body.environment,
        brandName: body.brandName ?? body.label,
        ...(body.supportEmail ? { supportEmail: body.supportEmail } : {}),
        ...(body.supportWhatsapp ? { supportWhatsapp: body.supportWhatsapp } : {}),
        verificationPolicy: body.verificationPolicy,
        status: "PENDING",
      })
      .onConflictDoNothing()
      .returning();

    if (!row) throw AppError.conflict("STORE_EXISTS", "Shop id ini sudah terdaftar untuk environment tersebut");

    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: "store.create",
      targetType: "store",
      targetId: row.id,
      metadata: { shopId: body.shopId, environment: body.environment },
      ip: request.ip,
    });

    return reply.code(201).send({ store: row });
  });

  app.get<{ Params: { id: string } }>("/api/admin/stores/:id", { preHandler: read }, async (request) => {
    const [store] = await ctx.db.select().from(schema.shopeeStores).where(eq(schema.shopeeStores.id, request.params.id)).limit(1);
    if (!store) throw AppError.notFound("Toko");

    const [token] = await ctx.db
      .select({ expiresAt: schema.shopeeTokens.expiresAt, updatedAt: schema.shopeeTokens.updatedAt })
      .from(schema.shopeeTokens)
      .where(eq(schema.shopeeTokens.storeId, store.id))
      .limit(1);

    const orderStats = await ctx.db
      .select({ state: schema.orders.state, total: count() })
      .from(schema.orders)
      .where(eq(schema.orders.storeId, store.id))
      .groupBy(schema.orders.state);

    const [productCount] = await ctx.db
      .select({ total: count() })
      .from(schema.shopeeProducts)
      .where(and(eq(schema.shopeeProducts.storeId, store.id), sql`${schema.shopeeProducts.deletedAt} is null`));

    return {
      store,
      token: token ? { expiresAt: token.expiresAt, updatedAt: token.updatedAt } : null,
      ordersByState: Object.fromEntries(orderStats.map((row) => [row.state, Number(row.total)])),
      products: Number(productCount?.total ?? 0),
      gatewayMode: ctx.config.gatewayMode,
    };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/stores/:id", { preHandler: write }, async (request) => {
    const body = updateStoreSchema.parse(request.body);
    const user = currentUser(request);

    const [row] = await ctx.db
      .update(schema.shopeeStores)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.shopeeStores.id, request.params.id))
      .returning();
    if (!row) throw AppError.notFound("Toko");

    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: "store.update",
      targetType: "store",
      targetId: row.id,
      metadata: body,
      ip: request.ip,
    });
    return { store: row };
  });

  /**
   * Two ways to authorize: the real Shopee consent screen, or, when the app runs
   * on the fixture gateway, a clearly labelled simulation. The simulation never
   * claims to be a live connection: the UI shows the gateway mode next to it.
   */
  app.post<{ Params: { id: string } }>("/api/admin/stores/:id/authorize", { preHandler: write }, async (request) => {
    const [store] = await ctx.db.select().from(schema.shopeeStores).where(eq(schema.shopeeStores.id, request.params.id)).limit(1);
    if (!store) throw AppError.notFound("Toko");

    const state = buildAuthorizeState(ctx.config, store.id);
    const url = ctx.gateway.buildAuthorizationUrl({ redirectUrl: `${ctx.config.redirectUrl}?state=${encodeURIComponent(state)}` });

    return {
      url,
      state,
      gatewayMode: ctx.config.gatewayMode,
      simulated: ctx.config.gatewayMode === "fixture",
      note:
        ctx.config.gatewayMode === "fixture"
          ? "Mode fixture: tautan ini tidak membuka persetujuan Shopee yang sebenarnya. Gunakan tombol simulasi untuk menyambungkan toko contoh."
          : undefined,
    };
  });

  app.post<{ Params: { id: string } }>("/api/admin/stores/:id/authorize/simulate", { preHandler: write }, async (request, reply) => {
    if (ctx.config.gatewayMode !== "fixture") {
      throw new AppError("SIMULATION_DISABLED", "Simulasi hanya tersedia saat gateway berjalan di mode fixture", 400);
    }
    const [store] = await ctx.db.select().from(schema.shopeeStores).where(eq(schema.shopeeStores.id, request.params.id)).limit(1);
    if (!store) throw AppError.notFound("Toko");

    const user = currentUser(request);
    const token = await ctx.gateway.exchangeCode({ code: "fixture-code", shopId: store.shopId });
    await saveToken(ctx.deps, store.id, token);

    let shopName = store.label;
    try {
      const info = await ctx.gateway.getShopInfo({ shopId: store.shopId, accessToken: token.accessToken });
      shopName = info.shopName ?? shopName;
    } catch {
      // The token is stored either way; the next sync will surface the error.
    }

    await ctx.db
      .update(schema.shopeeStores)
      .set({ status: "CONNECTED", shopName, lastError: null, updatedAt: new Date() })
      .where(eq(schema.shopeeStores.id, store.id));

    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: "store.authorize_simulated",
      targetType: "store",
      targetId: store.id,
      ip: request.ip,
    });

    return reply.code(200).send({ connected: true, simulated: true, shopName });
  });

  app.post<{ Params: { id: string } }>("/api/admin/stores/:id/refresh", { preHandler: write }, async (request) => {
    const result = await getStoreAccess(ctx.deps, request.params.id);
    const user = currentUser(request);

    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: "store.refresh_token",
      targetType: "store",
      targetId: request.params.id,
      metadata: { refreshed: result.refreshed },
      ip: request.ip,
    });

    return { refreshed: result.refreshed, expiresAt: result.expiresAt };
  });

  app.post<{ Params: { id: string } }>("/api/admin/stores/:id/disconnect", { preHandler: write }, async (request) => {
    const user = currentUser(request);
    await ctx.db.delete(schema.shopeeTokens).where(eq(schema.shopeeTokens.storeId, request.params.id));
    const [store] = await ctx.db
      .update(schema.shopeeStores)
      .set({ status: "DISCONNECTED", lastError: null, updatedAt: new Date() })
      .where(eq(schema.shopeeStores.id, request.params.id))
      .returning();
    if (!store) throw AppError.notFound("Toko");

    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: "store.disconnect",
      targetType: "store",
      targetId: store.id,
      ip: request.ip,
    });
    return { ok: true };
  });

  /** Shopee redirects the seller's browser here after consent. */
  app.get<{ Querystring: { code?: string; shop_id?: string; state?: string; main_account_id?: string } }>(
    "/api/integration/shopee/callback",
    async (request, reply) => {
      const { code, shop_id: shopIdRaw, state } = request.query;
      if (!code || !shopIdRaw || !state) {
        return reply.redirect(`${ctx.config.adminOrigin}/admin/stores?error=callback_incomplete`);
      }

      let storeId: string;
      try {
        storeId = readAuthorizeState(ctx.config, state);
      } catch {
        return reply.redirect(`${ctx.config.adminOrigin}/admin/stores?error=state_invalid`);
      }

      const shopId = Number(shopIdRaw);
      try {
        const [store] = await ctx.db.select().from(schema.shopeeStores).where(eq(schema.shopeeStores.id, storeId)).limit(1);
        if (!store) return reply.redirect(`${ctx.config.adminOrigin}/admin/stores?error=store_missing`);
        if (store.shopId !== shopId) return reply.redirect(`${ctx.config.adminOrigin}/admin/stores?error=shop_mismatch`);

        const token = await ctx.gateway.exchangeCode({ code, shopId });
        await saveToken(ctx.deps, store.id, token);
        const info = await ctx.gateway.getShopInfo({ shopId, accessToken: token.accessToken });

        await ctx.db
          .update(schema.shopeeStores)
          .set({ status: "CONNECTED", shopName: info.shopName ?? store.label, region: info.region, lastError: null, updatedAt: new Date() })
          .where(eq(schema.shopeeStores.id, store.id));

        await ctx.audit({ actorType: "SYSTEM", action: "store.authorized", targetType: "store", targetId: store.id, ip: request.ip });
        return reply.redirect(`${ctx.config.adminOrigin}/admin/stores/${store.id}?connected=1`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        await markStoreError(ctx.deps, storeId, `authorization failed: ${message}`);
        await ctx.audit({ actorType: "SYSTEM", action: "store.authorization_failed", targetType: "store", targetId: storeId, metadata: { message } });
        return reply.redirect(`${ctx.config.adminOrigin}/admin/stores/${storeId}?error=exchange_failed`);
      }
    },
  );

  for (const type of ["products", "orders"] as const) {
    const jobType = type === "products" ? "SYNC_PRODUCTS" : "SYNC_ORDERS";

    app.post<{ Params: { id: string } }>(`/api/admin/stores/:id/sync/${type}`, { preHandler: write }, async (request) => {
      const [store] = await ctx.db.select().from(schema.shopeeStores).where(eq(schema.shopeeStores.id, request.params.id)).limit(1);
      if (!store) throw AppError.notFound("Toko");

      // A scheduled sweep may already sit in the queue with a future run time.
      // A manual click must not be swallowed by that dedupe key: pull the job
      // forward instead of reporting "already running" for something idle.
      const [pending] = await ctx.db
        .select({ id: schema.jobs.id, status: schema.jobs.status })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, jobType), inArray(schema.jobs.status, ["QUEUED", "RUNNING"]), sql`${schema.jobs.payload}->>'storeId' = ${store.id}`))
        .limit(1);

      if (pending?.status === "RUNNING") {
        return { queued: false, jobId: pending.id, message: "Sinkronisasi untuk toko ini sedang berjalan" };
      }

      if (pending) {
        await ctx.db.update(schema.jobs).set({ runAt: new Date(), lastError: null }).where(eq(schema.jobs.id, pending.id));
        return { queued: true, jobId: pending.id, message: "Sinkronisasi dijadwalkan ulang sekarang" };
      }

      const syncJobId = await createSyncJob(ctx.deps, { storeId: store.id, type: type === "products" ? "PRODUCTS" : "ORDERS", triggeredBy: currentUser(request).email });
      const jobId = await enqueue(ctx.deps, { type: jobType, payload: { storeId: store.id, syncJobId }, dedupeKey: `${jobType}:${store.id}` });

      return { queued: true, jobId, syncJobId };
    });
  }

  app.get("/api/admin/sync-jobs", { preHandler: read }, async (request) => {
    const query = paginationSchema
      .extend({ storeId: z.string().uuid().optional(), status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD"]).optional() })
      .parse(request.query);
    const filters = [
      ...(query.storeId ? [eq(schema.syncJobs.storeId, query.storeId)] : []),
      ...(query.status ? [eq(schema.syncJobs.status, query.status)] : []),
    ];
    const where = filters.length ? and(...filters) : undefined;

    const rows = await ctx.db
      .select({ job: schema.syncJobs, storeLabel: schema.shopeeStores.label })
      .from(schema.syncJobs)
      .innerJoin(schema.shopeeStores, eq(schema.shopeeStores.id, schema.syncJobs.storeId))
      .where(where)
      .orderBy(desc(schema.syncJobs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const [total] = await ctx.db.select({ value: count() }).from(schema.syncJobs).where(where);
    return paginate(
      rows.map((row) => ({ ...row.job, storeLabel: row.storeLabel })),
      query.page,
      query.pageSize,
      Number(total?.value ?? 0),
    );
  });

  /** Stores whose token lapses soon, for the monitoring page. */
  app.get("/api/admin/stores/token-health", { preHandler: read }, async () => {
    const rows = await ctx.db
      .select({ storeId: schema.shopeeStores.id, label: schema.shopeeStores.label, expiresAt: schema.shopeeTokens.expiresAt, status: schema.shopeeStores.status })
      .from(schema.shopeeStores)
      .leftJoin(schema.shopeeTokens, eq(schema.shopeeTokens.storeId, schema.shopeeStores.id))
      .where(isNotNull(schema.shopeeStores.id));

    return {
      data: rows.map((row) => ({
        ...row,
        minutesLeft: row.expiresAt ? Math.round((row.expiresAt.getTime() - Date.now()) / 60_000) : null,
      })),
    };
  });
}

export { metaOf };
