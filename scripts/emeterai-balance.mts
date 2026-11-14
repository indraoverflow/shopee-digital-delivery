/**
 * Read the e-Meterai balance with the credentials the app already stores in
 * system_settings.meterai. Read only: this never mints a link and never spends balance.
 *
 *   DATABASE_URL=... APP_ENCRYPTION_KEY=... npx tsx scripts/emeterai-balance.mts
 *
 * Against the compose stack, DATABASE_URL points at the published Postgres port
 * (127.0.0.1:55433 in this deployment), not the in-network `postgres:5432`.
 *
 * A null result means the dashboard answered without a readable body; login still had to
 * succeed for the call to get that far, so a failed login shows up as an error instead.
 */
import { createDatabase } from "../packages/db/src/index.js";
import { decryptSecret } from "../packages/core/src/index.js";
import {
  loadSettings,
  meteraiBalance,
} from "../packages/services/src/index.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const appEncryptionKey = process.env.APP_ENCRYPTION_KEY ?? "";
const handle = createDatabase(databaseUrl);
const settings = await loadSettings({
  db: handle.db,
  config: { appEncryptionKey },
} as never);

if (!settings.meterai.user || !settings.meterai.passwordEnc) {
  console.log(
    JSON.stringify({ ok: false, reason: "kredensial e-Meterai belum diatur" }),
  );
  process.exit(0);
}

const credentials = {
  user: settings.meterai.user,
  password: decryptSecret(
    settings.meterai.passwordEnc as string,
    appEncryptionKey,
  ),
  ...(settings.meterai.baseUrl ? { baseUrl: settings.meterai.baseUrl } : {}),
};

try {
  const balance = await meteraiBalance(credentials);
  console.log(JSON.stringify({ ok: true, user: credentials.user, balance }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      user: credentials.user,
      error: String((error as Error).message),
    }),
  );
}
await handle.close();
