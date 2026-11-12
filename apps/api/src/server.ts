import { createDatabase } from "@qansa/db";
import { createGateway } from "@qansa/shopee-adapter";
import type { Logger } from "@qansa/services";
import pino from "pino";
import { buildApp } from "./app.js";
import { loadConfig } from "./env.js";

/**
 * Process entry point: validate the environment, connect, migrate-check, listen.
 * A missing DATABASE_URL or encryption key aborts here rather than halfway
 * through a customer's claim.
 */

const config = loadConfig();

const logger: Logger = (() => {
  const build = (pretty: boolean) => {
    try {
      return pino({
        level: config.logLevel,
        ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
        redact: ["req.headers.authorization", "req.headers.cookie"],
      });
    } catch {
      // A production image has no pino-pretty; plain JSON is always available.
      return pino({ level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] });
    }
  };

  const base = build(config.nodeEnv === "development");
  return {
    info: (context, message) => base.info(context, message),
    warn: (context, message) => base.warn(context, message),
    error: (context, message) => base.error(context, message),
    debug: (context, message) => base.debug(context, message),
  };
})();

const database = createDatabase(config.databaseUrl, { max: 10 });
const gateway = createGateway({
  mode: config.gatewayMode,
  partnerId: config.partnerId,
  partnerKey: config.partnerKey,
  baseUrl: config.baseUrl,
});

const app = await buildApp({ config, db: database.db, gateway, logger });

if (config.gatewayMode === "fixture") {
  logger.warn(
    { mode: config.gatewayMode },
    "Shopee gateway is running in fixture mode: stores connect to simulated data, not to Shopee",
  );
}

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "shutting down");
  await app.close();
  await database.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.port, host: config.host });
logger.info({ port: config.port, host: config.host, env: config.nodeEnv }, "api listening");
