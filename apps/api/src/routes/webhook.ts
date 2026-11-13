import type { FastifyInstance } from "fastify";
import { parsePushEvent, verifyPushSignature } from "shopee-integration";
import { sha256Hex } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, eq } from "drizzle-orm";
import { enqueue } from "@qansa/services";

/**
 * Shopee Push receiver.
 *
 * Shopee waits for this response, so the handler verifies, records and enqueues,
 * then answers. It never fetches order details inline: a slow ack makes Shopee
 * retry, and the retry is only harmless because the queue dedupes on the push
 * body and the pipeline is idempotent.
 */

/** Push codes worth acting on. Everything else is recorded and ignored. */
const CODE_ORDER_STATUS = 3;
const CODE_SHOP_DEAUTHORIZED = 2;

interface PushPayload {
  code?: number;
  shop_id?: number;
  timestamp?: number;
  data?: { ordersn?: string; order_sn?: string; status?: string };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.post(
    "/webhook/shopee",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const rawBody = (request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}))).toString("utf8");
      const bodyHash = sha256Hex(rawBody);

      /**
       * A deployment without SHOPEE_PUSH_URL cannot check any signature, so in
       * production it refuses every push rather than accepting unauthenticated
       * ones. Outside production the push is accepted and logged as unverified,
       * which is what makes the fixture demo work.
       */
      if (!ctx.config.pushUrl && ctx.config.nodeEnv === "production") {
        ctx.logger.error({}, "SHOPEE_PUSH_URL is unset in production: refusing every push");
        return reply.code(503).send({ error: "push endpoint is not configured" });
      }

      const signatureValid = ctx.config.pushUrl
        ? verifyPushSignature({
            partnerKey: ctx.config.partnerKey,
            url: ctx.config.pushUrl,
            rawBody,
            signature: String(request.headers.authorization ?? ""),
            alternateKeys: ctx.config.pushTestPartnerKey ? [ctx.config.pushTestPartnerKey] : [],
          })
        : (ctx.logger.warn({}, "SHOPEE_PUSH_URL is unset; accepting an unverified push outside production"), true);

      let event: PushPayload;
      try {
        event = parsePushEvent(rawBody) as PushPayload;
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid payload" });
      }

      const shopId = typeof event.shop_id === "number" ? event.shop_id : undefined;
      const orderSn = event.data?.ordersn ?? event.data?.order_sn;

      /**
       * Signature before duplicate detection. Checking the body hash first made a
       * replayed body answer "duplicate" instead of "invalid signature", which
       * told an attacker their payload had been seen. A rejected push is still
       * recorded once, for forensics.
       */
      if (!signatureValid) {
        await ctx.db
          .insert(schema.webhookEvents)
          .values({
            // A rejected body gets its own hash namespace: otherwise a forged
            // attempt would occupy the hash of a body Shopee later sends for
            // real, and the genuine push would be dropped as a duplicate.
            bodyHash: sha256Hex(`invalid:${bodyHash}`),
            code: event.code ?? null,
            shopId: shopId ?? null,
            orderSn: orderSn ?? null,
            signatureValid: false,
            status: "FAILED",
            payload: event as unknown as Record<string, unknown>,
            error: "invalid push signature",
          })
          .onConflictDoNothing();
        return reply.code(401).send({ error: "invalid push signature" });
      }

      // The body hash is the duplicate guard: Shopee retries the same push, and
      // a retry must not create a second order or a second fulfilment.
      const [record] = await ctx.db
        .insert(schema.webhookEvents)
        .values({
          bodyHash,
          code: event.code ?? null,
          shopId: shopId ?? null,
          orderSn: orderSn ?? null,
          signatureValid: true,
          status: "RECEIVED",
          payload: event as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing()
        .returning({ id: schema.webhookEvents.id });

      if (!record) {
        // Already stored: acknowledge so Shopee stops retrying, and say why.
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      const [store] = shopId
        ? await ctx.db
            .select()
            .from(schema.shopeeStores)
            .where(and(eq(schema.shopeeStores.shopId, shopId), eq(schema.shopeeStores.environment, ctx.config.shopeeEnv === "production" ? "PRODUCTION" : "SANDBOX")))
            .limit(1)
        : [];

      if (!store) {
        await ctx.db
          .update(schema.webhookEvents)
          .set({ status: "IGNORED", error: shopId ? `no store registered for shop ${shopId}` : "push has no shop_id", processedAt: new Date() })
          .where(eq(schema.webhookEvents.id, record.id));
        return reply.code(200).send({ ok: true, ignored: true });
      }

      await ctx.db.update(schema.webhookEvents).set({ storeId: store.id }).where(eq(schema.webhookEvents.id, record.id));

      if (event.code === CODE_ORDER_STATUS && orderSn) {
        await enqueue(ctx.deps, {
          type: "PROCESS_ORDER",
          payload: { storeId: store.id, orderSn, webhookEventId: record.id },
          dedupeKey: `order:${store.id}:${orderSn}`,
        });
        await ctx.db
          .update(schema.webhookEvents)
          .set({ status: "PROCESSED", processedAt: new Date() })
          .where(eq(schema.webhookEvents.id, record.id));
        return reply.code(200).send({ ok: true, queued: true });
      }

      if (event.code === CODE_SHOP_DEAUTHORIZED) {
        await ctx.db.delete(schema.shopeeTokens).where(eq(schema.shopeeTokens.storeId, store.id));
        await ctx.db
          .update(schema.shopeeStores)
          .set({ status: "DISCONNECTED", lastError: "Shopee revoked the authorization", updatedAt: new Date() })
          .where(eq(schema.shopeeStores.id, store.id));
        await ctx.db
          .update(schema.webhookEvents)
          .set({ status: "PROCESSED", processedAt: new Date() })
          .where(eq(schema.webhookEvents.id, record.id));
        return reply.code(200).send({ ok: true, disconnected: true });
      }

      await ctx.db
        .update(schema.webhookEvents)
        .set({ status: "IGNORED", processedAt: new Date(), error: `push code ${event.code ?? "unknown"} has no handler` })
        .where(eq(schema.webhookEvents.id, record.id));

      return reply.code(200).send({ ok: true, ignored: true });
    },
  );

  /** Operator-only view of the raw push log, useful when Shopee says it sent something. */
  app.get("/api/admin/webhook-events", { preHandler: async (request) => app.ctx.requirePermissionFor(request, "monitoring:read") }, async (request) => {
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 50), 200);
    const rows = await ctx.db
      .select({
        id: schema.webhookEvents.id,
        code: schema.webhookEvents.code,
        shopId: schema.webhookEvents.shopId,
        orderSn: schema.webhookEvents.orderSn,
        status: schema.webhookEvents.status,
        signatureValid: schema.webhookEvents.signatureValid,
        error: schema.webhookEvents.error,
        receivedAt: schema.webhookEvents.receivedAt,
      })
      .from(schema.webhookEvents)
      .orderBy(schema.webhookEvents.receivedAt)
      .limit(limit);
    return { data: rows };
  });
}
