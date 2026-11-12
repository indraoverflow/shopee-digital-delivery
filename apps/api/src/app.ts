import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { AppError } from "@qansa/core";
import { schema, type Database } from "@qansa/db";
import {
  LocalAssetStore,
  loadSettings,
  recordAudit,
  type AllSettings,
  type AuditInput,
  type Logger,
  type ServiceDeps,
} from "@qansa/services";
import type { ShopeeGateway } from "@qansa/shopee-adapter";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { ApiConfig } from "./env.js";
import { requireCsrf, requirePermission, type AuthUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { claimRoutes } from "./routes/claims.js";
import { digitalProductRoutes } from "./routes/digital-products.js";
import { orderRoutes } from "./routes/orders.js";
import { overviewRoutes } from "./routes/overview.js";
import { publicRoutes } from "./routes/public.js";
import { settingsRoutes } from "./routes/settings.js";
import { storeRoutes } from "./routes/stores.js";
import { webhookRoutes } from "./routes/webhook.js";

export interface AppContext {
  db: Database;
  sql: typeof sql;
  deps: ServiceDeps;
  config: ApiConfig;
  assets: LocalAssetStore;
  logger: Logger;
  gateway: ShopeeGateway;
  settings: () => Promise<AllSettings>;
  audit: (input: AuditInput) => Promise<void>;
  requirePermissionFor: (request: unknown, permission: Parameters<typeof requirePermission>[1]) => Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
    logger: Logger & { error: (context: Record<string, unknown>, message: string) => void };
  }
  interface FastifyRequest {
    user?: AuthUser;
    /** Raw bytes of the request body, needed for the push signature. */
    rawBody?: Buffer;
  }
}

export interface BuildAppOptions {
  config: ApiConfig;
  db: Database;
  gateway: ShopeeGateway;
  logger?: Logger;
  now?: () => Date;
}

/**
 * The whole HTTP surface in one place: plugins, the error contract, the CSRF
 * gate and the route modules. Tests build the same app against pglite, so what
 * is exercised in CI is the code that ships.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const logger = options.logger ?? quiet;

  const app = Fastify({
    logger:
      options.logger !== undefined || process.env.NODE_ENV === "test"
        ? false
        : {
            level: options.config.logLevel,
            redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
          },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: options.config.nodeEnv === "test",
  });

  const deps: ServiceDeps = {
    db: options.db,
    gateway: options.gateway,
    config: options.config.service,
    logger,
    ...(options.now ? { now: options.now } : {}),
  };

  const assets = new LocalAssetStore(options.config.uploadDir);

  app.decorate("ctx", {
    db: options.db,
    sql,
    deps,
    config: options.config,
    assets,
    logger,
    gateway: options.gateway,
    settings: () => loadSettings(deps),
    audit: (input: AuditInput) => recordAudit(deps, input),
    requirePermissionFor: async (request: unknown, permission) => {
      const handler = requirePermission({ db: options.db }, permission);
      await handler(request as never);
    },
  } satisfies AppContext);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  /**
   * A same-origin request through the web proxy still carries the browser's
   * Origin, so it must be allowed explicitly. Outside production any loopback
   * port is accepted, which is what makes `next dev --port 4001` work without
   * editing the allow list.
   */
  const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (options.config.origins.includes(origin)) return callback(null, true);
      if (options.config.nodeEnv !== "production" && localOrigin.test(origin)) return callback(null, true);
      return callback(new AppError("CORS_BLOCKED", "Origin tidak diizinkan", 403), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token", "authorization"],
  });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute", allowList: [] });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  /**
   * Keep the raw bytes of every JSON body: the push signature is computed over
   * them, and re-serialising the parsed object breaks it.
   */
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    request.rawBody = buffer;
    if (buffer.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buffer.toString("utf8")));
    } catch {
      done(new AppError("INVALID_JSON", "Body bukan JSON yang valid", 400), undefined);
    }
  });

  /** CSRF applies to any state-changing admin call that carries a session. */
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (request.url === "/api/auth/login") return;
    if (request.cookies.qansa_session) requireCsrf(request);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details ?? undefined } });
    }
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Data yang dikirim tidak valid",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Terlalu banyak permintaan. Coba lagi sebentar." } });
    }
    if ((error as { statusCode?: number }).statusCode && (error as { statusCode: number }).statusCode < 500) {
      return reply
        .code((error as { statusCode: number }).statusCode)
        .send({ error: { code: "REQUEST_INVALID", message: error instanceof Error ? error.message : "Permintaan tidak valid" } });
    }

    request.log.error({ err: error }, "unhandled error");
    logger.error({ err: error instanceof Error ? error.message : String(error), url: request.url }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Terjadi kesalahan pada server" } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: `Rute ${request.method} ${request.url} tidak ditemukan` } });
  });

  await app.register(publicRoutes);
  await app.register(webhookRoutes);
  await app.register(authRoutes);
  await app.register(storeRoutes);
  await app.register(catalogRoutes);
  await app.register(digitalProductRoutes);
  await app.register(orderRoutes);
  await app.register(claimRoutes);
  await app.register(overviewRoutes);
  await app.register(settingsRoutes);

  // One last check that the schema this API expects is actually the one the
  // database has: a missing migration should fail loudly at boot.
  try {
    await options.db.select({ id: schema.users.id }).from(schema.users).limit(1);
  } catch (error) {
    throw new Error(
      `database schema mismatch (did the migrations run?): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return app;
}
