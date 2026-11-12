import { schema } from "@qansa/db";
import { inArray } from "drizzle-orm";
import type { ServiceDeps } from "./types.js";

/**
 * Settings live in `system_settings` as JSON so an operator can change claim
 * limits without a deploy. Every read falls back to these defaults, so a fresh
 * database behaves predictably before anything is written.
 */
export interface BrandingSettings {
  brandName: string;
  tagline: string;
  supportEmail: string;
  supportWhatsapp: string;
  claimDomain: string;
}

export interface ClaimSettings {
  /** Minutes a verified claim session stays valid. */
  sessionMinutes: number;
  /** Failed verifications allowed per IP per hour. */
  maxAttemptsPerHour: number;
  /** Failed verifications allowed per order per hour, across IPs. */
  maxAttemptsPerOrder: number;
  /** Minutes a signed download link stays valid. */
  downloadTtlMinutes: number;
  /** File downloads allowed per claim. */
  maxDownloadsPerFulfillment: number;
}

export interface SyncSettings {
  productIntervalMinutes: number;
  orderReconcileMinutes: number;
  orderLookbackHours: number;
}

export interface AllSettings {
  branding: BrandingSettings;
  claim: ClaimSettings;
  sync: SyncSettings;
}

export const DEFAULT_SETTINGS: AllSettings = {
  branding: {
    brandName: "Qansa",
    tagline: "Klaim produk digital Anda dalam hitungan detik",
    supportEmail: "support@qansa.web.id",
    supportWhatsapp: "+62 853-7050-2250",
    claimDomain: "claim.qansa.web.id",
  },
  claim: {
    sessionMinutes: 30,
    maxAttemptsPerHour: 8,
    maxAttemptsPerOrder: 12,
    downloadTtlMinutes: 10,
    maxDownloadsPerFulfillment: 5,
  },
  sync: {
    productIntervalMinutes: 30,
    orderReconcileMinutes: 10,
    orderLookbackHours: 72,
  },
};

type SettingKey = keyof AllSettings;

export async function loadSettings(deps: ServiceDeps): Promise<AllSettings> {
  const rows = await deps.db
    .select({ key: schema.systemSettings.key, value: schema.systemSettings.value })
    .from(schema.systemSettings)
    .where(inArray(schema.systemSettings.key, ["branding", "claim", "sync"]));

  const stored = new Map(rows.map((row) => [row.key, row.value as Record<string, unknown>]));

  const merge = <K extends SettingKey>(key: K): AllSettings[K] => ({
    ...DEFAULT_SETTINGS[key],
    ...(stored.get(key) ?? {}),
  });

  return { branding: merge("branding"), claim: merge("claim"), sync: merge("sync") };
}

export async function saveSetting(deps: ServiceDeps, key: SettingKey, value: unknown): Promise<void> {
  await deps.db
    .insert(schema.systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value, updatedAt: new Date() } });
}
