import { randomToken, sha256Hex } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * The half-authenticated state between a correct password and a second factor.
 *
 * It is a row, not a session: it cannot read anything, it expires in five
 * minutes, it is single use, and five wrong codes burn it. A stolen cookie from
 * this stage is worth nothing after the real login completes.
 */

const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_CHALLENGE_ATTEMPTS = 5;

export interface LoginChallenge {
  token: string;
  expiresAt: Date;
}

export async function createLoginChallenge(
  deps: ServiceDeps,
  input: { userId: string; ip?: string | null; userAgent?: string | null },
): Promise<LoginChallenge> {
  const token = randomToken(32);
  const expiresAt = new Date(nowOf(deps).getTime() + CHALLENGE_TTL_MS);

  await deps.db.insert(schema.loginChallenges).values({
    userId: input.userId,
    tokenHash: sha256Hex(token),
    ip: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    expiresAt,
  });

  return { token, expiresAt };
}

export interface ChallengeContext {
  id: string;
  userId: string;
  attempts: number;
}

export async function findLoginChallenge(
  deps: ServiceDeps,
  token: string,
): Promise<ChallengeContext | null> {
  if (!token) return null;
  const [row] = await deps.db
    .select({
      id: schema.loginChallenges.id,
      userId: schema.loginChallenges.userId,
      attempts: schema.loginChallenges.attempts,
    })
    .from(schema.loginChallenges)
    .where(
      and(
        eq(schema.loginChallenges.tokenHash, sha256Hex(token)),
        isNull(schema.loginChallenges.consumedAt),
        gt(schema.loginChallenges.expiresAt, nowOf(deps)),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function registerChallengeFailure(
  deps: ServiceDeps,
  challengeId: string,
): Promise<{ attempts: number; burned: boolean }> {
  const [row] = await deps.db
    .update(schema.loginChallenges)
    .set({ attempts: sql`${schema.loginChallenges.attempts} + 1` })
    .where(eq(schema.loginChallenges.id, challengeId))
    .returning({ attempts: schema.loginChallenges.attempts });

  const attempts = row?.attempts ?? MAX_CHALLENGE_ATTEMPTS;
  const burned = attempts >= MAX_CHALLENGE_ATTEMPTS;
  if (burned) {
    await deps.db
      .update(schema.loginChallenges)
      .set({ consumedAt: nowOf(deps) })
      .where(eq(schema.loginChallenges.id, challengeId));
  }
  return { attempts, burned };
}

export async function consumeLoginChallenge(
  deps: ServiceDeps,
  challengeId: string,
): Promise<void> {
  await deps.db
    .update(schema.loginChallenges)
    .set({ consumedAt: nowOf(deps) })
    .where(eq(schema.loginChallenges.id, challengeId));
}

export async function pruneLoginChallenges(deps: ServiceDeps): Promise<number> {
  const rows = await deps.db
    .delete(schema.loginChallenges)
    .where(sql`${schema.loginChallenges.expiresAt} < now() - interval '1 day'`)
    .returning({ id: schema.loginChallenges.id });
  return rows.length;
}
