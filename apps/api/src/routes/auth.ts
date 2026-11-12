import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, hashPassword, permissionsFor, verifyPassword } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import { CSRF_COOKIE, SESSION_COOKIE, createSession, currentUser, login, requirePermission, revokeSession } from "../auth.js";

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});

/**
 * Login is the only unauthenticated admin route. Failures are deliberately
 * indistinguishable: wrong email and wrong password return the same message.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const user = await login(ctx.db, body.email, body.password);
      if (!user) throw new AppError("INVALID_CREDENTIALS", "Email atau kata sandi salah", 401);

      const session = await createSession(ctx.db, user, { ip: request.ip, userAgent: request.headers["user-agent"] });

      await ctx.audit({
        actorType: "ADMIN",
        actorId: user.id,
        actorLabel: user.email,
        action: "auth.login",
        ip: request.ip,
      });

      reply.setCookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: ctx.config.sessionCookieSecure,
        path: "/",
        maxAge: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      });
      // Readable by the dashboard so it can echo it in the x-csrf-token header.
      reply.setCookie(CSRF_COOKIE, session.csrfToken, {
        httpOnly: false,
        sameSite: "lax",
        secure: ctx.config.sessionCookieSecure,
        path: "/",
        maxAge: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      });

      return {
        user: { ...session.user, permissions: permissionsFor(session.user.role) },
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  app.get("/api/auth/me", { preHandler: requirePermission(ctx, "overview:read") }, async (request) => {
    const user = currentUser(request);
    return { user: { ...user, permissions: permissionsFor(user.role) } };
  });

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

      const [row] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
      if (!row) throw AppError.notFound("Pengguna");
      if (!(await verifyPassword(body.currentPassword, row.passwordHash))) {
        throw new AppError("INVALID_CREDENTIALS", "Kata sandi saat ini salah", 400);
      }

      await ctx.db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));

      // Every other session of this user dies with the password change.
      await ctx.db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.userId, user.id));

      await ctx.audit({ actorType: "ADMIN", actorId: user.id, actorLabel: user.email, action: "auth.password_changed", ip: request.ip });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return { ok: true, message: "Kata sandi diperbarui. Silakan masuk kembali." };
    },
  );
}
