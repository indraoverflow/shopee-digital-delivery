import { z } from "zod";
import type { ServiceConfig } from "@qansa/services";

/**
 * Every setting the API needs, validated once at boot. A missing encryption key
 * or signing secret is a startup failure, not a runtime surprise that shows up
 * as a plaintext token in the database.
 */
const booleanish = z
  .enum(["true", "false", "1", "0"])
  .default("true")
  .transform((value) => value === "true" || value === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "APP_ENCRYPTION_KEY must be 64 hex characters"),
  DOWNLOAD_SIGNING_SECRET: z.string().min(32, "DOWNLOAD_SIGNING_SECRET must be at least 32 characters"),
  SESSION_COOKIE_SECURE: booleanish,

  ADMIN_ORIGIN: z.string().url().default("https://admin.qansa.web.id"),
  CLAIM_ORIGIN: z.string().url().default("https://claim.qansa.web.id"),
  API_PUBLIC_ORIGIN: z.string().url().default("https://api.qansa.web.id"),
  /** Extra origins allowed by CORS, comma separated. */
  EXTRA_ORIGINS: z.string().optional(),

  SHOPEE_GATEWAY_MODE: z.enum(["live", "fixture"]).default("fixture"),
  SHOPEE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  SHOPEE_PARTNER_ID: z.coerce.number().int().positive().default(2000000),
  SHOPEE_PARTNER_KEY: z.string().default("fixture-partner-key"),
  SHOPEE_BASE_URL: z.string().url().optional(),
  /** Exact public URL of the push endpoint; its signature covers this string. */
  SHOPEE_PUSH_URL: z.string().url().optional(),
  SHOPEE_PUSH_TEST_PARTNER_KEY: z.string().optional(),
  /** Where Shopee returns the seller after authorizing the app. */
  SHOPEE_REDIRECT_URL: z.string().url().default("https://api.qansa.web.id/api/integration/shopee/callback"),

  UPLOAD_DIR: z.string().default("./data/uploads"),
  ORDER_LOOKBACK_HOURS: z.coerce.number().int().positive().default(72),
});

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string;
  sessionCookieSecure: boolean;
  adminOrigin: string;
  claimOrigin: string;
  apiPublicOrigin: string;
  origins: string[];
  gatewayMode: "live" | "fixture";
  shopeeEnv: "sandbox" | "production";
  partnerId: number;
  partnerKey: string;
  baseUrl: string;
  pushUrl?: string;
  pushTestPartnerKey?: string;
  redirectUrl: string;
  uploadDir: string;
  service: ServiceConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.parse(env);
  const baseUrl =
    parsed.SHOPEE_BASE_URL ??
    (parsed.SHOPEE_ENV === "production"
      ? "https://partner.shopeemobile.com"
      : "https://openplatform.sandbox.test-stable.shopee.sg");

  const origins = [parsed.ADMIN_ORIGIN, parsed.CLAIM_ORIGIN, ...(parsed.EXTRA_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [])];

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    sessionCookieSecure: parsed.SESSION_COOKIE_SECURE,
    adminOrigin: parsed.ADMIN_ORIGIN,
    claimOrigin: parsed.CLAIM_ORIGIN,
    apiPublicOrigin: parsed.API_PUBLIC_ORIGIN,
    origins,
    gatewayMode: parsed.SHOPEE_GATEWAY_MODE,
    shopeeEnv: parsed.SHOPEE_ENV,
    partnerId: parsed.SHOPEE_PARTNER_ID,
    partnerKey: parsed.SHOPEE_PARTNER_KEY,
    baseUrl,
    ...(parsed.SHOPEE_PUSH_URL ? { pushUrl: parsed.SHOPEE_PUSH_URL } : {}),
    ...(parsed.SHOPEE_PUSH_TEST_PARTNER_KEY ? { pushTestPartnerKey: parsed.SHOPEE_PUSH_TEST_PARTNER_KEY } : {}),
    redirectUrl: parsed.SHOPEE_REDIRECT_URL,
    uploadDir: parsed.UPLOAD_DIR,
    service: {
      appEncryptionKey: parsed.APP_ENCRYPTION_KEY,
      downloadSigningSecret: parsed.DOWNLOAD_SIGNING_SECRET,
      uploadDir: parsed.UPLOAD_DIR,
      claimOrigin: parsed.CLAIM_ORIGIN,
      apiPublicOrigin: parsed.API_PUBLIC_ORIGIN,
      gatewayMode: parsed.SHOPEE_GATEWAY_MODE,
      orderLookbackHours: parsed.ORDER_LOOKBACK_HOURS,
    },
  };
}
