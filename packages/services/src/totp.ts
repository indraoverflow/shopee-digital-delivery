import {
  AppError,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUrl,
  recoveryCodeHash,
  verifyTotp,
} from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Two-factor authentication for console accounts.
 *
 * The secret is encrypted with the same key as Shopee tokens. Recovery codes are
 * stored as hashes and removed one by one as they are used, so a leaked database
 * does not hand over standing access.
 */

export interface EnrollmentStart {
  secret: string;
  otpauth: string;
  issuer: string;
  account: string;
}

export interface EnrollmentConfirm {
  recoveryCodes: string[];
  enabledAt: Date;
}

export async function isTotpEnabled(
  deps: ServiceDeps,
  userId: string,
): Promise<boolean> {
  const [row] = await deps.db
    .select({ enabledAt: schema.users.totpEnabledAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return Boolean(row?.enabledAt);
}

/** Step one: mint a secret and show it (or its QR) once, unconfirmed. */
export async function beginTotpEnrollment(
  deps: ServiceDeps,
  user: { id: string; email: string },
): Promise<EnrollmentStart> {
  const secret = generateTotpSecret();
  const issuer = "Qansa";

  await deps.db
    .update(schema.users)
    .set({
      totpSecretEnc: encryptSecret(secret, deps.config.appEncryptionKey),
      totpEnabledAt: null,
      updatedAt: nowOf(deps),
    })
    .where(eq(schema.users.id, user.id));

  return {
    secret,
    otpauth: otpauthUrl({ secret, account: user.email, issuer }),
    issuer,
    account: user.email,
  };
}

/**
 * Step two: the first valid code confirms the authenticator actually works
 * before recovery codes are handed out.
 */
export async function confirmTotpEnrollment(
  deps: ServiceDeps,
  user: { id: string; email: string },
  token: string,
): Promise<EnrollmentConfirm> {
  const [row] = await deps.db
    .select({
      secretEnc: schema.users.totpSecretEnc,
      enabledAt: schema.users.totpEnabledAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  if (!row?.secretEnc)
    throw new AppError(
      "TOTP_NOT_STARTED",
      "Mulai pendaftaran 2FA terlebih dahulu",
      409,
    );

  const secret = decryptSecret(row.secretEnc, deps.config.appEncryptionKey);
  if (!verifyTotp(secret, token, { now: nowOf(deps) })) {
    throw new AppError(
      "TOTP_INVALID",
      "Kode 2FA tidak cocok. Periksa jam perangkat Anda lalu coba lagi.",
      400,
    );
  }

  const codes = generateRecoveryCodes();
  const enabledAt = nowOf(deps);

  await deps.db
    .update(schema.users)
    .set({
      totpEnabledAt: enabledAt,
      recoveryCodeHashes: codes.map((code) => recoveryCodeHash(code)),
      updatedAt: enabledAt,
    })
    .where(eq(schema.users.id, user.id));

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: user.id,
    actorLabel: user.email,
    action: "auth.totp_enabled",
    targetType: "user",
    targetId: user.id,
  });

  return { recoveryCodes: codes, enabledAt };
}

export interface TotpVerificationResult {
  ok: boolean;
  /** "totp" for an authenticator code, "recovery" when a recovery code was consumed. */
  method: "totp" | "recovery" | null;
}

export async function verifySecondFactor(
  deps: ServiceDeps,
  user: { id: string; email: string },
  token: string,
): Promise<TotpVerificationResult> {
  const [row] = await deps.db
    .select({
      secretEnc: schema.users.totpSecretEnc,
      enabledAt: schema.users.totpEnabledAt,
      recoveryHashes: schema.users.recoveryCodeHashes,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  if (!row?.enabledAt || !row.secretEnc) return { ok: false, method: null };

  const secret = decryptSecret(row.secretEnc, deps.config.appEncryptionKey);
  if (verifyTotp(secret, token, { now: nowOf(deps) }))
    return { ok: true, method: "totp" };

  // A recovery code is single use: the used hash is removed in the same write.
  const hash = recoveryCodeHash(token);
  const remaining = (row.recoveryHashes ?? []).filter(
    (entry) => entry !== hash,
  );
  if (remaining.length === (row.recoveryHashes ?? []).length)
    return { ok: false, method: null };

  await deps.db
    .update(schema.users)
    .set({ recoveryCodeHashes: remaining, updatedAt: nowOf(deps) })
    .where(eq(schema.users.id, user.id));

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: user.id,
    actorLabel: user.email,
    action: "auth.recovery_code_used",
    targetType: "user",
    targetId: user.id,
    metadata: { remaining: remaining.length },
  });

  return { ok: true, method: "recovery" };
}

export async function disableTotp(
  deps: ServiceDeps,
  user: { id: string; email: string },
): Promise<void> {
  await deps.db
    .update(schema.users)
    .set({
      totpSecretEnc: null,
      totpEnabledAt: null,
      recoveryCodeHashes: null,
      updatedAt: nowOf(deps),
    })
    .where(eq(schema.users.id, user.id));

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: user.id,
    actorLabel: user.email,
    action: "auth.totp_disabled",
    targetType: "user",
    targetId: user.id,
  });
}

export async function regenerateRecoveryCodes(
  deps: ServiceDeps,
  user: { id: string; email: string },
  token: string,
): Promise<string[]> {
  const result = await verifySecondFactor(deps, user, token);
  if (!result.ok)
    throw new AppError("TOTP_INVALID", "Kode 2FA tidak cocok", 400);

  const codes = generateRecoveryCodes();
  await deps.db
    .update(schema.users)
    .set({
      recoveryCodeHashes: codes.map((code) => recoveryCodeHash(code)),
      updatedAt: nowOf(deps),
    })
    .where(eq(schema.users.id, user.id));

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: user.id,
    actorLabel: user.email,
    action: "auth.recovery_codes_regenerated",
    targetType: "user",
    targetId: user.id,
  });

  return codes;
}

/** How many recovery codes are left, so the console can warn before zero. */
export async function recoveryCodesRemaining(
  deps: ServiceDeps,
  userId: string,
): Promise<number> {
  const [row] = await deps.db
    .select({ hashes: schema.users.recoveryCodeHashes })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.hashes?.length ?? 0;
}
