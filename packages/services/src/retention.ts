import { schema } from "@qansa/db";
import { lt, sql } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { loadSettings } from "./settings.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Data retention. Nothing here touches the financial record: orders, claims,
 * fulfilments and audit rows stay. What goes is operational exhaust that has no
 * value after a short window and does have privacy weight.
 */

export interface RetentionOptions {
  /** Verified claim sessions past their TTL. */
  claimSessionDays?: number;
  /** Admin sessions past expiry. */
  sessionDays?: number;
  /** Raw push bodies, kept for diagnosis only. */
  webhookDays?: number;
  /** Succeeded jobs; dead letters stay until investigated. */
  jobDays?: number;
  /** Pending manual claim requests older than this expire. */
  claimRequestDays?: number;
}

export interface RetentionCounts {
  claimSessions: number;
  sessions: number;
  loginChallenges: number;
  webhookEvents: number;
  jobs: number;
  expiredClaimRequests: number;
}

const daysAgo = (from: Date, days: number): Date =>
  new Date(from.getTime() - days * 24 * 3600 * 1000);

export async function runRetentionSweep(
  deps: ServiceDeps,
  options: RetentionOptions = {},
): Promise<RetentionCounts> {
  const now = nowOf(deps);
  const settings = await loadSettings(deps);
  const claimSessionCutoff = daysAgo(now, options.claimSessionDays ?? 7);
  const sessionCutoff = daysAgo(now, options.sessionDays ?? 7);
  const webhookCutoff = daysAgo(now, options.webhookDays ?? 90);
  const jobCutoff = daysAgo(now, options.jobDays ?? 30);
  const requestCutoff = daysAgo(
    now,
    options.claimRequestDays ?? settings.claim.manualRequestDays,
  );

  const deletedClaimSessions = await deps.db
    .delete(schema.claimSessions)
    .where(lt(schema.claimSessions.expiresAt, claimSessionCutoff))
    .returning({ id: schema.claimSessions.id });

  const deletedSessions = await deps.db
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, sessionCutoff))
    .returning({ id: schema.sessions.id });

  const deletedChallenges = await deps.db
    .delete(schema.loginChallenges)
    .where(
      sql`${schema.loginChallenges.expiresAt} < ${sessionCutoff.toISOString()}::timestamptz`,
    )
    .returning({ id: schema.loginChallenges.id });

  const deletedWebhooks = await deps.db
    .delete(schema.webhookEvents)
    .where(lt(schema.webhookEvents.receivedAt, webhookCutoff))
    .returning({ id: schema.webhookEvents.id });

  const deletedJobs = await deps.db
    .delete(schema.jobs)
    .where(
      sql`${schema.jobs.status} = 'SUCCEEDED' and ${schema.jobs.completedAt} < ${jobCutoff.toISOString()}::timestamptz`,
    )
    .returning({ id: schema.jobs.id });

  // A manual request nobody answered must not linger forever.
  const expiredRequests = await deps.db
    .update(schema.claimRequests)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(
      sql`${schema.claimRequests.status} = 'PENDING' and ${schema.claimRequests.createdAt} < ${requestCutoff.toISOString()}::timestamptz`,
    )
    .returning({ id: schema.claimRequests.id });

  // An approval window that has passed is closed explicitly, so the console and
  // the claim check agree on what is still open.
  await deps.db
    .update(schema.claimRequests)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(
      sql`${schema.claimRequests.status} = 'APPROVED' and ${schema.claimRequests.approvedUntil} < ${now.toISOString()}::timestamptz`,
    );

  const counts: RetentionCounts = {
    claimSessions: deletedClaimSessions.length,
    sessions: deletedSessions.length,
    loginChallenges: deletedChallenges.length,
    webhookEvents: deletedWebhooks.length,
    jobs: deletedJobs.length,
    expiredClaimRequests: expiredRequests.length,
  };

  if (Object.values(counts).some((value) => value > 0)) {
    await recordAudit(deps, {
      actorType: "SYSTEM",
      action: "retention.sweep",
      metadata: { ...counts },
    });
    deps.logger.info({ ...counts }, "retention sweep finished");
  }

  return counts;
}

/** Rows that would be removed by a sweep, without deleting anything. */
export async function retentionPreview(
  deps: ServiceDeps,
): Promise<RetentionCounts> {
  const now = nowOf(deps);
  const settings = await loadSettings(deps);
  const counts = await Promise.all([
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.claimSessions)
      .where(lt(schema.claimSessions.expiresAt, daysAgo(now, 7))),
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.sessions)
      .where(lt(schema.sessions.expiresAt, daysAgo(now, 7))),
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.loginChallenges)
      .where(
        sql`${schema.loginChallenges.expiresAt} < now() - interval '1 day'`,
      ),
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.webhookEvents)
      .where(lt(schema.webhookEvents.receivedAt, daysAgo(now, 90))),
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.jobs)
      .where(
        sql`${schema.jobs.status} = 'SUCCEEDED' and ${schema.jobs.completedAt} < now() - interval '30 days'`,
      ),
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.claimRequests)
      .where(
        sql`${schema.claimRequests.status} = 'PENDING' and ${schema.claimRequests.createdAt} < ${daysAgo(now, settings.claim.manualRequestDays).toISOString()}::timestamptz`,
      ),
  ]);

  return {
    claimSessions: Number(counts[0]?.[0]?.value ?? 0),
    sessions: Number(counts[1]?.[0]?.value ?? 0),
    loginChallenges: Number(counts[2]?.[0]?.value ?? 0),
    webhookEvents: Number(counts[3]?.[0]?.value ?? 0),
    jobs: Number(counts[4]?.[0]?.value ?? 0),
    expiredClaimRequests: Number(counts[5]?.[0]?.value ?? 0),
  };
}
