import { AppError, hashPassword, randomToken } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Console accounts. The rules that matter live here rather than in a route:
 * an email is unique regardless of case, the last active owner cannot be
 * demoted or deactivated, and a password reset revokes every existing session.
 */

export type ConsoleRole = "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";

export async function listUsers(deps: ServiceDeps) {
  return deps.db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      isActive: schema.users.isActive,
      lastLoginAt: schema.users.lastLoginAt,
      totpEnabledAt: schema.users.totpEnabledAt,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .orderBy(schema.users.createdAt);
}

function generatePassword(): string {
  return randomToken(15);
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: ConsoleRole;
  actor: { id: string; email: string; role: ConsoleRole };
  /** Omit to have one generated and returned exactly once. */
  password?: string;
}

export async function createUser(
  deps: ServiceDeps,
  input: CreateUserInput,
): Promise<{
  user: { id: string; email: string; role: ConsoleRole };
  generatedPassword?: string;
}> {
  const email = input.email.trim().toLowerCase();
  if (input.role === "OWNER" && input.actor.role !== "OWNER") {
    throw AppError.forbidden("Hanya OWNER yang bisa membuat OWNER lain");
  }

  const [existing] = await deps.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email}`)
    .limit(1);
  if (existing)
    throw AppError.conflict("USER_EXISTS", "Email ini sudah terdaftar");

  const password = input.password ?? generatePassword();
  if (password.length < 10)
    throw AppError.validation("Kata sandi minimal 10 karakter");

  const [row] = await deps.db
    .insert(schema.users)
    .values({
      email,
      name: input.name.trim(),
      role: input.role,
      passwordHash: await hashPassword(password),
    })
    .returning({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
    });

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: "user.create",
    targetType: "user",
    targetId: row!.id,
    metadata: { email, role: input.role },
  });

  return {
    user: row as { id: string; email: string; role: ConsoleRole },
    ...(input.password ? {} : { generatedPassword: password }),
  };
}

export interface UpdateUserInput {
  name?: string;
  role?: ConsoleRole;
  isActive?: boolean;
  actor: { id: string; email: string; role: ConsoleRole };
}

export async function updateUser(
  deps: ServiceDeps,
  userId: string,
  input: UpdateUserInput,
): Promise<void> {
  const [target] = await deps.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!target) throw AppError.notFound("Pengguna");

  if (input.role && input.role !== target.role) {
    if (
      (target.role === "OWNER" || input.role === "OWNER") &&
      input.actor.role !== "OWNER"
    ) {
      throw AppError.forbidden("Hanya OWNER yang bisa mengubah peran OWNER");
    }
  }

  const losingOwner =
    target.role === "OWNER" &&
    ((input.role && input.role !== "OWNER") || input.isActive === false);
  if (losingOwner) {
    const [owners] = await deps.db
      .select({ value: count() })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.role, "OWNER"),
          eq(schema.users.isActive, true),
          ne(schema.users.id, target.id),
        ),
      );
    if (Number(owners?.value ?? 0) === 0) {
      throw AppError.conflict(
        "LAST_OWNER",
        "Tidak bisa menonaktifkan atau menurunkan OWNER terakhir",
      );
    }
  }

  await deps.db
    .update(schema.users)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: nowOf(deps),
    })
    .where(eq(schema.users.id, target.id));

  // A deactivated account loses its sessions immediately.
  if (input.isActive === false) {
    await deps.db
      .update(schema.sessions)
      .set({ revokedAt: nowOf(deps) })
      .where(eq(schema.sessions.userId, target.id));
  }

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: "user.update",
    targetType: "user",
    targetId: target.id,
    metadata: { ...input, actor: undefined },
  });
}

export async function resetUserPassword(
  deps: ServiceDeps,
  userId: string,
  actor: { id: string; email: string; role: ConsoleRole },
  password?: string,
): Promise<{ generatedPassword?: string }> {
  const [target] = await deps.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!target) throw AppError.notFound("Pengguna");
  if (target.role === "OWNER" && actor.role !== "OWNER")
    throw AppError.forbidden("Hanya OWNER yang bisa mereset kata sandi OWNER");

  const next = password ?? generatePassword();
  if (next.length < 10)
    throw AppError.validation("Kata sandi minimal 10 karakter");

  await deps.db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({
        passwordHash: await hashPassword(next),
        passwordChangedAt: nowOf(deps),
        updatedAt: nowOf(deps),
      })
      .where(eq(schema.users.id, target.id));
    await tx
      .update(schema.sessions)
      .set({ revokedAt: nowOf(deps) })
      .where(eq(schema.sessions.userId, target.id));
    await tx
      .update(schema.loginChallenges)
      .set({ consumedAt: nowOf(deps) })
      .where(eq(schema.loginChallenges.userId, target.id));
  });

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: actor.id,
    actorLabel: actor.email,
    action: "user.password_reset",
    targetType: "user",
    targetId: target.id,
  });

  return password ? {} : { generatedPassword: next };
}

/** Whether the account is the only active owner, used by the console to hide the button. */
export async function isLastActiveOwner(
  deps: ServiceDeps,
  userId: string,
): Promise<boolean> {
  const [target] = await deps.db
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (target?.role !== "OWNER") return false;

  const [others] = await deps.db
    .select({ value: count() })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.role, "OWNER"),
        eq(schema.users.isActive, true),
        ne(schema.users.id, userId),
      ),
    );
  return Number(others?.value ?? 0) === 0;
}
