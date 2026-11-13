import type { JobType, Logger, ServiceDeps } from "@qansa/services";
import {
  claimNextJob,
  completeJob,
  enqueue,
  expireStaleFulfillments,
  failJob,
  getStoreAccess,
  processOrder,
  recoverStuckJobs,
  runOrderSync,
  runProductSync,
  queueStats,
  runRetentionSweep,
} from "@qansa/services";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";

/**
 * Job handlers. The worker owns everything asynchronous: pushes land in the
 * queue, the queue calls these, and each one is safe to run twice because the
 * pipeline underneath is idempotent.
 */

export interface WorkerContext {
  deps: ServiceDeps;
  logger: Logger;
}

export interface HandlerOptions {
  workerId: string;
}

export async function handleJob(
  context: WorkerContext,
  job: { id: string; type: JobType; payload: Record<string, unknown> },
  _options: HandlerOptions,
): Promise<string> {
  const { deps, logger } = context;
  const storeId =
    typeof job.payload.storeId === "string" ? job.payload.storeId : undefined;

  switch (job.type) {
    case "PROCESS_ORDER": {
      const orderSn =
        typeof job.payload.orderSn === "string"
          ? job.payload.orderSn
          : undefined;
      if (!storeId || !orderSn)
        throw new Error("PROCESS_ORDER requires storeId and orderSn");

      const summary = await processOrder(deps, storeId, orderSn);
      if (!summary) {
        // The push named an order Shopee will not return: often a deleted or
        // unauthorised shop. It is not retryable, so it succeeds with a note.
        logger.warn(
          { jobId: job.id, orderSn, storeId },
          "push referenced an order Shopee could not return",
        );
        return "order not returned by Shopee";
      }
      logger.info(
        {
          jobId: job.id,
          orderSn,
          state: summary.state,
          claimable: summary.fulfillments,
        },
        "order processed",
      );
      return `state=${summary.state}`;
    }

    case "SYNC_PRODUCTS": {
      if (!storeId) throw new Error("SYNC_PRODUCTS requires storeId");
      const stats = await runProductSync(deps, {
        storeId,
        syncJobId:
          typeof job.payload.syncJobId === "string"
            ? job.payload.syncJobId
            : null,
      });
      return `items=${stats.items}`;
    }

    case "SYNC_ORDERS": {
      if (!storeId) throw new Error("SYNC_ORDERS requires storeId");
      const stats = await runOrderSync(deps, {
        storeId,
        syncJobId:
          typeof job.payload.syncJobId === "string"
            ? job.payload.syncJobId
            : null,
        ...(typeof job.payload.lookbackHours === "number"
          ? { lookbackHours: job.payload.lookbackHours }
          : {}),
      });
      return `processed=${stats.processed}`;
    }

    case "EXPIRE_CLAIMS": {
      const result = await expireStaleFulfillments(deps);
      if (result.fulfillments > 0)
        logger.info(result, "expired stale claim windows");
      return `fulfillments=${result.fulfillments}`;
    }

    case "RETENTION_SWEEP": {
      const counts = await runRetentionSweep(deps);
      return `claimSessions=${counts.claimSessions} sessions=${counts.sessions} webhooks=${counts.webhookEvents} jobs=${counts.jobs}`;
    }

    case "RECONCILE_STORES": {
      // The scheduled fallback for pushes that never arrived.
      const stores = await deps.db
        .select({ id: schema.shopeeStores.id })
        .from(schema.shopeeStores)
        .where(eq(schema.shopeeStores.status, "CONNECTED"));
      for (const store of stores) {
        await enqueue(deps, {
          type: "SYNC_ORDERS",
          payload: { storeId: store.id },
          dedupeKey: `SYNC_ORDERS:${store.id}`,
          runAt: new Date(Date.now() + 1_000),
        });
      }
      return `stores=${stores.length}`;
    }

    case "REFRESH_TOKENS": {
      const stores = await deps.db
        .select({ id: schema.shopeeStores.id })
        .from(schema.shopeeStores)
        .where(eq(schema.shopeeStores.status, "CONNECTED"));
      let refreshed = 0;
      for (const store of stores) {
        try {
          const result = await getStoreAccess(deps, store.id);
          if (result.refreshed) refreshed += 1;
        } catch (error) {
          logger.warn(
            {
              storeId: store.id,
              err: error instanceof Error ? error.message : String(error),
            },
            "token refresh failed",
          );
        }
      }
      return `refreshed=${refreshed}`;
    }

    default: {
      const exhaustive: never = job.type;
      throw new Error(`unknown job type ${String(exhaustive)}`);
    }
  }
}

