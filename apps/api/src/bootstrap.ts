import { writeFile } from "node:fs/promises";
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
    ...(process.env.ADMIN_PASSWORD
      ? { adminPassword: process.env.ADMIN_PASSWORD }
      : {}),
  });
  console.log(
    `owner ${result.ownerEmail}: ${result.created ? "created" : "already present"}`,
  );
  if (result.generatedPassword) {
    // Never into container logs: a log shipper turns it into a permanent secret leak.
    // Write it with 0600 and say where, so the operator can read it once and delete it.
    const file =
      process.env.ADMIN_PASSWORD_FILE ?? "/tmp/qansa-admin-password.txt";
    await writeFile(file, `${result.generatedPassword}\n`, { mode: 0o600 });
    console.log(
      `generated password written to ${file} (mode 600). Read it, then delete the file.`,
    );
  }
} else {
  console.log("ADMIN_EMAIL not set: skipping seed");
}
