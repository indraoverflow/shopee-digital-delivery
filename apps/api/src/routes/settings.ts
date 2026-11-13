import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema } from "@qansa/db";
import { count, desc, eq } from "drizzle-orm";
import { currentUser, requirePermission } from "../auth.js";
import { paginate, paginationSchema } from "./common.js";
import { loadSettings, saveSetting } from "@qansa/services";
import { DEFAULT_SETTINGS } from "@qansa/services";

/**
 * System settings and the audit trail. Settings are validated, merged over the
 * defaults, and written one key at a time so a partial update cannot wipe the
 * other groups.
 */

const settingsSchema = z.object({
  branding: z
    .object({
      brandName: z.string().trim().min(2).max(60),
      tagline: z.string().trim().max(160),
      supportEmail: z.string().trim().email().max(200),
      supportWhatsapp: z.string().trim().max(40),
      claimDomain: z.string().trim().max(120),
    })
    .partial()
    .optional(),
  claim: z
    .object({
      sessionMinutes: z.coerce.number().int().min(5).max(240),
      maxAttemptsPerHour: z.coerce.number().int().min(1).max(100),
      maxAttemptsPerOrder: z.coerce.number().int().min(1).max(200),
      downloadTtlMinutes: z.coerce.number().int().min(1).max(120),
      maxDownloadsPerFulfillment: z.coerce.number().int().min(1).max(100),
      manualRequestDays: z.coerce.number().int().min(1).max(60),
      manualApprovalHours: z.coerce.number().int().min(1).max(168),
      autoShipOnClaim: z.boolean(),
      autoShipPrefix: z.string().trim().max(24),
      autoShipTrigger: z.enum(["ON_PAYMENT", "ON_CLAIM"]),
    })
    .partial()
    .optional(),
  notify: z
    .object({
      enabled: z.boolean(),
      webhookUrl: z.string().trim().url().max(500).nullable(),
      secret: z.string().trim().max(200).nullable(),
      events: z.array(z.string().trim().max(60)).max(20),
    })
    .partial()
    .optional(),
  sync: z
    .object({
      productIntervalMinutes: z.coerce.number().int().min(5).max(1440),
      orderReconcileMinutes: z.coerce.number().int().min(1).max(1440),
      orderLookbackHours: z.coerce.number().int().min(1).max(720),
    })
    .partial()
    .optional(),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "overview:read");
  const write = requirePermission(ctx, "settings:write");
  const auditRead = requirePermission(ctx, "audit:read");

  app.get("/api/admin/settings", { preHandler: read }, async () => {
    const settings = await loadSettings(ctx.deps);
    return {
      settings,
      defaults: DEFAULT_SETTINGS,
      gatewayMode: ctx.config.gatewayMode,
      environment: ctx.config.nodeEnv,
    };
  });

  app.patch("/api/admin/settings", { preHandler: write }, async (request) => {
    const body = settingsSchema.parse(request.body);
    const user = currentUser(request);

    for (const key of ["branding", "claim", "sync", "notify"] as const) {
      const group = body[key];
      if (!group) continue;
      const current = await loadSettings(ctx.deps);
      await saveSetting(ctx.deps, key, { ...current[key], ...group });
    }

    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: "settings.update",
      targetType: "settings",
      metadata: body,
      ip: request.ip,
    });

    return { settings: await loadSettings(ctx.deps) };
  });

  app.get(
    "/api/admin/audit-logs",
    { preHandler: auditRead },
    async (request) => {
      const query = paginationSchema
        .extend({
          action: z.string().trim().max(80).optional(),
          actorId: z.string().uuid().optional(),
        })
        .parse(request.query);
      const filters = [
        ...(query.action ? [eq(schema.auditLogs.action, query.action)] : []),
        ...(query.actorId ? [eq(schema.auditLogs.actorId, query.actorId)] : []),
      ];
      const where =
        filters.length === 0
          ? undefined
          : filters.length === 1
            ? filters[0]
            : undefined;

      const rows = await ctx.db
        .select()
        .from(schema.auditLogs)
        .where(where)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await ctx.db
        .select({ value: count() })
        .from(schema.auditLogs)
        .where(where);

      return paginate(
        rows,
        query.page,
        query.pageSize,
        Number(total?.value ?? 0),
      );
    },
  );
}
