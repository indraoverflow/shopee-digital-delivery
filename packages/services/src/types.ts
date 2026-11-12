import type { Database } from "@qansa/db";
import type { ShopeeGateway } from "@qansa/shopee-adapter";

/** What a service needs from the process it runs in. Nothing else is imported. */
export interface ServiceConfig {
  /** 32-byte hex key for AES-256-GCM over tokens and codes. */
  appEncryptionKey: string;
  /** HMAC key for expiring download links. */
  downloadSigningSecret: string;
  /** Directory that holds uploaded digital assets. */
  uploadDir: string;
  /** Public origin of the claim portal, used to build buyer-facing links. */
  claimOrigin: string;
  /** Public origin of the API, where signed download links resolve. */
  apiPublicOrigin: string;
  /** "live" talks to Shopee, "fixture" runs the same code against fixtures. */
  gatewayMode: "live" | "fixture";
  /** How far back a reconciliation sweep looks, in hours. */
  orderLookbackHours: number;
}

export interface Logger {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
  debug?: (context: Record<string, unknown>, message: string) => void;
}

export interface ServiceDeps {
  db: Database;
  gateway: ShopeeGateway;
  config: ServiceConfig;
  logger: Logger;
  /** Injectable clock: tests pin time instead of sleeping. */
  now?: () => Date;
}

export const nowOf = (deps: ServiceDeps): Date => (deps.now ? deps.now() : new Date());
