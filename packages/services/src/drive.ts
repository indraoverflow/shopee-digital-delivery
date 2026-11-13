import { createHash } from "node:crypto";
import {
  AppError,
  decryptSecret,
  encryptSecret,
  signPayload,
  verifyPayload,
} from "@qansa/core";
import { schema } from "@qansa/db";
import { and, desc, eq } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { loadClaimSession } from "./claims.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Google Drive delivery: the shop keeps selling what it already sells, a Drive file, and
 * the platform shares that file with the buyer's Google account instead of sending a
 * link. A consumer @gmail.com account has no domain-wide delegation and no shared
 * drives, so sharing happens through a refresh token the shop owner consented to once.
 *
 * The address is typed by the buyer, because Shopee never sends the buyer's email. Two
 * things keep that honest: the form asks twice, and a mistake can be corrected for a
 * short window, which revokes the old permission instead of stacking a second one.
 */

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** How long a buyer may fix a mistyped address before the grant is locked. */
const fixWindowMinutes = (): number => {
  const raw = Number(process.env.DRIVE_ADDRESS_FIX_MINUTES ?? 15);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
};

const oauthBase = (): string =>
  process.env.GOOGLE_OAUTH_BASE ?? "https://oauth2.googleapis.com";
const driveBase = (): string =>
  process.env.GOOGLE_DRIVE_BASE ?? "https://www.googleapis.com";

