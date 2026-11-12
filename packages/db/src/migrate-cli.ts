import { createDatabase, migrationsDir, runMigrations } from "./index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const handle = createDatabase(url, { max: 1 });
try {
  console.log(`applying migrations from ${migrationsDir()}`);
  await runMigrations(handle);
  console.log("migrations applied");
} catch (error) {
  console.error("migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await handle.close();
}
