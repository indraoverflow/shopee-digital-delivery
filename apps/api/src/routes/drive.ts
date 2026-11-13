import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@qansa/core";
import { currentUser, requirePermission } from "../auth.js";
import {
  completeDriveConnect,
  disconnectDrive,
  driveConnectUrl,
  driveStatus,
  failedDriveGrants,
  retryDriveGrant,
} from "@qansa/services";

/**
 * The shop's Google Drive connection and the shares the platform handed out.
 *
 * The callback is the one route here without a session: Google redirects the browser to
 * it, and the store is carried in the signed state instead of a cookie. Everything else
 * needs the console permissions, and the token itself is never returned to any client.
 */
export async function driveRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "store:read");
  const write = requirePermission(ctx, "store:write");
  const claimRead = requirePermission(ctx, "claim:read");
  const claimWrite = requirePermission(ctx, "claim:write");

  app.get<{ Params: { id: string } }>(
    "/api/admin/stores/:id/drive",
    { preHandler: read },
    async (request) => driveStatus(ctx.deps, request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/stores/:id/drive/connect",
    { preHandler: write },
    async (request) => ({
      url: await driveConnectUrl(ctx.deps, request.params.id),
    }),
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/admin/drive/callback",
    async (request, reply) => {
      const back = new URL("/admin/stores", ctx.config.adminOrigin);

      if (request.query.error || !request.query.code || !request.query.state) {
        back.searchParams.set("drive", "error");
        return reply.redirect(back.toString());
      }

      try {
        const result = await completeDriveConnect(ctx.deps, {
          code: request.query.code,
          state: request.query.state,
        });
        back.searchParams.set("drive", "ok");
        back.searchParams.set("account", result.accountEmail);
        back.searchParams.set("store", result.storeId);
      } catch {
        back.searchParams.set("drive", "error");
      }

      return reply.redirect(back.toString());
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/stores/:id/drive",
    { preHandler: write },
    async (request) => {
      const user = currentUser(request);
      await disconnectDrive(ctx.deps, {
        storeId: request.params.id,
        actor: { id: user.id, email: user.email },
      });
      return { ok: true };
    },
  );

  app.get<{ Querystring: { status?: string } }>(
    "/api/admin/drive-grants",
    { preHandler: claimRead },
    async (request) => {
      const status = request.query.status ?? "FAILED";
      if (status !== "FAILED")
        throw AppError.validation(
          "Hanya pembagian yang gagal bisa didaftar dari sini.",
        );
      return { data: await failedDriveGrants(ctx.deps, { limit: 50 }) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/drive-grants/:id/retry",
    { preHandler: claimWrite },
    async (request) => {
      const user = currentUser(request);
      const result = await retryDriveGrant(ctx.deps, {
        grantId: request.params.id,
        actor: { id: user.id, email: user.email },
      });
      return { ok: true, ...result };
    },
  );
}

export const driveQuerySchema = z.object({ status: z.string().optional() });
