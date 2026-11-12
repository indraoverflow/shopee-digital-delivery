import { schema } from "@qansa/db";
import { and, eq, lte, sql } from "drizzle-orm";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * A table-backed queue. Volume here is tens of jobs a minute, so Redis would be
 * another service to run and back up for no gain: `FOR UPDATE SKIP LOCKED` in
 * PostgreSQL gives at-least-once delivery, ordered retries and a dead-letter
 * state that an operator can inspect with plain SQL.
 */

export const JOB_TYPES = ["PROCESS_ORDER", "SYNC_PRODUCTS", "SYNC_ORDERS", "EXPIRE_CLAIMS", "RECONCILE_STORES", "REFRESH_TOKENS"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface EnqueueInput {
  type: JobType;
  payload: Record<string, unknown>;
  /** Only one pending job with this key exists at a time. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface QueuedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export async function enqueue(deps: ServiceDeps, input: EnqueueInput): Promise<string | null> {
  const [row] = await deps.db
    .insert(schema.jobs)
    .values({
      type: input.type,
      payload: input.payload,
      dedupeKey: input.dedupeKey ?? null,
      runAt: input.runAt ?? nowOf(deps),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: schema.jobs.id });
  return row?.id ?? null;
}

/**
 * Locks one due job for this worker. The `for update skip locked` clause is
 * what makes several workers safe: a job already locked is skipped rather than
 * waited on, so neither worker blocks the other.
 */
export async function claimNextJob(deps: ServiceDeps, workerId: string): Promise<QueuedJob | null> {
  return deps.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "QUEUED"), lte(schema.jobs.runAt, nowOf(deps))))
      .orderBy(schema.jobs.runAt)
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) return null;

    const [claimed] = await tx
      .update(schema.jobs)
      .set({
        status: "RUNNING",
        lockedAt: nowOf(deps),
        lockedBy: workerId,
        attempts: sql`${schema.jobs.attempts} + 1`,
      })
      .where(eq(schema.jobs.id, candidate.id))
      .returning({
        id: schema.jobs.id,
        type: schema.jobs.type,
        payload: schema.jobs.payload,
        attempts: schema.jobs.attempts,
        maxAttempts: schema.jobs.maxAttempts,
      });

    if (!claimed) return null;
    return {
      id: claimed.id,
      type: claimed.type as JobType,
      payload: (claimed.payload ?? {}) as Record<string, unknown>,
      attempts: claimed.attempts,
      maxAttempts: claimed.maxAttempts,
    };
  });
}

export async function completeJob(deps: ServiceDeps, jobId: string): Promise<void> {
  await deps.db
    .update(schema.jobs)
    .set({ status: "SUCCEEDED", completedAt: nowOf(deps), lockedAt: null, lockedBy: null, lastError: null })
    .where(eq(schema.jobs.id, jobId));
}

/** Exponential backoff capped at 30 minutes, then a dead letter. */
export function retryDelayMs(attempts: number): number {
  const base = 30_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export async function failJob(deps: ServiceDeps, job: QueuedJob, error: string): Promise<"RETRY" | "DEAD"> {
  const dead = job.attempts >= job.maxAttempts;
  const runAt = new Date(nowOf(deps).getTime() + retryDelayMs(job.attempts));
  await deps.db
    .update(schema.jobs)
    .set({
      status: dead ? "DEAD" : "QUEUED",
      lastError: error.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      ...(dead ? { completedAt: nowOf(deps) } : { runAt }),
    })
    .where(eq(schema.jobs.id, job.id));
  return dead ? "DEAD" : "RETRY";
}

/** Jobs left RUNNING by a crashed worker are handed back after the timeout. */
export async function recoverStuckJobs(deps: ServiceDeps, staleMinutes = 15): Promise<number> {
  const cutoff = new Date(nowOf(deps).getTime() - staleMinutes * 60_000);
  const rows = await deps.db
    .update(schema.jobs)
    .set({ status: "QUEUED", lockedAt: null, lockedBy: null, lastError: "recovered from a stale lock" })
    .where(and(eq(schema.jobs.status, "RUNNING"), lte(schema.jobs.lockedAt, cutoff)))
    .returning({ id: schema.jobs.id });
  return rows.length;
}

export interface QueueStats {
  queued: number;
  running: number;
  dead: number;
  succeeded24h: number;
}

/**
 * Counted with the query builder rather than a raw statement so the same code
 * runs on postgres-js and on the pglite driver the tests use.
 */
export async function queueStats(deps: ServiceDeps): Promise<QueueStats> {
  const [row] = await deps.db
    .select({
      queued: sql<number>`count(*) filter (where ${schema.jobs.status} = 'QUEUED')`,
      running: sql<number>`count(*) filter (where ${schema.jobs.status} = 'RUNNING')`,
      dead: sql<number>`count(*) filter (where ${schema.jobs.status} = 'DEAD')`,
      succeeded24h: sql<number>`count(*) filter (where ${schema.jobs.status} = 'SUCCEEDED' and ${schema.jobs.completedAt} > now() - interval '24 hours')`,
    })
    .from(schema.jobs);

  return {
    queued: Number(row?.queued ?? 0),
    running: Number(row?.running ?? 0),
    dead: Number(row?.dead ?? 0),
    succeeded24h: Number(row?.succeeded24h ?? 0),
  };
}
