import { createDatabase, runMigrations } from "@qansa/db";
import { seed } from "@qansa/db/seed";
import { loadConfig } from "./env.js";

/**
 * One-shot bootstrap: apply migrations, then create the owner account if it is
 * missing. Runs as its own container step so the API never races the schema and
 * never starts with a half-applied migration.
 */

const config = loadConfig();
const handle = createDatabase(config.databaseUrl, { max: 1 });

try {
  console.log("applying migrations");
  await runMigrations(handle);
  console.log("migrations applied");
} finally {
  await handle.close();
}

const adminEmail = process.env.ADMIN_EMAIL;
if (adminEmail) {
  const result = await seed({
    databaseUrl: config.databaseUrl,
    adminEmail,
    adminName: process.env.ADMIN_NAME ?? "Qansa Admin",
    ...(process.env.ADMIN_PASSWORD ? { adminPassword: process.env.ADMIN_PASSWORD } : {}),
  });
  console.log(`owner ${result.ownerEmail}: ${result.created ? "created" : "already present"}`);
  if (result.generatedPassword) {
    console.log(`generated password (shown once): ${result.generatedPassword}`);
  }
} else {
  console.log("ADMIN_EMAIL not set: skipping seed");
}
