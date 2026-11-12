import { hostname } from "node:os";
import { createDatabase } from "@qansa/db";
import { createGateway } from "@qansa/shopee-adapter";
import { createLogger } from "./logger.js";
import { z } from "zod";
import { startWorkerLoop } from "./worker.js";

/**
 * The worker process. It shares the API's database and Shopee credentials, and
 * owns everything the buyer waits on: order processing, catalogue sync,
 * reconciliation sweeps and claim expiry.
 */

const booleanish = z.enum(["true", "false", "1", "0"]).default("true").transform((value) => value === "true" || value === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  DOWNLOAD_SIGNING_SECRET: z.string().min(32),
  SHOPEE_GATEWAY_MODE: z.enum(["live", "fixture"]).default("fixture"),
  SHOPEE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  SHOPEE_PARTNER_ID: z.coerce.number().int().positive().default(2000000),
  SHOPEE_PARTNER_KEY: z.string().default("fixture-partner-key"),
  SHOPEE_BASE_URL: z.string().url().optional(),
  UPLOAD_DIR: z.string().default("./data/uploads"),
  CLAIM_ORIGIN: z.string().url().default("https://claim.qansa.web.id"),
  API_PUBLIC_ORIGIN: z.string().url().default("https://api.qansa.web.id"),
  ORDER_LOOKBACK_HOURS: z.coerce.number().int().positive().default(72),
  PRODUCT_SYNC_MINUTES: z.coerce.number().int().positive().default(30),
  ORDER_RECONCILE_MINUTES: z.coerce.number().int().positive().default(10),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_MAINTENANCE_MS: z.coerce.number().int().positive().default(300_000),
  RUN_ONCE: booleanish,
});

const env = schema.parse(process.env);

const { logger } = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === "development" });

const database = createDatabase(env.DATABASE_URL, { max: 5 });
const gateway = createGateway({
  mode: env.SHOPEE_GATEWAY_MODE,
  partnerId: env.SHOPEE_PARTNER_ID,
  partnerKey: env.SHOPEE_PARTNER_KEY,
  baseUrl: env.SHOPEE_BASE_URL ?? (env.SHOPEE_ENV === "production" ? "https://partner.shopeemobile.com" : "https://openplatform.sandbox.test-stable.shopee.sg"),
});

const context = {
  deps: {
    db: database.db,
    gateway,
    logger,
    config: {
      appEncryptionKey: env.APP_ENCRYPTION_KEY,
      downloadSigningSecret: env.DOWNLOAD_SIGNING_SECRET,
      uploadDir: env.UPLOAD_DIR,
      claimOrigin: env.CLAIM_ORIGIN,
      apiPublicOrigin: env.API_PUBLIC_ORIGIN,
      gatewayMode: env.SHOPEE_GATEWAY_MODE,
      orderLookbackHours: env.ORDER_LOOKBACK_HOURS,
    },
  },
  logger,
};

const workerId = `${hostname()}:${process.pid}`;
const stopSignal = { stopped: false };

process.on("SIGTERM", () => {
  stopSignal.stopped = true;
});
process.on("SIGINT", () => {
  stopSignal.stopped = true;
});

if (env.SHOPEE_GATEWAY_MODE === "fixture") {
  logger.warn({}, "worker is running against the fixture Shopee gateway, not the live API");
}

try {
  await startWorkerLoop(context, {
    workerId,
    pollIntervalMs: env.WORKER_POLL_MS,
    maintenanceIntervalMs: env.WORKER_MAINTENANCE_MS,
    schedule: { productIntervalMinutes: env.PRODUCT_SYNC_MINUTES, orderReconcileMinutes: env.ORDER_RECONCILE_MINUTES },
    stopSignal,
  });
} finally {
  await database.close();
}
