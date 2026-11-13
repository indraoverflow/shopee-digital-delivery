import { AppError, decryptSecret, encryptSecret } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Re-encrypts every secret that lives under APP_ENCRYPTION_KEY.
 *
 * Run it once with both keys present, keep the old key in the environment until
 * the run reports success, then remove it. The whole rotation happens in one
 * transaction: a failure leaves every row on the old key, so the service keeps
 * working instead of half-rotating.
 */

export interface RotationResult {
  shopeeTokens: number;
  activationCodes: number;
  totpSecrets: number;
  dryRun: boolean;
}

export interface RotationInput {
  oldKey: string;
  newKey: string;
  /** Re-encrypt inside a transaction that is rolled back at the end. */
  dryRun?: boolean;
}

export async function rotateEncryptionKey(
  deps: ServiceDeps,
  input: RotationInput,
): Promise<RotationResult> {
  if (input.oldKey === input.newKey)
    throw AppError.validation("Kunci lama dan baru tidak boleh sama");
  if (
    !/^[0-9a-fA-F]{64}$/.test(input.newKey) ||
    !/^[0-9a-fA-F]{64}$/.test(input.oldKey)
  ) {
    throw AppError.validation("Kedua kunci harus 64 karakter hex");
  }

  const dryRun = input.dryRun ?? false;
  const result: RotationResult = {
    shopeeTokens: 0,
    activationCodes: 0,
    totpSecrets: 0,
    dryRun,
  };

  const work = async (
    tx: Parameters<Parameters<typeof deps.db.transaction>[0]>[0],
  ) => {
    const tokens = await tx.select().from(schema.shopeeTokens);
    for (const token of tokens) {
      const access = decryptSecret(token.accessTokenEnc, input.oldKey);
      const refresh = decryptSecret(token.refreshTokenEnc, input.oldKey);
      await tx
        .update(schema.shopeeTokens)
        .set({
          accessTokenEnc: encryptSecret(access, input.newKey),
          refreshTokenEnc: encryptSecret(refresh, input.newKey),
          updatedAt: nowOf(deps),
        })
        .where(eq(schema.shopeeTokens.id, token.id));
      result.shopeeTokens += 1;
    }

    const codes = await tx
      .select({
        id: schema.digitalProductCodes.id,
        secretEnc: schema.digitalProductCodes.secretEnc,
      })
      .from(schema.digitalProductCodes);
    for (const code of codes) {
      const secret = decryptSecret(code.secretEnc, input.oldKey);
      await tx
        .update(schema.digitalProductCodes)
        .set({ secretEnc: encryptSecret(secret, input.newKey) })
        .where(eq(schema.digitalProductCodes.id, code.id));
      result.activationCodes += 1;
    }

    const users = await tx
      .select({
        id: schema.users.id,
        totpSecretEnc: schema.users.totpSecretEnc,
      })
      .from(schema.users);
    for (const user of users) {
      if (!user.totpSecretEnc) continue;
      const secret = decryptSecret(user.totpSecretEnc, input.oldKey);
      await tx
        .update(schema.users)
        .set({ totpSecretEnc: encryptSecret(secret, input.newKey) })
        .where(eq(schema.users.id, user.id));
      result.totpSecrets += 1;
    }

    if (dryRun) {
      // Roll the whole thing back: the caller wanted the count, not the change.
      throw new DryRunRollback();
    }
  };

  try {
    await deps.db.transaction(work);
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  if (!dryRun) {
    await recordAudit(deps, {
      actorType: "SYSTEM",
      action: "security.key_rotation",
      metadata: { ...result },
    });
  }

  return result;
}

class DryRunRollback extends Error {
  constructor() {
    super("dry run");
  }
}
