import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requirePermission } from "../auth.js";
import {
  createUser,
  isLastActiveOwner,
  listUsers,
  resetUserPassword,
  updateUser,
} from "@qansa/services";

/**
 * Console accounts. Owner-only, and the service layer enforces the invariants
 * that a route could otherwise break: unique email, last owner protection, and
 * session revocation on deactivation or password reset.
 */

const roleSchema = z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]);

const createSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(2).max(120),
  role: roleSchema.default("OPERATOR"),
  password: z.string().min(10).max(200).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
});

const passwordResetSchema = z.object({
  password: z.string().min(10).max(200).optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get(
    "/api/admin/users",
    { preHandler: requirePermission(ctx, "user:write") },
    async () => {
      const users = await listUsers(ctx.deps);
      return {
        data: await Promise.all(
          users.map(async (user) => ({
            ...user,
            isLastActiveOwner: await isLastActiveOwner(ctx.deps, user.id),
            totpEnabled: Boolean(user.totpEnabledAt),
          })),
        ),
      };
    },
  );

  app.post(
    "/api/admin/users",
    { preHandler: requirePermission(ctx, "user:write") },
    async (request, reply) => {
      const actor = currentUser(request);
      const body = createSchema.parse(request.body);
      const result = await createUser(ctx.deps, {
        ...body,
        actor: { id: actor.id, email: actor.email, role: actor.role },
      });
      return reply.code(201).send(result);
    },
  );

  app.patch(
    "/api/admin/users/:id",
    { preHandler: requirePermission(ctx, "user:write") },
    async (request) => {
      const actor = currentUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateSchema.parse(request.body);
      await updateUser(ctx.deps, id, {
        ...body,
        actor: { id: actor.id, email: actor.email, role: actor.role },
      });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/users/:id/password",
    { preHandler: requirePermission(ctx, "user:write") },
    async (request) => {
      const actor = currentUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = passwordResetSchema.parse(request.body ?? {});
      return resetUserPassword(
        ctx.deps,
        id,
        { id: actor.id, email: actor.email, role: actor.role },
        body.password,
      );
    },
  );
}
