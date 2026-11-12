import { randomBytes } from "node:crypto";
import { hashPassword } from "@qansa/core";
import { eq, sql } from "drizzle-orm";
import { createDatabase, runMigrations, schema } from "./index.js";

/**
 * Seeds the minimum a fresh deployment needs: one owner account and the
 * settings the claim portal reads before any store exists. Re-running is safe:
 * the owner is only created when the email is unknown.
 */
export interface SeedOptions {
  databaseUrl: string;
  adminEmail: string;
  adminName: string;
  /** When omitted a random password is generated and returned once. */
  adminPassword?: string;
}

export interface SeedResult {
  ownerEmail: string;
  /** Present only when the password was generated here. */
  generatedPassword?: string;
  created: boolean;
}

export async function seed({ databaseUrl, adminEmail, adminName, adminPassword }: SeedOptions): Promise<SeedResult> {
  const handle = createDatabase(databaseUrl, { max: 1 });
  try {
    await runMigrations(handle);
    const db = handle.db;

    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${adminEmail.toLowerCase()}`)
      .limit(1);

    let result: SeedResult = { ownerEmail: adminEmail, created: false };

    if (existing.length === 0) {
      const password = adminPassword ?? randomBytes(15).toString("base64url");
      await db.insert(schema.users).values({
        email: adminEmail,
        name: adminName,
        role: "OWNER",
        passwordHash: await hashPassword(password),
      });
      result = {
        ownerEmail: adminEmail,
        created: true,
        ...(adminPassword ? {} : { generatedPassword: password }),
      };
    }

    const defaults: Array<{ key: string; value: unknown }> = [
      {
        key: "branding",
        value: {
          brandName: "Qansa",
          tagline: "Klaim produk digital Anda dalam hitungan detik",
          supportEmail: "support@qansa.web.id",
          supportWhatsapp: "+62 853-7050-2250",
          claimDomain: "claim.qansa.web.id",
        },
      },
      { key: "claim", value: { sessionMinutes: 30, maxAttemptsPerHour: 8, downloadTtlMinutes: 10, maxDownloadsPerFulfillment: 5 } },
      { key: "sync", value: { productIntervalMinutes: 30, orderReconcileMinutes: 10, orderLookbackHours: 72 } },
    ];

    for (const entry of defaults) {
      await db
        .insert(schema.systemSettings)
        .values({ key: entry.key, value: entry.value })
        .onConflictDoNothing({ target: schema.systemSettings.key });
    }

    return result;
  } finally {
    await handle.close();
  }
}

export async function findUserByEmail(databaseUrl: string, email: string) {
  const handle = createDatabase(databaseUrl, { max: 1 });
  try {
    const [user] = await handle.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    return user;
  } finally {
    await handle.close();
  }
}
