import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) with SHA-1, six digits, 30-second steps: what every
 * authenticator app supports. Implemented here rather than pulled in, because
 * the whole algorithm is forty lines and a dependency would be one more supply
 * chain to audit for the second factor of the console.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20 random bytes (160 bits), the size authenticator apps recommend. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export interface TotpOptions {
  digits?: number;
  stepSeconds?: number;
}

/** The code for one counter value, unpadded. */
export function totpCode(
  secret: string,
  counter: number,
  options: TotpOptions = {},
): string {
  const digits = options.digits ?? 6;
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);

  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function counterFor(date: Date, stepSeconds = 30): number {
  return Math.floor(date.getTime() / 1000 / stepSeconds);
}

/**
 * Accepts the current step and `window` steps either side, which absorbs a
 * clock that is a few seconds off without widening the guessing surface to
 * anything meaningful.
 */
export function verifyTotp(
  secret: string,
  token: string,
  options: TotpOptions & { now?: Date; window?: number } = {},
): boolean {
  const digits = options.digits ?? 6;
  const stepSeconds = options.stepSeconds ?? 30;
  const window = options.window ?? 1;
  const candidate = (token ?? "").replace(/\s|-/g, "");

  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return false;
  if (base32Decode(secret).length < 10) return false;

  const counter = counterFor(options.now ?? new Date(), stepSeconds);
  const provided = Buffer.from(candidate, "utf8");

  for (let offset = -window; offset <= window; offset += 1) {
    const expected = Buffer.from(
      totpCode(secret, counter + offset, { digits, stepSeconds }),
      "utf8",
    );
    if (
      expected.length === provided.length &&
      timingSafeEqual(expected, provided)
    )
      return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app reads from a QR code or manual entry. */
export function otpauthUrl(input: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------- recovery codes */

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Ten single-use codes, shown once. Ambiguous characters (0/O, 1/I) are left
 * out so a code read over the phone still works.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = Array.from(
      randomBytes(8),
      (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length],
    ).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
}

/** Normalised so a buyer typing lower case or without the dash still matches. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export function recoveryCodeHash(code: string): string {
  return createHmac("sha256", "qansa-recovery-code")
    .update(normaliseRecoveryCode(code))
    .digest("hex");
}
