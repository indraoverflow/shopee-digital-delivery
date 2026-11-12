import { sha256Hex, constantTimeEquals, randomToken, verifyPassword, type Permission, type Role, can } from "@qansa/core";
import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import type { FastifyRequest } from "fastify";
import "@fastify/cookie";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "@qansa/db";

/**
 * Admin sessions and CSRF. The cookie carries a random token, the database
 * stores only its sha256, and the session row can be revoked without touching
 * the user. Every mutating request also has to echo the CSRF cookie in a
 * header, which a cross-site form post cannot do.
 */

export const SESSION_COOKIE = "qansa_session";
export const CSRF_COOKIE = "qansa_csrf";
export const CLAIM_COOKIE = "qansa_claim";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface SessionResult {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  user: AuthUser;
}

export async function createSession(
  db: Database,
  user: AuthUser,
  input: { ip?: string | null; userAgent?: string | null; ttlHours?: number },
): Promise<SessionResult> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? 12) * 3600_000);

  await db.insert(schema.sessions).values({
    userId: user.id,
    tokenHash: sha256Hex(token),
    ip: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    expiresAt,
  });

  return { token, csrfToken, expiresAt, user };
}

export async function authenticate(db: Database, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: schema.users, session: schema.sessions })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sha256Hex(token)), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);

  if (!row || !row.user.isActive) return null;
  return { id: row.user.id, email: row.user.email, name: row.user.name, role: row.user.role as Role };
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.tokenHash, sha256Hex(token)));
}

export async function login(db: Database, email: string, password: string) {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);

  // Hash even when the user does not exist, so timing does not reveal accounts.
  const hash = user?.passwordHash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = await verifyPassword(password, hash).catch(() => false);

  if (!user || !ok || !user.isActive) return null;
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  return { id: user.id, email: user.email, name: user.name, role: user.role as Role };
}

export function requireCsrf(request: FastifyRequest): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers["x-csrf-token"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!cookie || !value || !constantTimeEquals(cookie, value)) {
    throw new AppError("CSRF_FAILED", "Permintaan ditolak: token CSRF tidak valid", 403);
  }
}

export interface GuardContext {
  db: Database;
}

export interface GuardedRequest extends FastifyRequest {
  user: AuthUser;
}

/**
 * Authentication + authorisation in one place, used as a route preHandler.
 * A viewer hitting a write route gets 403, never a 500 from a missing check.
 */
export function requirePermission(context: GuardContext, permission: Permission) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    const user = await authenticate(context.db, token);
    if (!user) throw new AppError("UNAUTHORIZED", "Sesi tidak valid atau sudah berakhir. Silakan masuk kembali.", 401);
    if (!can(user.role, permission)) {
      throw new AppError("FORBIDDEN", "Role Anda tidak punya akses ke tindakan ini", 403);
    }
    (request as GuardedRequest).user = user;
  };
}

export function currentUser(request: FastifyRequest): AuthUser {
  const user = (request as GuardedRequest).user;
  if (!user) throw new AppError("UNAUTHORIZED", "Sesi tidak valid", 401);
  return user;
}
