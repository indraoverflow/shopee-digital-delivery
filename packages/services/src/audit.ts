import { auditEntryHash } from "@qansa/core";
import { schema } from "@qansa/db";
import { desc, eq } from "drizzle-orm";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

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
 * Administrative actions and pipeline decisions worth explaining later.
 *
 * Written best-effort: an audit failure must never roll back the action it
 * describes, but it is logged loudly so it does not go unnoticed. Each row
 * chains to the previous one, so an edited or deleted row is detectable.
 */
export async function recordAudit(
  deps: ServiceDeps,
  input: AuditInput,
): Promise<void> {
  try {
    await deps.db.transaction(async (tx) => {
      // Locking the tail row serialises writers, which is what keeps the chain
      // linear when two requests finish at the same instant.
      const [tail] = await tx
        .select({
          entryHash: schema.auditLogs.entryHash,
          seq: schema.auditLogs.seq,
        })
        .from(schema.auditLogs)
        .orderBy(desc(schema.auditLogs.seq))
        .limit(1)
        .for("update");

      const createdAt = nowOf(deps);
      const entry = {
        seq: (tail?.seq ?? 0) + 1,
        action: input.action,
        actorType: input.actorType ?? "SYSTEM",
        actorLabel: input.actorLabel ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? null,
        ip: input.ip ?? null,
        createdAt,
      };

      await tx.insert(schema.auditLogs).values({
        ...entry,
        actorId: input.actorId ?? null,
        prevHash: tail?.entryHash ?? null,
        entryHash: auditEntryHash(tail?.entryHash ?? null, entry),
      });
    });
  } catch (error) {
    deps.logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        action: input.action,
      },
      "audit write failed",
    );
  }
}

/** Reads a window of the chain, oldest first, for verification. */
export async function readAuditChain(deps: ServiceDeps, limit = 5000) {
  const rows = await deps.db
    .select({
      seq: schema.auditLogs.seq,
      action: schema.auditLogs.action,
      actorType: schema.auditLogs.actorType,
      actorLabel: schema.auditLogs.actorLabel,
      targetType: schema.auditLogs.targetType,
      targetId: schema.auditLogs.targetId,
      metadata: schema.auditLogs.metadata,
      ip: schema.auditLogs.ip,
      prevHash: schema.auditLogs.prevHash,
      entryHash: schema.auditLogs.entryHash,
      createdAt: schema.auditLogs.createdAt,
    })
    .from(schema.auditLogs)
    .orderBy(desc(schema.auditLogs.seq))
    .limit(limit);
  return rows.reverse();
}

/** Convenience for the admin endpoint: the newest row's hash, as an anchor. */
export async function auditHead(
  deps: ServiceDeps,
): Promise<{ seq: number; entryHash: string } | null> {
  const [row] = await deps.db
    .select({
      seq: schema.auditLogs.seq,
      entryHash: schema.auditLogs.entryHash,
    })
    .from(schema.auditLogs)
    .orderBy(desc(schema.auditLogs.seq))
    .limit(1);
  return row?.entryHash ? { seq: row.seq, entryHash: row.entryHash } : null;
}

export async function auditEntriesForTarget(
  deps: ServiceDeps,
  targetType: string,
  targetId: string,
) {
  return deps.db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.targetId, targetId))
    .orderBy(desc(schema.auditLogs.seq))
    .limit(50)
    .then((rows) => rows.filter((row) => row.targetType === targetType));
}
