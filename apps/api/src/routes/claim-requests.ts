import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requirePermission } from "../auth.js";
import {
  createClaimRequest,
  listClaimRequests,
  reviewClaimRequest,
} from "@qansa/services";

/**
 * Manual verification, both sides: the buyer asks, an operator decides.
 *
 * The public endpoint is rate limited and answers identically for an unknown
 * order and a wrong username, so it cannot be used to enumerate orders.
 */

const createSchema = z.object({
  orderSn: z.string().trim().min(6).max(64),
  buyerUsername: z.string().trim().min(1).max(120),
  contact: z.string().trim().min(5).max(200),
  note: z.string().trim().max(500).optional(),
});

const reviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().max(500).optional(),
  hours: z.coerce.number().int().min(1).max(168).optional(),
});

export async function claimRequestRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.post(
    "/api/claim/request",
    { config: { rateLimit: { max: 8, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      const result = await createClaimRequest(ctx.deps, {
        ...body,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return reply.code(result.existing ? 200 : 201).send({
        ...result,
        message: result.existing
          ? "Permintaan Anda sudah kami terima dan sedang diperiksa."
          : "Permintaan terkirim. Tim kami akan memeriksa pesanan Anda dan menghubungi melalui kontak yang Anda berikan.",
      });
    },
  );

  app.get(
    "/api/admin/claim-requests",
    { preHandler: requirePermission(ctx, "claim:read") },
    async (request) => {
      const query = z
        .object({
          status: z
            .enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"])
            .optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(request.query);

      return listClaimRequests(ctx.deps, query);
    },
  );

  app.post(
    "/api/admin/claim-requests/:id/review",
    { preHandler: requirePermission(ctx, "claim:write") },
    async (request) => {
      const user = currentUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = reviewSchema.parse(request.body);
      const result = await reviewClaimRequest(ctx.deps, {
        requestId: id,
        decision: body.decision,
        note: body.note,
        hours: body.hours,
        actor: { id: user.id, email: user.email },
        ip: request.ip,
      });
      return { ok: true, ...result };
    },
  );
}
