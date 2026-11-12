import { createTestDatabase, schema, type TestDatabase } from "@qansa/db";
import { hashPassword } from "@qansa/core";
import { FixtureShopeeGateway } from "@qansa/shopee-adapter";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type ApiConfig } from "../src/env.js";

/**
 * An API instance backed by in-process PostgreSQL and the fixture Shopee
 * gateway: the same HTTP routes, the same SQL, no containers and no partner
 * credentials.
 */

export const PARTNER_KEY = "fixture-partner-key";
export const PUSH_URL = "https://api.qansa.web.id/webhook/shopee";

export interface ApiHarness {
  app: FastifyInstance;
  db: TestDatabase;
  config: ApiConfig;
  uploads: string;
  gateway: FixtureShopeeGateway;
  login: (email?: string, password?: string) => Promise<{ cookie: string; csrf: string }>;
  close: () => Promise<void>;
}

export async function apiHarness(): Promise<ApiHarness> {
  const db = await createTestDatabase();
  const uploads = await mkdtemp(join(tmpdir(), "qansa-api-uploads-"));

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused",
    APP_ENCRYPTION_KEY: "c".repeat(64),
    DOWNLOAD_SIGNING_SECRET: "d".repeat(40),
    SESSION_COOKIE_SECURE: "false",
    ADMIN_ORIGIN: "http://localhost:3000",
    CLAIM_ORIGIN: "http://localhost:3000",
    API_PUBLIC_ORIGIN: "http://localhost:4000",
    SHOPEE_GATEWAY_MODE: "fixture",
    SHOPEE_PARTNER_ID: "2000000",
    SHOPEE_PARTNER_KEY: PARTNER_KEY,
    SHOPEE_PUSH_URL: PUSH_URL,
    UPLOAD_DIR: uploads,
    LOG_LEVEL: "silent",
  });

  const { fixtureStores } = await import("@qansa/shopee-adapter");
  const gateway = new FixtureShopeeGateway(fixtureStores, { partnerId: 2000000 });
  const app = await buildApp({ config, db: db.db, gateway });
  await app.ready();

  await db.db.insert(schema.users).values({
    email: "owner@qansa.web.id",
    name: "Owner",
    role: "OWNER",
    passwordHash: await hashPassword("owner-password-2026"),
  });
  await db.db.insert(schema.users).values({
    email: "viewer@qansa.web.id",
    name: "Viewer",
    role: "VIEWER",
    passwordHash: await hashPassword("viewer-password-2026"),
  });

  const login = async (email = "owner@qansa.web.id", password = "owner-password-2026") => {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
    const cookies = response.cookies as Array<{ name: string; value: string }>;
    const session = cookies.find((cookie) => cookie.name === "qansa_session");
    const csrf = cookies.find((cookie) => cookie.name === "qansa_csrf");
    return { cookie: `qansa_session=${session?.value ?? ""}; qansa_csrf=${csrf?.value ?? ""}`, csrf: csrf?.value ?? "" };
  };

  return {
    app,
    db,
    config,
    uploads,
    gateway,
    login,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export function signPush(rawBody: string, key = PARTNER_KEY): string {
  return createHmac("sha256", key).update(PUSH_URL + rawBody).digest("hex");
}

export const pushBody = (orderSn: string, shopId = 771001) =>
  JSON.stringify({ code: 3, shop_id: shopId, timestamp: Math.floor(Date.now() / 1000), data: { ordersn: orderSn, status: "READY_TO_SHIP" } });