export interface RunOnceResult {
  processed: number;
  failed: number;
  idle: boolean;
}

/**
 * Drains the queue once. Used by the worker loop and by tests, which is why the
 * loop itself only decides when to call it.
 */
export async function runOnce(
  context: WorkerContext,
  options: HandlerOptions & { maxJobs?: number },
): Promise<RunOnceResult> {
  const maxJobs = options.maxJobs ?? 25;
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < maxJobs; index += 1) {
    const job = await claimNextJob(context.deps, options.workerId);
    if (!job) return { processed, failed, idle: true };

    try {
      const detail = await handleJob(context, job, options);
      await completeJob(context.deps, job.id);
      processed += 1;
      context.logger.info(
        { jobId: job.id, type: job.type, detail },
        "job succeeded",
      );
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await failJob(context.deps, job, message);
      context.logger.error(
        { jobId: job.id, type: job.type, outcome, err: message },
        "job failed",
      );
    }
  }

  return { processed, failed, idle: false };
}

export interface ScheduleInput {
  productIntervalMinutes: number;
  orderReconcileMinutes: number;
}

/**
 * Recurring work, expressed as queue jobs with a dedupe key so an overlapping
 * tick cannot pile up a second sweep.
 */
export async function scheduleMaintenance(
  context: WorkerContext,
  input: ScheduleInput,
): Promise<void> {
  const { deps } = context;

  await enqueue(deps, {
    type: "EXPIRE_CLAIMS",
    payload: {},
    dedupeKey: "EXPIRE_CLAIMS",
    runAt: new Date(Date.now() + 2_000),
  });
  await enqueue(deps, {
    type: "RECONCILE_STORES",
    payload: {},
    dedupeKey: "RECONCILE_STORES",
    runAt: new Date(Date.now() + 3_000),
  });
  // Operational data has a shelf life; the sweep is daily and idempotent.
  await enqueue(deps, {
    type: "RETENTION_SWEEP",
    payload: {},
    dedupeKey: "RETENTION_SWEEP",
    runAt: new Date(Date.now() + 24 * 3600_000),
  });
  await enqueue(deps, {
    type: "REFRESH_TOKENS",
    payload: {},
    dedupeKey: "REFRESH_TOKENS",
    runAt: new Date(Date.now() + 5_000),
  });

  const stores = await deps.db
    .select({ id: schema.shopeeStores.id })
    .from(schema.shopeeStores)
    .where(eq(schema.shopeeStores.status, "CONNECTED"));
  for (const store of stores) {
    await enqueue(deps, {
      type: "SYNC_PRODUCTS",
      payload: { storeId: store.id },
      dedupeKey: `SYNC_PRODUCTS:${store.id}`,
      runAt: new Date(Date.now() + input.productIntervalMinutes * 60_000),
    });
    await enqueue(deps, {
      type: "SYNC_ORDERS",
      payload: { storeId: store.id },
      dedupeKey: `SYNC_ORDERS:${store.id}`,
      runAt: new Date(Date.now() + input.orderReconcileMinutes * 60_000),
    });
  }
}

export interface WorkerLoopOptions extends HandlerOptions {
  pollIntervalMs?: number;
  maintenanceIntervalMs?: number;
  schedule?: ScheduleInput;
  stopSignal?: { stopped: boolean };
}

/** The long-running loop: poll, drain, maintain, sleep. */
export async function startWorkerLoop(
  context: WorkerContext,
  options: WorkerLoopOptions,
): Promise<void> {
  const pollInterval = options.pollIntervalMs ?? 1_000;
  const maintenanceInterval = options.maintenanceIntervalMs ?? 5 * 60_000;
  let lastMaintenance = 0;

  context.logger.info(
    { workerId: options.workerId, pollInterval, maintenanceInterval },
    "worker started",
  );

  while (!options.stopSignal?.stopped) {
    const result = await runOnce(context, { ...options, maxJobs: 10 });

    if (Date.now() - lastMaintenance > maintenanceInterval) {
      lastMaintenance = Date.now();
      await recoverStuckJobs(context.deps).then((count) => {
        if (count > 0) context.logger.warn({ count }, "recovered stale jobs");
      });
      if (options.schedule)
        await scheduleMaintenance(context, options.schedule);
      const stats = await queueStats(context.deps);
      context.logger.info({ ...stats }, "queue stats");
    }

    if (result.idle)
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  context.logger.info({}, "worker stopped");
}
