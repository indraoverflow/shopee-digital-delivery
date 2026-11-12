import { seed } from "./seed.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const result = await seed({
  databaseUrl: url,
  adminEmail: process.env.ADMIN_EMAIL ?? "admin@qansa.web.id",
  adminName: process.env.ADMIN_NAME ?? "Qansa Admin",
  ...(process.env.ADMIN_PASSWORD ? { adminPassword: process.env.ADMIN_PASSWORD } : {}),
});

console.log(`owner: ${result.ownerEmail} (${result.created ? "created" : "already exists"})`);
if (result.generatedPassword) {
  console.log(`generated password (store it now, it is not recoverable): ${result.generatedPassword}`);
}
