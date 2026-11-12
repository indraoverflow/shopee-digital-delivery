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

const pinoLogger = pino({
  level: config.logLevel,
  ...(config.nodeEnv === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : {}),
  redact: ["req.headers.authorization", "req.headers.cookie"],
});

const logger: Logger = {
  info: (context, message) => pinoLogger.info(context, message),
  warn: (context, message) => pinoLogger.warn(context, message),
  error: (context, message) => pinoLogger.error(context, message),
  debug: (context, message) => pinoLogger.debug(context, message),
};

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
