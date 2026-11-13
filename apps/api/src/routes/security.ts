import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, verifyAuditChain } from "@qansa/core";
import { currentUser, requirePermission } from "../auth.js";
import {
  notify,
  readAuditChain,
  retentionPreview,
  runRetentionSweep,
  rotateEncryptionKey,
} from "@qansa/services";

/**
 * Security operations that used to be documented manual procedures: replaying
 * the audit chain, pruning operational data, and rotating the encryption key.
 * Each one is an explicit, audited action rather than a cron nobody watches.
 */
export async function securityRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  /** Replays the tamper-evident audit chain and reports the first broken row. */
  app.get(
    "/api/admin/security/audit-chain",
    { preHandler: requirePermission(ctx, "audit:read") },
    async (request) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(10).max(20000).default(5000),
        })
        .parse(request.query);
      const rows = await readAuditChain(ctx.deps, query.limit);
      const verification = verifyAuditChain(rows);
      return {
        ...verification,
        window: {
          from: rows[0]?.seq ?? null,
          to: rows.at(-1)?.seq ?? null,
          limit: query.limit,
        },
        checkedAt: new Date().toISOString(),
      };
    },
  );

  app.get(
    "/api/admin/security/retention",
    { preHandler: requirePermission(ctx, "settings:write") },
    async () => {
      return { preview: await retentionPreview(ctx.deps) };
    },
  );

  app.post(
    "/api/admin/security/retention",
    { preHandler: requirePermission(ctx, "settings:write") },
    async (request) => {
      const user = currentUser(request);
      const body = z
        .object({ confirm: z.literal("HAPUS") })
        .parse(request.body);
      void body;
      const counts = await runRetentionSweep(ctx.deps);
      await ctx.audit({
        actorType: "ADMIN",
        actorId: user.id,
        actorLabel: user.email,
        action: "security.retention_run",
        metadata: { ...counts },
        ip: request.ip,
      });
      return { ok: true, counts };
    },
  );

  /**
   * Key rotation runs inside the API because it needs both keys, and because
   * the running process must be restarted with the new key only after the
   * rotation reports success.
   */
  app.post(
    "/api/admin/security/rotate-key",
    { preHandler: requirePermission(ctx, "settings:write") },
    async (request) => {
      const user = currentUser(request);
      const body = z
        .object({
          confirm: z.literal("ROTASI"),
          dryRun: z.boolean().default(false),
          oldKey: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        })
        .parse(request.body);

      const oldKey = body.oldKey ?? process.env.APP_ENCRYPTION_KEY_OLD;
      if (!oldKey) {
        throw new AppError(
          "OLD_KEY_MISSING",
          "Kunci lama tidak tersedia. Set APP_ENCRYPTION_KEY_OLD ke kunci yang sedang dipakai sebelum menjalankan rotasi.",
          409,
        );
      }

      const result = await rotateEncryptionKey(ctx.deps, {
        oldKey,
        newKey: ctx.config.service.appEncryptionKey,
        dryRun: body.dryRun,
      });

      if (!body.dryRun) {
        await ctx.audit({
          actorType: "ADMIN",
          actorId: user.id,
          actorLabel: user.email,
          action: "security.key_rotation",
          metadata: { ...result },
          ip: request.ip,
        });
      }

      return {
        ...result,
        nextStep: body.dryRun
          ? "Uji kering selesai: tidak ada perubahan. Jalankan tanpa dryRun untuk menerapkan."
          : "Rotasi selesai. Perbarui APP_ENCRYPTION_KEY ke kunci baru lalu hapus APP_ENCRYPTION_KEY_OLD, dan restart api serta worker.",
      };
    },
  );

  /** Proves the notification webhook is reachable before an incident needs it. */
  app.post(
    "/api/admin/security/notify-test",
    { preHandler: requirePermission(ctx, "settings:write") },
    async (request) => {
      const user = currentUser(request);
      const result = await notify(ctx.deps, {
        type: "claim.completed",
        title: "Uji notifikasi dari konsol Qansa",
        data: { triggeredBy: user.email, kind: "test" },
      });
      return result;
    },
  );
}
