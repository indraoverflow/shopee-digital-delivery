import { writeFile } from "node:fs/promises";
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
  ...(process.env.ADMIN_PASSWORD
    ? { adminPassword: process.env.ADMIN_PASSWORD }
    : {}),
});

console.log(
  `owner: ${result.ownerEmail} (${result.created ? "created" : "already exists"})`,
);
if (result.generatedPassword) {
  // A CLI printing it to a terminal that gets piped into a log is how passwords end up
  // in build archives. Write the file instead and print the path.
  const file = process.env.ADMIN_PASSWORD_FILE ?? "admin-password.txt";
  await writeFile(file, `${result.generatedPassword}\n`, { mode: 0o600 });
  console.log(
    `generated password written to ${file} (mode 600). Read it, then delete the file.`,
  );
}
