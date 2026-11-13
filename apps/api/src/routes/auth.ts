import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AppError, hashPassword, verifyPassword } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import {
  createSession,
  currentUser,
  login,
  requirePermission,
  revokeSession,
  CSRF_COOKIE,
  SESSION_COOKIE,
} from "../auth.js";
import { permissionsFor } from "@qansa/core";
import {
  consumeLoginChallenge,
  createLoginChallenge,
  findLoginChallenge,
  registerChallengeFailure,
} from "@qansa/services";
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  isTotpEnabled,
  regenerateRecoveryCodes,
  recoveryCodesRemaining,
  verifySecondFactor,
} from "@qansa/services";

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

const challengeSchema = z.object({
  challengeToken: z.string().min(20).max(200),
  token: z.string().min(6).max(32),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});

/**
 * Login, second factor, and password changes.
 *
 * With 2FA enabled the password step returns a challenge instead of a session,
 * so a correct password alone never yields a usable cookie.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  const setSessionCookies = (
    reply: FastifyReply,
    session: Awaited<ReturnType<typeof createSession>>,
  ): void => {
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.config.sessionCookieSecure,
      path: "/",
      maxAge: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
    });
    reply.setCookie(CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      sameSite: "lax",
      secure: ctx.config.sessionCookieSecure,
      path: "/",
      maxAge: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
    });
  };

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const user = await login(ctx.db, body.email, body.password);
      if (!user)
        throw new AppError(
          "INVALID_CREDENTIALS",
          "Email atau kata sandi salah",
          401,
        );

      if (await isTotpEnabled(ctx.deps, user.id)) {
        const challenge = await createLoginChallenge(ctx.deps, {
          userId: user.id,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
        });
        await ctx.audit({
          actorType: "ADMIN",
          actorId: user.id,
          actorLabel: user.email,
          action: "auth.mfa_challenge",
          ip: request.ip,
        });
        return {
          mfaRequired: true as const,
          challengeToken: challenge.token,
          expiresAt: challenge.expiresAt.toISOString(),
        };
      }

      const session = await createSession(ctx.db, user, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      await ctx.audit({
        actorType: "ADMIN",
        actorId: user.id,
        actorLabel: user.email,
        action: "auth.login",
        ip: request.ip,
      });
      setSessionCookies(reply, session);

      return {
        mfaRequired: false as const,
        user: {
          ...session.user,
          permissions: permissionsFor(session.user.role),
        },
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  /** Step two: the authenticator code or a recovery code. */
  app.post(
    "/api/auth/2fa/challenge",
    { config: { rateLimit: { max: 20, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = challengeSchema.parse(request.body);
      const challenge = await findLoginChallenge(ctx.deps, body.challengeToken);
      if (!challenge)
        throw new AppError(
          "CHALLENGE_EXPIRED",
          "Sesi verifikasi sudah berakhir. Silakan masuk kembali.",
          401,
        );

      const [row] = await ctx.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, challenge.userId))
        .limit(1);
      if (!row || !row.isActive)
        throw new AppError("INVALID_CREDENTIALS", "Akun tidak aktif", 401);

      const verified = await verifySecondFactor(
        ctx.deps,
        { id: row.id, email: row.email },
        body.token,
      );
      if (!verified.ok) {
        const failure = await registerChallengeFailure(ctx.deps, challenge.id);
        await ctx.audit({
          actorType: "ADMIN",
          actorId: row.id,
          actorLabel: row.email,
          action: "auth.mfa_failed",
          metadata: { attempts: failure.attempts },
          ip: request.ip,
        });
        throw new AppError(
          failure.burned ? "CHALLENGE_EXPIRED" : "MFA_INVALID",
          failure.burned
            ? "Terlalu banyak percobaan. Silakan masuk kembali."
            : "Kode 2FA salah. Coba lagi.",
          401,
          { remaining: Math.max(0, 5 - failure.attempts) },
        );
      }

      await consumeLoginChallenge(ctx.deps, challenge.id);
      const user = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role as typeof row.role,
      };
      const session = await createSession(ctx.db, user, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      await ctx.db
        .update(schema.users)
        .set({ lastLoginAt: new Date() })
        .where(eq(schema.users.id, row.id));
      await ctx.audit({
        actorType: "ADMIN",
        actorId: row.id,
        actorLabel: row.email,
        action: "auth.login",
        metadata: { secondFactor: verified.method },
        ip: request.ip,
      });
      setSessionCookies(reply, session);

      return {
        mfaRequired: false as const,
        user: {
          ...session.user,
          permissions: permissionsFor(session.user.role),
        },
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  app.get(
    "/api/auth/me",
    { preHandler: requirePermission(ctx, "overview:read") },
    async (request) => {
      const user = currentUser(request);
      return { user: { ...user, permissions: permissionsFor(user.role) } };
    },
  );

  app.get(
    "/api/auth/2fa",
    { preHandler: requirePermission(ctx, "overview:read") },
    async (request) => {
      const user = currentUser(request);
      return {
        enabled: await isTotpEnabled(ctx.deps, user.id),
        recoveryCodesRemaining: await recoveryCodesRemaining(ctx.deps, user.id),
      };
    },
  );

  app.post(
    "/api/auth/2fa/enroll",
    { preHandler: requirePermission(ctx, "overview:read") },
    async (request) => {
      const user = currentUser(request);
      if (await isTotpEnabled(ctx.deps, user.id))
        throw new AppError(
          "TOTP_ALREADY_ENABLED",
          "2FA sudah aktif. Nonaktifkan dulu untuk mendaftar ulang.",
          409,
        );
      return beginTotpEnrollment(ctx.deps, { id: user.id, email: user.email });
    },
  );

  app.post(
    "/api/auth/2fa/enroll/confirm",
    {
      preHandler: requirePermission(ctx, "overview:read"),
      config: { rateLimit: { max: 15, timeWindow: "5 minutes" } },
    },
    async (request) => {
      const user = currentUser(request);
      const body = z
        .object({ token: z.string().min(6).max(32) })
        .parse(request.body);
      const result = await confirmTotpEnrollment(
        ctx.deps,
        { id: user.id, email: user.email },
        body.token,
      );
      return {
        ok: true,
        enabledAt: result.enabledAt.toISOString(),
        recoveryCodes: result.recoveryCodes,
      };
    },
  );

  app.post(
    "/api/auth/2fa/recovery-codes",
    { preHandler: requirePermission(ctx, "overview:read") },
    async (request) => {
      const user = currentUser(request);
      const body = z
        .object({ token: z.string().min(6).max(32) })
        .parse(request.body);
      return {
        recoveryCodes: await regenerateRecoveryCodes(
          ctx.deps,
          { id: user.id, email: user.email },
          body.token,
        ),
      };
    },
  );

  app.post(
    "/api/auth/2fa/disable",
    { preHandler: requirePermission(ctx, "overview:read") },
    async (request) => {
      const user = currentUser(request);
      const body = z
        .object({ password: z.string().min(1).max(200) })
        .parse(request.body);

      const [row] = await ctx.db
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, user.id))
        .limit(1);
      if (!row || !(await verifyPassword(body.password, row.passwordHash))) {
        throw new AppError("INVALID_CREDENTIALS", "Kata sandi salah", 400);
      }

      await disableTotp(ctx.deps, { id: user.id, email: user.email });
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await revokeSession(ctx.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post(
    "/api/auth/password",
    { preHandler: requirePermission(ctx, "overview:read") },
    async (request, reply) => {
      const user = currentUser(request);
      const body = passwordSchema.parse(request.body);

      const [row] = await ctx.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, user.id))
        .limit(1);
      if (!row) throw AppError.notFound("Pengguna");
      if (!(await verifyPassword(body.currentPassword, row.passwordHash))) {
        throw new AppError(
          "INVALID_CREDENTIALS",
          "Kata sandi saat ini salah",
          400,
        );
      }

      await ctx.db
        .update(schema.users)
        .set({
          passwordHash: await hashPassword(body.newPassword),
          passwordChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id));

      // Every other session of this user dies with the password change.
      await ctx.db
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(eq(schema.sessions.userId, user.id));

      await ctx.audit({
        actorType: "ADMIN",
        actorId: user.id,
        actorLabel: user.email,
        action: "auth.password_changed",
        ip: request.ip,
      });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return {
        ok: true,
        message: "Kata sandi diperbarui. Silakan masuk kembali.",
      };
    },
  );
}
