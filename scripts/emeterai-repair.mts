/**
 * Fill a fulfilment that holds fewer e-Meterai links than the buyer paid for.
 *
 *   npx tsx scripts/emeterai-repair.mts <fulfillment_id>
 *
 * Builds the same dependency object the worker uses, so settings decryption and notifications
 * behave as they do in a real job. Only the missing count is minted, so the run costs exactly
 * what it fills, and every call writes an order event and an audit row marked `repair: true`.
 * The gateway is unused on this path.
 */
import { loadConfig } from "../apps/api/src/env.js";
import { createLogger } from "../apps/worker/src/logger.js";
import { createDatabase } from "../packages/db/src/index.js";
import { mintMissingLinks } from "../packages/services/src/index.js";

const fulfillmentId = process.argv[2]?.trim();
if (!fulfillmentId) {
  console.error("usage: emeterai-repair.mts <fulfillment_id>");
  process.exit(1);
}

const config = loadConfig();
const { logger } = createLogger({ level: process.env.LOG_LEVEL ?? "info" });
const handle = createDatabase(config.databaseUrl);

try {
  const result = await mintMissingLinks(
    { db: handle.db, config: config.service, logger, gateway: {} as never },
    { fulfillmentId, actor: { id: "", email: "repair-script@localhost" } },
  );
  console.log(
    JSON.stringify({
      fulfillmentId,
      quantity: result.quantity,
      added: result.added,
      links: result.urls.length,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      fulfillmentId,
      error: String((error as Error).stack ?? (error as Error).message),
    }),
  );
  process.exitCode = 1;
}
await handle.close();