export interface DriveApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Credentials come from the environment; without them the feature refuses, never guesses. */
export function driveAppFromEnv(): DriveApp | null {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = (process.env.GOOGLE_DRIVE_REDIRECT_URI ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

const stateSecret = (deps: ServiceDeps): string =>
  createHash("sha256")
    .update(`${deps.config.appEncryptionKey}:drive-state`)
    .digest("hex");

/** rina.kurnia@gmail.com -> r***@gmail.com, for screens a stranger might see. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value) && value.length <= 200;
}

/**
 * Accepts a Drive share link in the shapes Google hands out, or a bare file id. The
 * shop pastes what it already has; nobody should have to extract an id by hand.
 */
export function extractDriveFileId(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const byPath = /\/d\/([A-Za-z0-9_-]{10,})/.exec(trimmed);
  if (byPath?.[1]) return byPath[1];
  const byQuery = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(trimmed);
  if (byQuery?.[1]) return byQuery[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

export async function driveConnectUrl(
  deps: ServiceDeps,
  storeId: string,
): Promise<string> {
  const app = driveAppFromEnv();
  if (!app)
    throw AppError.validation(
      "Google Drive belum dikonfigurasi di server. Isi GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, dan GOOGLE_DRIVE_REDIRECT_URI.",
    );

  const state = signPayload(stateSecret(deps), {
    storeId,
    exp: Math.floor(nowOf(deps).getTime() / 1000) + 600,
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postForm(
  url: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

/** Finish the consent: exchange the code, learn which account it is, keep the token. */
export async function completeDriveConnect(
  deps: ServiceDeps,
  input: {
    code: string;
    state: string;
    actor?: { id: string; email: string } | null;
  },
): Promise<{ storeId: string; accountEmail: string }> {
  const app = driveAppFromEnv();
  if (!app)
    throw AppError.validation("Google Drive belum dikonfigurasi di server.");

  const verified = verifyPayload<{ storeId: string; exp: number }>(
    stateSecret(deps),
    input.state,
    nowOf(deps),
  );
  if (!verified.ok)
    throw AppError.validation(
      "Tautan persetujuan Google sudah kedaluwarsa. Ulangi.",
    );

  const response = await postForm(`${oauthBase()}/token`, {
    code: input.code,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    redirect_uri: app.redirectUri,
    grant_type: "authorization_code",
  });
  const token = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !token.refresh_token)
    throw new AppError(
      "DRIVE_CONSENT_FAILED",
      "Google tidak memberi izin yang cukup. Pastikan Anda mencentang akses Drive saat menyetujui.",
      502,
    );

  const profileResponse = await fetch(`${driveBase()}/oauth2/v2/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token ?? ""}` },
  });
  const profile = (await profileResponse.json().catch(() => ({}))) as {
    email?: string;
  };
  if (!profileResponse.ok || !profile.email)
    throw new AppError(
      "DRIVE_PROFILE_FAILED",
      "Tidak bisa membaca akun Google yang dihubungkan.",
      502,
    );

  const accountEmail = normalizeEmail(profile.email);
  const encrypted = encryptSecret(
    token.refresh_token,
    deps.config.appEncryptionKey,
  );

  const [existing] = await deps.db
    .select({ id: schema.driveCredentials.id })
    .from(schema.driveCredentials)
    .where(eq(schema.driveCredentials.storeId, verified.payload.storeId))
    .limit(1);

  if (existing) {
    await deps.db
      .update(schema.driveCredentials)
      .set({
        accountEmail,
        refreshTokenEnc: encrypted,
        scope: token.scope ?? DRIVE_SCOPE,
        status: "CONNECTED",
        lastError: null,
        connectedAt: nowOf(deps),
        updatedAt: nowOf(deps),
      })
      .where(eq(schema.driveCredentials.id, existing.id));
  } else {
    await deps.db.insert(schema.driveCredentials).values({
      storeId: verified.payload.storeId,
      accountEmail,
      refreshTokenEnc: encrypted,
      scope: token.scope ?? DRIVE_SCOPE,
      status: "CONNECTED",
    });
  }

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor?.id ?? null,
    actorLabel: input.actor?.email ?? accountEmail,
    action: "drive.connected",
    targetType: "store",
    targetId: verified.payload.storeId,
    // The address is useful; the token is not metadata, it is the credential.
    metadata: { accountEmail },
    ip: null,
  });

  return { storeId: verified.payload.storeId, accountEmail };
}

export async function driveStatus(
  deps: ServiceDeps,
  storeId: string,
): Promise<{
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  status: string | null;
  lastError: string | null;
  connectedAt: string | null;
}> {
  const [credential] = await deps.db
    .select()
    .from(schema.driveCredentials)
    .where(eq(schema.driveCredentials.storeId, storeId))
    .limit(1);

  return {
    configured: driveAppFromEnv() !== null,
    connected: Boolean(credential),
    accountEmail: credential?.accountEmail ?? null,
    status: credential?.status ?? null,
    lastError: credential?.lastError ?? null,
    connectedAt: credential?.connectedAt.toISOString() ?? null,
  };
}

export async function disconnectDrive(
  deps: ServiceDeps,
  input: { storeId: string; actor: { id: string; email: string } },
): Promise<void> {
  const [credential] = await deps.db
    .select()
    .from(schema.driveCredentials)
    .where(eq(schema.driveCredentials.storeId, input.storeId))
    .limit(1);
  if (!credential) return;

  // Tell Google to forget us as well, otherwise the grant survives in the owner's
  // account settings and nobody ever looks there again.
  try {
    const refreshToken = decryptSecret(
      credential.refreshTokenEnc,
      deps.config.appEncryptionKey,
    );
    await postForm(`${oauthBase()}/revoke`, { token: refreshToken });
  } catch {
    // A revoke that fails still removes our copy; the shop can revoke it in Google.
  }

  await deps.db
    .delete(schema.driveCredentials)
    .where(eq(schema.driveCredentials.id, credential.id));

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: "drive.disconnected",
    targetType: "store",
    targetId: input.storeId,
    metadata: { accountEmail: credential.accountEmail },
    ip: null,
  });
}

async function accessTokenFor(
  deps: ServiceDeps,
  storeId: string,
): Promise<string> {
  const [credential] = await deps.db
    .select()
    .from(schema.driveCredentials)
    .where(eq(schema.driveCredentials.storeId, storeId))
    .limit(1);
  if (!credential)
    throw new AppError(
      "DRIVE_DISCONNECTED",
      "Toko ini belum menghubungkan Google Drive. Hubungkan dulu di halaman toko.",
      409,
    );

  const app = driveAppFromEnv();
  if (!app)
    throw new AppError(
      "DRIVE_DISCONNECTED",
      "Google Drive belum dikonfigurasi di server.",
      409,
    );

  const refreshToken = decryptSecret(
    credential.refreshTokenEnc,
    deps.config.appEncryptionKey,
  );
  const response = await postForm(`${oauthBase()}/token`, {
    client_id: app.clientId,
    client_secret: app.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || !body.access_token) {
    await deps.db
      .update(schema.driveCredentials)
      .set({
        status: "ERROR",
        lastError:
          body.error_description ?? body.error ?? `HTTP ${response.status}`,
        updatedAt: nowOf(deps),
      })
      .where(eq(schema.driveCredentials.id, credential.id));

    throw new AppError(
      "DRIVE_TOKEN_INVALID",
      "Izin Google Drive toko ini sudah tidak berlaku. Hubungkan ulang di halaman toko.",
      409,
    );
  }

  return body.access_token;
}

interface PermissionBody {
  id?: string;
  error?: { message?: string; code?: number };
}

async function createPermission(
  token: string,
  fileId: string,
  email: string,
): Promise<{ permissionId: string } | { error: string }> {
  const url = `${driveBase()}/drive/v3/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=true&supportsAllDrives=true`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "user", role: "reader", emailAddress: email }),
  });
  const body = (await response.json().catch(() => ({}))) as PermissionBody;
  if (!response.ok || !body.id)
    return { error: body.error?.message ?? `HTTP ${response.status}` };
  return { permissionId: body.id };
}

