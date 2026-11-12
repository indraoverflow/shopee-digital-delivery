import { schema } from "@qansa/db";
import type { ServiceDeps } from "./types.js";

export interface AuditInput {
  actorType?: "ADMIN" | "SYSTEM" | "BUYER";
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Administrative actions and pipeline decisions worth explaining later. Written
 * best-effort: an audit failure must never roll back the action it describes,
 * but it is logged loudly so it does not go unnoticed.
 */
export async function recordAudit(deps: ServiceDeps, input: AuditInput): Promise<void> {
  try {
    await deps.db.insert(schema.auditLogs).values({
      actorType: input.actorType ?? "SYSTEM",
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? null,
      ip: input.ip ?? null,
    });
  } catch (error) {
    deps.logger.error({ err: error instanceof Error ? error.message : String(error), action: input.action }, "audit write failed");
  }
}
