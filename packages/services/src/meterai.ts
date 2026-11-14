import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomInt,
} from "node:crypto";
import { AppError, decryptSecret, encryptSecret } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { notify } from "./notify.js";
import { loadSettings } from "./settings.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * e-Meterai is the one product that cannot be stocked: the shop mints a link per
 * buyer, and that link spends real balance. This module speaks the dashboard's own
 * protocol, read out of its bundle, and records every mint so a retry can never pay
 * twice.
 *
 * It is not a published partner API. When Peruri issues a reseller key, this module is
 * the only thing that needs replacing.
 */

const ALGORITHM = "aes-256-cbc";
const KEY_SEED =
  "jediljclksejdwklfjklsjaflkjflkwajkqlwjdsakljflkjfkldasjflkafjdklsafjdklsajfaskljfkdslajfkdsaljfkdsa";
const FIXED_IV = "p3rUr13m3t3r41kv";
const IV_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-=/*:,.!?@#$%&";
const DEFAULT_BASE = "https://e-meterai.co.id";

export interface MeteraiCredentials {
  user: string;
  password: string;
  baseUrl?: string;
}

/** The dashboard's body cipher: aes-256-cbc, sha256 seed key, iv/key/body interleaved. */
export function encryptMeteraiPayload(
  payload: unknown,
  options: { randomIv?: boolean } = {},
): string {
  const plaintext =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const key = createHash("sha256").update(KEY_SEED).digest();
  let iv = FIXED_IV;
  if (options.randomIv) {
    iv = "";
    for (let index = 0; index < 16; index += 1)
      iv += IV_ALPHABET.charAt(randomInt(IV_ALPHABET.length));
  }

  const cipher = createCipheriv(ALGORITHM, key, Buffer.from(iv, "utf8"));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const thirds = [
    Buffer.from(iv, "utf8").toString("base64"),
    key.toString("base64"),
    body.toString("base64"),
  ];
  let out = "";
  for (let quarter = 4; quarter >= 1; quarter -= 1) {
    for (const piece of thirds)
      out += piece.slice(
        (piece.length * (quarter - 1)) / 4,
        (piece.length * quarter) / 4,
      );
  }
  return out;
}

