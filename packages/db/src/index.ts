import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * One executor type for both drivers. `PgDatabase` is the base class the
 * postgres-js and pglite builders both extend, so services take a `Database`
 * and work unchanged against a real server or the in-process pglite build used
 * by the integration tests.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export { schema };
export * from "./schema.js";

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => undefined,
  });
  const db = drizzlePg(client, { schema }) as unknown as Database;
  return {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

/**
 * Where drizzle-kit wrote the SQL migrations. The bundled apps lose the
 * package-relative path, so the candidates cover: an explicit override (the
 * container), the repository root, and the package location in a dev checkout.
 */
export function migrationsDir(): string {
  const override = process.env.MIGRATIONS_DIR;
  if (override) return override;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "drizzle"),
    join(process.cwd(), "packages", "db", "drizzle"),
    join(process.cwd(), "drizzle"),
    join(here, "..", "..", "packages", "db", "drizzle"),
  ];

  const found = candidates.find((candidate) => existsSync(join(candidate, "meta", "_journal.json")));
  return found ?? candidates[0]!;
}

export async function runMigrations(handle: DatabaseHandle): Promise<void> {
  // postgres-js keeps its own client on the drizzle instance, so the migrator
  // reaches it through the same object.
  await migratePg(handle.db as never, { migrationsFolder: migrationsDir() });
}

export interface TestDatabase {
  db: Database;
  close: () => Promise<void>;
  /** Raw SQL escape hatch for assertions that do not belong in a repository. */
  query: (sql: string) => Promise<unknown[]>;
}

/**
 * In-process PostgreSQL (pglite) with the real migrations applied. Tests get
 * the actual DDL, constraints and indexes without a docker daemon, and a fresh
 * database per test file because it lives in memory.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = new PGlite();
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  await migratePglite(db as never, { migrationsFolder: migrationsDir() });

  return {
    db,
    close: async () => {
      await client.close();
    },
    query: async (statement: string) => {
      const result = await client.query(statement);
      return result.rows as unknown[];
    },
  };
}
