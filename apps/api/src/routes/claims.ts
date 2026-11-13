import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { currentUser, requirePermission } from "../auth.js";
import { paginate, paginationSchema } from "./common.js";
import {
  mintFulfillmentLink,
  reissueFulfillment,
  revealMintedLink,
  revokeClaim,
} from "@qansa/services";

/**
 * Claim operations: history, revocation and reissue. A revoked claim stops every
 * download link it issued, because the download route re-checks the claim row.
 */

export async function claimRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "claim:read");
  const write = requirePermission(ctx, "claim:write");

  app.get("/api/admin/claims", { preHandler: read }, async (request) => {
    const query = paginationSchema
      .extend({
        status: z
          .enum(["ISSUED", "COMPLETED", "REVOKED", "EXPIRED", "BLOCKED"])
          .optional(),
        query: z.string().trim().max(120).optional(),
        storeId: z.string().uuid().optional(),
      })
      .parse(request.query);

    const filters = [
      ...(query.status ? [eq(schema.claims.status, query.status)] : []),
      ...(query.storeId
        ? [eq(schema.fulfillments.storeId, query.storeId)]
        : []),
      ...(query.query
        ? [sql`${schema.orders.orderSn} ilike ${`%${query.query}%`}`]
        : []),
    ];
    const where = filters.length ? and(...filters) : undefined;

    const rows = await ctx.db
      .select({
        claim: schema.claims,
        orderSn: schema.orders.orderSn,
        buyerUsername: schema.orders.buyerUsername,
        productName: schema.digitalProducts.name,
        deliveryKind: schema.digitalProducts.deliveryKind,
        fulfillmentStatus: schema.fulfillments.status,
        storeLabel: schema.shopeeStores.label,
      })
      .from(schema.claims)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.claims.orderId))
      .innerJoin(
        schema.digitalProducts,
        eq(schema.digitalProducts.id, schema.claims.digitalProductId),
      )
      .innerJoin(
        schema.fulfillments,
        eq(schema.fulfillments.id, schema.claims.fulfillmentId),
      )
      .innerJoin(
        schema.shopeeStores,
        eq(schema.shopeeStores.id, schema.fulfillments.storeId),
      )
      .where(where)
      .orderBy(desc(schema.claims.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const [total] = await ctx.db
      .select({ value: count() })
      .from(schema.claims)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.claims.orderId))
      .innerJoin(
        schema.fulfillments,
        eq(schema.fulfillments.id, schema.claims.fulfillmentId),
      )
      .where(where);

    return paginate(
      rows.map((row) => ({
        id: row.claim.id,
        orderId: row.claim.orderId,
        orderSn: row.orderSn,
        buyerUsername: row.buyerUsername,
        productName: row.productName,
        deliveryKind: row.deliveryKind,
        storeLabel: row.storeLabel,
        status: row.claim.status,
        fulfillmentStatus: row.fulfillmentStatus,
        fulfillmentId: row.claim.fulfillmentId,
        verificationMethod: row.claim.verificationMethod,
        deliveriesUsed: row.claim.deliveriesUsed,
        completedAt: row.claim.completedAt,
        revokedAt: row.claim.revokedAt,
        revokeReason: row.claim.revokeReason,
        createdAt: row.claim.createdAt,
        ip: row.claim.ip,
      })),
      query.page,
      query.pageSize,
      Number(total?.value ?? 0),
    );
  });

  /**
   * Mint the per-buyer link for an e-Meterai fulfilment. Idempotent: a second call
   * returns the stored link, because a mint costs money at the supplier.
   */
  app.post<{ Params: { id: string } }>(
    "/api/admin/fulfillments/:id/mint",
    { preHandler: write },
    async (request) => {
      const user = currentUser(request);
      const result = await mintFulfillmentLink(ctx.deps, {
        fulfillmentId: request.params.id,
        actor: { id: user.id, email: user.email },
        ip: request.ip,
      });
      return { ok: true, ...result };
    },
  );

  /**
   * Show the minted link to an operator so they can resend it when the buyer lost it.
   * Reading is audited: the link is worth money and belongs to one buyer.
   */
  app.get<{ Params: { id: string } }>(
    "/api/admin/fulfillments/:id/minted-link",
    { preHandler: read },
    async (request) => {
      const user = currentUser(request);
      const result = await revealMintedLink(ctx.deps, {
        fulfillmentId: request.params.id,
        actor: { id: user.id, email: user.email },
        ip: request.ip,
      });
      return { ok: true, ...result };
    },
  );

  app.get("/api/admin/fulfillments", { preHandler: read }, async (request) => {
    const query = paginationSchema
      .extend({
        status: z
          .enum([
            "PENDING",
            "CLAIMABLE",
            "CLAIMED",
            "REVOKED",
            "EXPIRED",
            "FAILED",
          ])
          .optional(),
        storeId: z.string().uuid().optional(),
      })
      .parse(request.query);

    const filters = [
      ...(query.status ? [eq(schema.fulfillments.status, query.status)] : []),
      ...(query.storeId
        ? [eq(schema.fulfillments.storeId, query.storeId)]
        : []),
    ];
    const where = filters.length ? and(...filters) : undefined;

    const rows = await ctx.db
      .select({
        fulfillment: schema.fulfillments,
        orderSn: schema.orders.orderSn,
        buyerUsername: schema.orders.buyerUsername,
        productName: schema.digitalProducts.name,
      })
      .from(schema.fulfillments)
      .innerJoin(
        schema.orders,
        eq(schema.orders.id, schema.fulfillments.orderId),
      )
      .innerJoin(
        schema.digitalProducts,
        eq(schema.digitalProducts.id, schema.fulfillments.digitalProductId),
      )
      .where(where)
      .orderBy(desc(schema.fulfillments.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const [total] = await ctx.db
      .select({ value: count() })
      .from(schema.fulfillments)
      .where(where);
    return paginate(
      rows.map((row) => ({
        ...row.fulfillment,
        orderSn: row.orderSn,
        buyerUsername: row.buyerUsername,
        productName: row.productName,
      })),
      query.page,
      query.pageSize,
      Number(total?.value ?? 0),
    );
  });

  app.post<{ Params: { id: string } }>(
    "/api/admin/claims/:id/revoke",
    { preHandler: write },
    async (request) => {
      const body = z
        .object({ reason: z.string().trim().min(4).max(300) })
        .parse(request.body);
      const user = currentUser(request);
      await revokeClaim(ctx.deps, {
        claimId: request.params.id,
        reason: body.reason,
        actorLabel: user.email,
        actorId: user.id,
        ip: request.ip,
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/fulfillments/:id/reissue",
    { preHandler: write },
    async (request) => {
      const body = z
        .object({
          reason: z.string().trim().min(4).max(300),
          extendDays: z.coerce.number().int().min(1).max(90).default(7),
        })
        .parse(request.body);
      const user = currentUser(request);
      await reissueFulfillment(ctx.deps, {
        fulfillmentId: request.params.id,
        reason: body.reason,
        extendDays: body.extendDays,
        actorLabel: user.email,
        actorId: user.id,
        ip: request.ip,
      });
      return { ok: true };
    },
  );

  app.get(
    "/api/admin/claim-attempts",
    { preHandler: read },
    async (request) => {
      const query = paginationSchema
        .extend({
          orderSn: z.string().trim().max(64).optional(),
          success: z.enum(["true", "false"]).optional(),
        })
        .parse(request.query);
      const filters = [
        ...(query.orderSn
          ? [eq(schema.claimAttempts.orderSn, query.orderSn)]
          : []),
        ...(query.success
          ? [eq(schema.claimAttempts.success, query.success === "true")]
          : []),
      ];
      const where = filters.length ? and(...filters) : undefined;

      const rows = await ctx.db
        .select()
        .from(schema.claimAttempts)
        .where(where)
        .orderBy(desc(schema.claimAttempts.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await ctx.db
        .select({ value: count() })
        .from(schema.claimAttempts)
        .where(where);
      return paginate(
        rows,
        query.page,
        query.pageSize,
        Number(total?.value ?? 0),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/claims/:id",
    { preHandler: read },
    async (request) => {
      const [row] = await ctx.db
        .select({
          claim: schema.claims,
          order: schema.orders,
          product: schema.digitalProducts,
          fulfillment: schema.fulfillments,
        })
        .from(schema.claims)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.claims.orderId))
        .innerJoin(
          schema.digitalProducts,
          eq(schema.digitalProducts.id, schema.claims.digitalProductId),
        )
        .innerJoin(
          schema.fulfillments,
          eq(schema.fulfillments.id, schema.claims.fulfillmentId),
        )
        .where(eq(schema.claims.id, request.params.id))
        .limit(1);
      if (!row) throw AppError.notFound("Klaim");

      const logs = await ctx.db
        .select()
        .from(schema.deliveryLogs)
        .where(eq(schema.deliveryLogs.claimId, row.claim.id))
        .orderBy(desc(schema.deliveryLogs.createdAt));
      return {
        claim: row.claim,
        order: {
          id: row.order.id,
          orderSn: row.order.orderSn,
          state: row.order.state,
          buyerUsername: row.order.buyerUsername,
        },
        product: {
          id: row.product.id,
          name: row.product.name,
          deliveryKind: row.product.deliveryKind,
        },
        fulfillment: row.fulfillment,
        deliveries: logs,
      };
    },
  );
}