export function decryptMeteraiPayload(blob: string): unknown {
  let ivB64 = "";
  let keyB64 = "";
  let bodyB64 = "";
  for (let quarter = 4; quarter >= 1; quarter -= 1) {
    const offset = Math.ceil((blob.length * (quarter - 1)) / 4);
    ivB64 += blob.substr(offset, 6);
    keyB64 += blob.substr(offset + 6, 11);
    bodyB64 += blob.slice(offset + 17, Math.ceil((blob.length * quarter) / 4));
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    Buffer.from(keyB64, "base64"),
    Buffer.from(ivB64, "base64"),
  );
  const text = Buffer.concat([
    decipher.update(Buffer.from(bodyB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(
    text.replace(/[^\w"{}:,.\-@/\]\\[=?+!#~`$%^&*()_|;'<> ]/g, ""),
  );
}

const browserHeaders = (base: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/plain, */*",
  origin: base,
  referer: `${base}/`,
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

export async function loginMeterai(
  credentials: MeteraiCredentials,
  base = credentials.baseUrl ?? DEFAULT_BASE,
) {
  const response = await fetch(`${base}/api/users/login`, {
    method: "POST",
    headers: browserHeaders(base),
    body: JSON.stringify({
      data: encryptMeteraiPayload(
        { user: credentials.user, password: credentials.password },
        { randomIv: true },
      ),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    statusCode?: string;
    token?: string;
    message?: string;
  };
  if (body.statusCode !== "00" || !body.token) {
    throw new AppError(
      "METERAI_LOGIN_FAILED",
      `e-Meterai menolak login: ${body.message ?? response.status}`,
      502,
      {
        statusCode: body.statusCode ?? String(response.status),
      },
    );
  }
  return body.token;
}

export async function meteraiBalance(
  credentials: MeteraiCredentials,
  base = credentials.baseUrl ?? DEFAULT_BASE,
) {
  const token = await loginMeterai(credentials, base);
  const response = await fetch(`${base}/api/function/saldopos`, {
    method: "POST",
    headers: { ...browserHeaders(base), authorization: `Bearer ${token}` },
    body: "{}",
  });
  const body = (await response.json().catch(() => ({}))) as {
    result?: { saldo?: number; notstamp?: number };
  };
  return {
    saldo: body.result?.saldo ?? null,
    notStamped: body.result?.notstamp ?? null,
  };
}

/** Mint one buyer link. Each call spends `quantity` units of balance. */
export async function mintMeteraiLink(
  credentials: MeteraiCredentials,
  quantity: number,
  base = credentials.baseUrl ?? DEFAULT_BASE,
) {
  const token = await loginMeterai(credentials, base);
  const data = encodeURIComponent(
    encryptMeteraiPayload(
      { fullpath: true, qty: quantity, partial: false },
      { randomIv: true },
    ),
  );
  const response = await fetch(
    `${base}/api/v3/reseller/generate-link?data=${data}`,
    {
      headers: { ...browserHeaders(base), authorization: `Bearer ${token}` },
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    status?: string;
    message?: string;
    result?: { linkUrl?: string | string[]; message?: string };
  };

  // The supplier answers with one linkUrl entry per stamp; a single element is the
  // exception, not the norm. Everything is kept, in order.
  const rawLinks = Array.isArray(body.result?.linkUrl)
    ? body.result?.linkUrl
    : [body.result?.linkUrl].filter(Boolean);
  const urls = rawLinks.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (body.status !== "00" || urls.length === 0) {
    throw new AppError(
      "METERAI_MINT_FAILED",
      `e-Meterai gagal membuat tautan: ${body.message ?? response.status}`,
      502,
      {
        status: body.status ?? String(response.status),
      },
    );
  }
  return { urls, url: urls[0]!, quantity };
}

export interface RevealInput {
  fulfillmentId: string;
  actor: { id: string; email: string };
  ip?: string | null;
}

/**
 * What the supplier hands back.
 *
 * One `generate-link` call with `qty` returns an **array** of linkUrl entries, one per
 * stamp: five meterai means five links and five units of balance, not one link carrying
 * five. Reading only the first element loses the buyer's money, so the stored value is a
 * JSON array and every reader goes through these two helpers.
 */
export function decodeMintedLinks(encoded: string, keyHex: string): string[] {
  const plain = decryptSecret(encoded, keyHex);
  if (!plain.startsWith("{")) return [plain]; // rows written before arrays were stored
  const parsed = JSON.parse(plain) as { urls?: unknown };
  const urls = Array.isArray(parsed.urls)
    ? parsed.urls.filter((value): value is string => typeof value === "string")
    : [];
  return urls.length > 0 ? urls : [plain];
}

function encodeMintedLinks(urls: string[], keyHex: string): string {
  return encryptSecret(JSON.stringify({ urls }), keyHex);
}

/**
 * Hand the minted link back to an operator, for the case where the buyer lost it.
 *
 * Reading it is an event worth recording: the link is worth money and opens a specific
 * buyer's document, so every reveal leaves an audit row naming who looked.
 */
export async function revealMintedLink(
  deps: ServiceDeps,
  input: RevealInput,
): Promise<{ urls: string[]; url: string; mintedAt: string }> {
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

  if (!row) throw AppError.notFound("Fulfilment");
  const { fulfillment, product } = row;

  if (!product.meteraiEnabled)
    throw AppError.validation("Produk ini bukan produk e-Meterai.");
  if (!fulfillment.mintedSecretEnc || !fulfillment.mintedAt) {
    throw new AppError(
      "METERAI_LINK_MISSING",
      "Tautan e-Meterai untuk pesanan ini belum dibuat.",
      404,
    );
  }

  const urls = decodeMintedLinks(
    fulfillment.mintedSecretEnc,
    deps.config.appEncryptionKey,
  );

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: "meterai.reveal",
    targetType: "fulfillment",
    targetId: fulfillment.id,
    // The link itself is not metadata: it is the secret being revealed.
    metadata: { mintedAt: fulfillment.mintedAt.toISOString() },
    ip: input.ip ?? null,
  });

  return { urls, url: urls[0]!, mintedAt: fulfillment.mintedAt.toISOString() };
}

export interface MintInput {
  fulfillmentId: string;
  actor: { id: string; email: string; system?: boolean };
  ip?: string | null;
}

export interface MintResult {
  /** One link per stamp: quantity 5 means five links and five units of balance. */
  urls: string[];
  /** The first link, kept for callers that only need something clickable. */
  url: string;
  quantity: number;
  mintedAt: string;
  /** True when a link already existed for this fulfilment, so nothing was spent. */
  alreadyMinted: boolean;
}

/**
 * Mint the link for one fulfilment, once.
 *
 * Idempotent by column, not by hope: the second call returns the stored link and
 * spends nothing. A failure never retries on its own, because each attempt costs.
 */
export async function mintFulfillmentLink(
  deps: ServiceDeps,
  input: MintInput,
): Promise<MintResult> {
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

  if (!row) throw AppError.notFound("Fulfilment");
  const { fulfillment, product } = row;

  if (!product.meteraiEnabled) {
    throw AppError.validation("Produk ini bukan produk e-Meterai.");
  }
  if (fulfillment.status === "REVOKED") {
    throw new AppError(
      "ACCESS_REVOKED",
      "Akses produk ini sudah dicabut; tautan tidak dibuat.",
      409,
    );
  }

  if (fulfillment.mintedSecretEnc && fulfillment.mintedAt) {
    const stored = decodeMintedLinks(
      fulfillment.mintedSecretEnc,
      deps.config.appEncryptionKey,
    );
    return {
      urls: stored,
      url: stored[0]!,
      quantity: fulfillment.quantity,
      mintedAt: fulfillment.mintedAt.toISOString(),
      alreadyMinted: true,
    };
  }

  const settings = await loadSettings(deps);
  if (
    !settings.meterai.enabled ||
    !settings.meterai.user ||
    !settings.meterai.passwordEnc
  ) {
    throw new AppError(
      "METERAI_DISABLED",
      "Kredensial e-Meterai belum diatur di Pengaturan.",
      409,
    );
  }

  const credentials: MeteraiCredentials = {
    user: settings.meterai.user,
    password: decryptSecret(
      settings.meterai.passwordEnc,
      deps.config.appEncryptionKey,
    ),
    ...(settings.meterai.baseUrl ? { baseUrl: settings.meterai.baseUrl } : {}),
  };

  let minted: { urls: string[]; url: string; quantity: number };
  try {
    minted = await mintMeteraiLink(
      credentials,
      Math.max(1, fulfillment.quantity),
    );
  } catch (error) {
    // Money may or may not have moved; either way a retry loop is the wrong answer.
    await notify(deps, {
      type: "fulfillment.out_of_stock",
      title: `Tautan e-Meterai gagal dibuat untuk ${fulfillment.orderId}`,
      data: {
        fulfillmentId: fulfillment.id,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }

  // Balance is spent per link, so a short answer is the buyer's money going missing.
  // Keep what arrived, and make the gap loud instead of silent.
  if (minted.urls.length < minted.quantity) {
    await notify(deps, {
      type: "fulfillment.out_of_stock",
      title: `e-Meterai mengembalikan ${minted.urls.length} tautan untuk ${minted.quantity} meterai`,
      data: {
        fulfillmentId: fulfillment.id,
        links: minted.urls.length,
        quantity: minted.quantity,
      },
    });
  }

  const now = nowOf(deps);
  await deps.db
    .update(schema.fulfillments)
    .set({
      mintedSecretEnc: encodeMintedLinks(
        minted.urls,
        deps.config.appEncryptionKey,
      ),
      mintedAt: now,
      mintedBy: input.actor.email,
      updatedAt: now,
    })
    .where(eq(schema.fulfillments.id, fulfillment.id));

  await deps.db.insert(schema.orderEvents).values({
    orderId: fulfillment.orderId,
    type: "METERAI_LINK_MINTED",
    payload: {
      fulfillmentId: fulfillment.id,
      quantity: minted.quantity,
      links: minted.urls.length,
      by: input.actor.email,
    },
  });

  await recordAudit(deps, {
    actorType: input.actor.system ? "SYSTEM" : "ADMIN",
    actorId: input.actor.system ? null : input.actor.id,
    actorLabel: input.actor.email,
    action: "meterai.mint",
    targetType: "fulfillment",
    targetId: fulfillment.id,
    metadata: {
      quantity: minted.quantity,
      links: minted.urls.length,
      urlHost: new URL(minted.urls[0]!).host,
    },
    ip: input.ip ?? null,
  });

  return {
    urls: minted.urls,
    url: minted.urls[0]!,
    quantity: minted.quantity,
    mintedAt: now.toISOString(),
    alreadyMinted: false,
  };
}
