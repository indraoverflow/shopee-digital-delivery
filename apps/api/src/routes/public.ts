import { z } from "zod";
import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CLAIM_COOKIE } from "../auth.js";
import { accessDelivery, getClaimSessionView, loadClaimSession, resolveDownload, verifyClaim } from "@qansa/services";

/**
 * The public surface: the claim portal, the signed download endpoint and the
 * health probes. Nothing here requires a session except the steps that follow a
 * verified claim.
 */

const verifySchema = z.object({
  orderSn: z.string().trim().min(6).max(64),
  buyerUsername: z.string().trim().max(120).optional(),
  phoneSuffix: z.string().trim().max(16).optional(),
});

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get("/api/public/config", async () => {
    const settings = await ctx.settings();
    return {
      branding: settings.branding,
      claim: {
        requiresBuyerUsername: true,
        sessionMinutes: settings.claim.sessionMinutes,
        downloadTtlMinutes: settings.claim.downloadTtlMinutes,
      },
      gatewayMode: ctx.config.gatewayMode,
    };
  });

  app.post(
    "/api/claim/verify",
    {
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = verifySchema.parse(request.body);
      const verified = await verifyClaim(ctx.deps, {
        orderSn: body.orderSn,
        buyerUsername: body.buyerUsername,
        phoneSuffix: body.phoneSuffix,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });

      reply.setCookie(CLAIM_COOKIE, verified.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: ctx.config.sessionCookieSecure,
        path: "/",
        maxAge: Math.max(60, Math.floor((verified.expiresAt.getTime() - Date.now()) / 1000)),
      });

      return { orderSn: verified.orderSn, expiresAt: verified.expiresAt.toISOString() };
    },
  );

  app.get("/api/claim/session", async (request) => {
    const token = request.cookies[CLAIM_COOKIE];
    if (!token) throw AppError.unauthorized("Belum ada sesi klaim. Masukkan nomor pesanan Anda.");
    const view = await getClaimSessionView(ctx.deps, token);
    if (!view) throw AppError.unauthorized("Sesi klaim sudah berakhir. Verifikasi ulang pesanan Anda.");
    return view;
  });

  app.post<{ Params: { id: string } }>("/api/claim/fulfillments/:id/access", async (request) => {
    const token = request.cookies[CLAIM_COOKIE];
    if (!token) throw AppError.unauthorized("Sesi klaim sudah berakhir. Verifikasi ulang pesanan Anda.");

    const payload = await accessDelivery(ctx.deps, {
      token,
      fulfillmentId: request.params.id,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
    return { delivery: payload };
  });

  app.post("/api/claim/logout", async (request, reply) => {
    const token = request.cookies[CLAIM_COOKIE];
    if (token) {
      const session = await loadClaimSession(ctx.deps, token);
      if (session) {
        await ctx.db.delete(schema.claimSessions).where(eq(schema.claimSessions.id, session.session.id));
      }
    }
    reply.clearCookie(CLAIM_COOKIE, { path: "/" });
    return { ok: true };
  });

  /**
   * Signed downloads. The token proves the link was issued by a reveal, and the
   * database checks prove the claim is still live; a revoked claim kills every
   * link already handed out.
   */
  app.get<{ Params: { token: string } }>(
    "/api/claim/download/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const resolved = await resolveDownload(ctx.deps, request.params.token, request.ip);
      const { stream, sizeBytes } = await ctx.assets.read(resolved.storageKey);

      reply
        .header("content-type", resolved.mimeType)
        .header("content-length", String(sizeBytes))
        .header("content-disposition", `attachment; filename="${resolved.fileName.replace(/"/g, "")}"`)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff");
      return reply.send(stream);
    },
  );

  app.get("/health", async () => ({ ok: true, gatewayMode: ctx.config.gatewayMode, environment: ctx.config.nodeEnv }));

  app.get("/ready", async (_request, reply) => {
    try {
      await ctx.db.execute(ctx.sql`select 1`);
      return { ok: true };
    } catch (error) {
      return reply.code(503).send({ ok: false, error: error instanceof Error ? error.message : "database unreachable" });
    }
  });
}