async function deletePermission(
  token: string,
  fileId: string,
  permissionId: string,
): Promise<boolean> {
  const response = await fetch(
    `${driveBase()}/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
  );
  return response.ok || response.status === 404;
}

export interface GrantInput {
  token: string;
  fulfillmentId: string;
  email: string;
  emailConfirm: string;
  ip?: string | null;
}

export interface GrantResult {
  email: string;
  maskedEmail: string;
  already: boolean;
  /** When the buyer may still correct the address, null once locked. */
  fixUntil: string | null;
}

/**
 * Share the file with the address the buyer typed, on the store's Drive account.
 *
 * Idempotent in the way that matters: the same address twice returns the existing grant
 * instead of stacking permissions, and a different address inside the fix window revokes
 * the previous one first, so a typo never leaves a stranger holding the product.
 */
export async function grantDriveAccess(
  deps: ServiceDeps,
  input: GrantInput,
): Promise<GrantResult> {
  const email = normalizeEmail(input.email);
  const confirm = normalizeEmail(input.emailConfirm);

  if (!isEmail(email)) throw AppError.validation("Alamat Gmail tidak valid.");
  if (email !== confirm)
    throw AppError.validation(
      "Alamat Gmail dan ulangannya tidak sama. Periksa kembali.",
    );

  const session = await loadClaimSession(deps, input.token);
  if (!session)
    throw AppError.unauthorized(
      "Sesi klaim sudah berakhir. Verifikasi ulang pesanan Anda.",
    );

  const [row] = await deps.db
    .select({
      fulfillment: schema.fulfillments,
      product: schema.digitalProducts,
    })
    .from(schema.fulfillments)
    .innerJoin(
      schema.digitalProducts,
      eq(schema.digitalProducts.id, schema.fulfillments.digitalProductId),
    )
    .where(eq(schema.fulfillments.id, input.fulfillmentId))
    .limit(1);

  if (!row || row.fulfillment.orderId !== session.order.id)
    throw AppError.notFound("Produk pada pesanan ini");

  const { fulfillment, product } = row;
  if (fulfillment.status === "REVOKED")
    throw new AppError(
      "ACCESS_REVOKED",
      "Akses produk ini sudah dicabut. Hubungi dukungan.",
      403,
    );
  if (fulfillment.status === "EXPIRED")
    throw new AppError(
      "CLAIM_EXPIRED",
      "Masa klaim produk ini sudah berakhir.",
      403,
    );
  if (product.deliveryKind !== "DRIVE")
    throw AppError.validation("Produk ini bukan produk Google Drive.");

  const fileId = extractDriveFileId(product.externalUrl);
  if (!fileId)
    throw AppError.validation(
      "Tautan file Drive belum diisi dengan benar pada produk ini.",
    );

  // The claim row is the audit anchor for the delivery. This product is delivered by the
  // address form, not by opening a file, so the grant creates it when it is not there yet.
  const [found] = await deps.db
    .select()
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.fulfillmentId, fulfillment.id),
        eq(schema.claims.orderId, session.order.id),
      ),
    )
    .orderBy(desc(schema.claims.createdAt))
    .limit(1);

  let claim = found;
  if (claim && claim.deliveriesUsed >= product.maxDeliveries)
    throw new AppError(
      "DELIVERY_LIMIT",
      "Batas jumlah pengambilan produk ini sudah tercapai. Hubungi dukungan.",
      429,
    );

  if (!claim) {
    const nowForClaim = nowOf(deps);
    const [createdClaim] = await deps.db
      .insert(schema.claims)
      .values({
        fulfillmentId: fulfillment.id,
        orderId: session.order.id,
        digitalProductId: product.id,
        claimSessionId: session.session.id,
        status: "COMPLETED",
        verificationMethod: session.session.method,
        deliveriesUsed: 0,
        ip: input.ip ?? null,
        completedAt: nowForClaim,
        expiresAt:
          fulfillment.claimDeadline ??
          new Date(nowForClaim.getTime() + 30 * 24 * 3600 * 1000),
      })
      .returning();
    claim = createdClaim!;
  }

  const [existing] = await deps.db
    .select()
    .from(schema.driveGrants)
    .where(eq(schema.driveGrants.fulfillmentId, fulfillment.id))
    .orderBy(desc(schema.driveGrants.createdAt))
    .limit(1);

  const now = nowOf(deps);
  let correctedFrom: string | null = null;

  if (existing?.status === "GRANTED" && existing.email === email) {
    const fixUntil = new Date(
      existing.grantedAt!.getTime() + fixWindowMinutes() * 60_000,
    );
    return {
      email,
      maskedEmail: maskEmail(email),
      already: true,
      fixUntil: fixUntil > now ? fixUntil.toISOString() : null,
    };
  }

  if (existing?.status === "GRANTED" && existing.email !== email) {
    const grantedAt = existing.grantedAt ?? existing.createdAt;
    const fixUntil = new Date(
      grantedAt.getTime() + fixWindowMinutes() * 60_000,
    );
    if (fixUntil <= now)
      throw new AppError(
        "ADDRESS_LOCKED",
        `Alamat ${maskEmail(existing.email)} sudah dikunci. Hubungi dukungan untuk mengubahnya.`,
        409,
      );

    // Correcting a typo: take the file back from the wrong address first.
    const oldToken = await accessTokenFor(deps, fulfillment.storeId);
    if (existing.permissionId) {
      const revoked = await deletePermission(
        oldToken,
        existing.fileId,
        existing.permissionId,
      );
      if (!revoked)
        throw new AppError(
          "DRIVE_REVOKE_FAILED",
          "Alamat lama belum bisa dicabut dari Drive, jadi alamat baru belum dibagikan. Coba lagi.",
          502,
        );
    }
    await deps.db
      .update(schema.driveGrants)
      .set({ status: "REVOKED", revokedAt: now, updatedAt: now })
      .where(eq(schema.driveGrants.id, existing.id));
    correctedFrom = existing.email;
  }

  const [grant] = await deps.db
    .insert(schema.driveGrants)
    .values({
      storeId: fulfillment.storeId,
      fulfillmentId: fulfillment.id,
      claimId: claim.id,
      email,
      fileId,
      correctedFrom,
      status: "PENDING",
    })
    .returning();

  const accessToken = await accessTokenFor(deps, fulfillment.storeId);
  const created = await createPermission(accessToken, fileId, email);

  if ("error" in created) {
    await deps.db
      .update(schema.driveGrants)
      .set({ status: "FAILED", lastError: created.error, updatedAt: now })
      .where(eq(schema.driveGrants.id, grant!.id));

    throw new AppError(
      "DRIVE_SHARE_FAILED",
      "Google Drive belum bisa membagikan file ini. Coba sebentar lagi atau hubungi dukungan.",
      502,
    );
  }

  await deps.db
    .update(schema.driveGrants)
    .set({
      status: "GRANTED",
      permissionId: created.permissionId,
      grantedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(schema.driveGrants.id, grant!.id));

  if (fulfillment.status === "CLAIMABLE") {
    await deps.db
      .update(schema.fulfillments)
      .set({ status: "CLAIMED", updatedAt: now })
      .where(eq(schema.fulfillments.id, fulfillment.id));
  }

  await deps.db
    .update(schema.claims)
    .set({ deliveriesUsed: claim.deliveriesUsed + 1, updatedAt: now })
    .where(eq(schema.claims.id, claim.id));

  await deps.db.insert(schema.deliveryLogs).values({
    claimId: claim.id,
    fulfillmentId: fulfillment.id,
    digitalProductId: product.id,
    kind: "DRIVE",
    // The address is the reference: it is what the buyer needs to see and correct.
    reference: maskEmail(email),
    ip: input.ip ?? null,
  });

  await deps.db.insert(schema.orderEvents).values({
    orderId: session.order.id,
    type: "DRIVE_SHARED",
    payload: {
      fulfillmentId: fulfillment.id,
      email: maskEmail(email),
      corrected: correctedFrom !== null,
    },
  });

  await recordAudit(deps, {
    actorType: "BUYER",
    actorId: null,
    actorLabel: maskEmail(email),
    action: "drive.grant",
    targetType: "fulfillment",
    targetId: fulfillment.id,
    metadata: {
      email: maskEmail(email),
      fileId,
      correctedFrom: correctedFrom ? maskEmail(correctedFrom) : null,
    },
    ip: input.ip ?? null,
  });

  const fixUntil = new Date(now.getTime() + fixWindowMinutes() * 60_000);
  return {
    email,
    maskedEmail: maskEmail(email),
    already: false,
    fixUntil: fixUntil.toISOString(),
  };
}

/** Operator-initiated share, for a buyer who wrote in because the flow failed. */
export async function retryDriveGrant(
  deps: ServiceDeps,
  input: { grantId: string; actor: { id: string; email: string } },
): Promise<{ status: string }> {
  const [grant] = await deps.db
    .select()
    .from(schema.driveGrants)
    .where(eq(schema.driveGrants.id, input.grantId))
    .limit(1);
  if (!grant) throw AppError.notFound("Pembagian Drive");

  const accessToken = await accessTokenFor(deps, grant.storeId);
  const created = await createPermission(
    accessToken,
    grant.fileId,
    grant.email,
  );
  const now = nowOf(deps);

  if ("error" in created) {
    await deps.db
      .update(schema.driveGrants)
      .set({ status: "FAILED", lastError: created.error, updatedAt: now })
      .where(eq(schema.driveGrants.id, grant.id));
    throw new AppError(
      "DRIVE_SHARE_FAILED",
      `Drive menolak: ${created.error}`,
      502,
    );
  }

  await deps.db
    .update(schema.driveGrants)
    .set({
      status: "GRANTED",
      permissionId: created.permissionId,
      grantedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(schema.driveGrants.id, grant.id));

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: "drive.retry",
    targetType: "drive_grant",
    targetId: grant.id,
    metadata: { email: maskEmail(grant.email), fileId: grant.fileId },
    ip: null,
  });

  return { status: "GRANTED" };
}

/** Failed shares, so monitoring can say how many buyers are waiting on Drive. */
export async function failedDriveGrants(
  deps: ServiceDeps,
  options: { limit?: number } = {},
): Promise<
  Array<{
    id: string;
    email: string;
    fileId: string;
    lastError: string | null;
    createdAt: string;
  }>
> {
  const rows = await deps.db
    .select()
    .from(schema.driveGrants)
    .where(eq(schema.driveGrants.status, "FAILED"))
    .orderBy(desc(schema.driveGrants.createdAt))
    .limit(options.limit ?? 20);

  return rows.map((row) => ({
    id: row.id,
    email: maskEmail(row.email),
    fileId: row.fileId,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  }));
}
