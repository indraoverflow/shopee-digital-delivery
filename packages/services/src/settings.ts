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
  /** Days a manual verification request may sit before it expires. */
  manualRequestDays: number;
  /** Hours an approved manual verification stays usable. */
  manualApprovalHours: number;
  /**
   * Mark the order shipped in Shopee as soon as the buyer takes the product.
   * Digital shops use jasa kirim toko, a non-integrated channel, so the platform
   * has to supply a resi; waiting for an operator means the order can be cancelled
   * while the buyer already has the product.
   */
  autoShipOnClaim: boolean;
  /** Prefix for the resi the platform assigns when it ships on the buyer's behalf. */
  autoShipPrefix: string;
  /**
   * When to hand the shipment to Shopee. A digital order is delivered the moment
   * it is paid ("ON_PAYMENT", the default for a shop that treats the portal as the
   * delivery), or once the buyer actually takes the product ("ON_CLAIM").
   */
  autoShipTrigger: "ON_PAYMENT" | "ON_CLAIM";
}

/**
 * Outbound notifications. A single webhook keeps the platform dependency-free:
 * point it at a Slack incoming hook, an n8n flow or the WhatsApp gateway, and a
 * failed delivery is logged rather than blocking a claim.
 */
/**
 * e-Meterai credentials for minting buyer links. The password is stored encrypted
 * with APP_ENCRYPTION_KEY, the same way Shopee tokens are: settings live in a JSON
 * column, and a JSON column is not a place for a plaintext password.
 */
export interface MeteraiSettings {
  enabled: boolean;
  /** Account user, which is not always the email: the dashboard sends `user`. */
  user: string;
  passwordEnc: string | null;
  baseUrl: string | null;
}

export interface NotifySettings {
  enabled: boolean;
  webhookUrl: string | null;
  /** HMAC key for the x-qansa-signature header; optional. */
  secret: string | null;
  events: string[];
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
  notify: NotifySettings;
  meterai: MeteraiSettings;
}

export const DEFAULT_SETTINGS: AllSettings = {
  branding: {
    // The platform is not sold as a service yet, so the default carries the product name
    // only. A shop that connects its own domain overrides this in settings.
    brandName: "Serah Terima",
    tagline: "Klaim produk digital Anda dalam hitungan detik",
    supportEmail: "",
    supportWhatsapp: "+62 853-7050-2250",
    claimDomain: "claim.example.com",
  },
  claim: {
    sessionMinutes: 30,
    maxAttemptsPerHour: 8,
    maxAttemptsPerOrder: 12,
    downloadTtlMinutes: 10,
    maxDownloadsPerFulfillment: 5,
    manualRequestDays: 3,
    manualApprovalHours: 24,
    autoShipOnClaim: true,
    autoShipPrefix: "DIGITAL-",
    autoShipTrigger: "ON_PAYMENT",
  },
  meterai: {
    enabled: false,
    user: "",
    passwordEnc: null,
    baseUrl: null,
  },
  sync: {
    productIntervalMinutes: 30,
    orderReconcileMinutes: 10,
    orderLookbackHours: 72,
  },
  notify: {
    enabled: false,
    webhookUrl: null,
    secret: null,
    events: [
      "claim.completed",
      "claim.revoked",
      "fulfillment.out_of_stock",
      "sync.failed",
    ],
  },
};

type SettingKey = keyof AllSettings;

export async function loadSettings(deps: ServiceDeps): Promise<AllSettings> {
  const rows = await deps.db
    .select({
      key: schema.systemSettings.key,
      value: schema.systemSettings.value,
    })
    .from(schema.systemSettings)
    .where(
      inArray(schema.systemSettings.key, [
        "branding",
        "claim",
        "sync",
        "notify",
        "meterai",
      ]),
    );

  const stored = new Map(
    rows.map((row) => [row.key, row.value as Record<string, unknown>]),
  );

  const merge = <K extends SettingKey>(key: K): AllSettings[K] => ({
    ...DEFAULT_SETTINGS[key],
    ...(stored.get(key) ?? {}),
  });

  return {
    branding: merge("branding"),
    claim: merge("claim"),
    sync: merge("sync"),
    notify: merge("notify"),
    meterai: merge("meterai"),
  };
}

export async function saveSetting(
  deps: ServiceDeps,
  key: SettingKey,
  value: unknown,
): Promise<void> {
  await deps.db
    .insert(schema.systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.systemSettings.key,
      set: { value, updatedAt: new Date() },
    });
}
