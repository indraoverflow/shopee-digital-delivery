import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

/* ------------------------------------------------------------- passwords */

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
/** 128 * N * r bytes are needed for N=2^15, r=8: the 32 MiB default is too small. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { ...options, maxmem: SCRYPT_MAXMEM },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * scrypt from node:crypto: no native module to compile, and the parameters are
 * stored in the hash so they can be raised later without invalidating
 * existing passwords.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10)
    throw new Error("password must be at least 10 characters");
  const salt = randomBytes(16);
  const derived = await scrypt(
    password.normalize("NFKC"),
    salt,
    SCRYPT_KEYLEN,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p))
    return false;
  const salt = Buffer.from(saltRaw ?? "", "base64");
  const expected = Buffer.from(hashRaw ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(
    password.normalize("NFKC"),
    salt,
    expected.length,
    { N, r, p },
  );
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

/* --------------------------------------------------------------- digests */

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** URL-safe random token with the given entropy in bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------- secret storage */

const ENC_VERSION = "v1";

function keyBytes(keyHex: string): Buffer {
  const trimmed = keyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("APP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(trimmed, "hex");
}

/**
 * AES-256-GCM over Shopee tokens and activation codes. The AAD is the version
 * string, so a re-encrypted value cannot be swapped between columns silently.
 * Format: v1.<iv>.<tag>.<ciphertext>, all base64url.
 */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyHex), iv);
  cipher.setAAD(Buffer.from(ENC_VERSION));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENC_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(encoded: string, keyHex: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== ENC_VERSION)
    throw new Error("unrecognised secret format");
  const [, ivRaw, tagRaw, dataRaw] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes(keyHex),
    Buffer.from(ivRaw ?? "", "base64url"),
  );
  decipher.setAAD(Buffer.from(ENC_VERSION));
  decipher.setAuthTag(Buffer.from(tagRaw ?? "", "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw ?? "", "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Mask a secret for display: shows the tail only, which is enough to tell rows apart. */
export function maskSecret(secret: string, visible = 4): string {
  if (secret.length <= visible) return "*".repeat(secret.length);
  return `${"*".repeat(Math.min(8, secret.length - visible))}${secret.slice(-visible)}`;
}

/* -------------------------------------------------------- signed payloads */

export interface SignedPayload {
  [key: string]: unknown;
  /** Unix seconds. */
  exp: number;
}

/**
 * Compact signed token for expiring download links and claim access. It is not
 * a JWT on purpose: nothing outside this codebase reads it, so a smaller
 * format with an explicit HMAC is enough and cannot be confused with an
 * identity token.
 */
export function signPayload(secret: string, payload: SignedPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export type VerifyOutcome<T extends SignedPayload> =
  | { ok: true; payload: T }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

export function verifyPayload<T extends SignedPayload>(
  secret: string,
  token: string,
  now: Date = new Date(),
): VerifyOutcome<T> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };
  const [body, signature] = parts as [string, string];
  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  if (!constantTimeEquals(expected, signature))
    return { ok: false, reason: "BAD_SIGNATURE" };

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (typeof payload.exp !== "number")
    return { ok: false, reason: "MALFORMED" };
  if (payload.exp * 1000 <= now.getTime())
    return { ok: false, reason: "EXPIRED" };
  return { ok: true, payload };
}

/** Deterministic slug for a digital product name. */
export function slugify(value: string): string {
  // Trim the dashes by index instead of `^-+|-+$`: a leading and trailing quantifier
  // in one alternation is the shape static analysers flag, and walking the string is
  // both clearer and linear.
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = slug.length;
  while (start < end && slug.charCodeAt(start) === 45) start += 1;
  while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1;
  return slug.slice(start, end).slice(0, 60);
}
