/**
 * The cipher the e-Meterai dashboard uses for its own request bodies.
 *
 * Read out of the shipped bundle, not guessed: aes-256-cbc, key = sha256 of a
 * string baked into the frontend, IV either a fixed 16-byte string or random per
 * call, and the three base64 pieces (iv, key, ciphertext) interleaved in quarters
 * so the wire value looks like one opaque blob.
 *
 * This is the site's private protocol. It exists here so the operator's own account
 * can be used without a human clicking the dashboard, and it can change without
 * notice. Nothing in it is a secret: the key string ships in the JavaScript that
 * every visitor downloads.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomInt,
} from "node:crypto";

const ALGORITHM = "aes-256-cbc";
const KEY_SEED =
  "jediljclksejdwklfjklsjaflkjflkwajkqlwjdsakljflkjfkldasjflkafjdklsafjdklsajfaskljfkdslajfkdsaljfkdsa";
const FIXED_IV = "p3rUr13m3t3r41kv";
const IV_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-=/*:,.!?@#$%&";

/** sha256 of the seed, which is the 32-byte AES key. */
export function deriveKey(seed = KEY_SEED) {
  return createHash("sha256").update(seed).digest();
}

export function makeIv(random = false) {
  if (!random) return Buffer.from(FIXED_IV, "utf8");
  let iv = "";
  for (let i = 0; i < 16; i += 1)
    iv += IV_ALPHABET.charAt(randomInt(IV_ALPHABET.length));
  return Buffer.from(iv, "utf8");
}

/**
 * Encrypt a string or an object into the blob the API expects. The interleave is
 * the part that matters: four quarters, each iv + key + ciphertext.
 */
export function encrypt(payload, { randomIv = false, seed } = {}) {
  const plaintext =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const key = deriveKey(seed);
  const iv = makeIv(randomIv);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return interleave(iv, key, ciphertext);
}

/** Reverse of encrypt, used by the probe to read what the API answers. */
export function decrypt(blob) {
  const { iv, key, ciphertext } = deinterleave(blob);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  // The dashboard strips control characters the same way after decrypting.
  return plaintext.replace(/[^\w"{}:,.\-@/\]\\[=?+!#~`$%^&*()_|;'<> ]/g, "");
}

export function decryptToObject(blob) {
  const text = decrypt(blob.replace(/ /g, "+"));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function interleave(iv, key, ciphertext) {
  const ivB64 = iv.toString("base64");
  const keyB64 = key.toString("base64");
  const bodyB64 = ciphertext.toString("base64");
  let out = "";
  for (let quarter = 4; quarter >= 1; quarter -= 1) {
    out += sliceQuarter(ivB64, quarter);
    out += sliceQuarter(keyB64, quarter);
    out += sliceQuarter(bodyB64, quarter);
  }
  return out;
}

function deinterleave(blob) {
  let ivB64 = "";
  let keyB64 = "";
  let bodyB64 = "";
  for (let quarter = 4; quarter >= 1; quarter -= 1) {
    const offset = Math.ceil((blob.length * (quarter - 1)) / 4);
    ivB64 += blob.substr(offset, 6);
    keyB64 += blob.substr(offset + 6, 11);
    bodyB64 += blob.slice(
      offset + 6 + 11,
      Math.ceil((blob.length * quarter) / 4),
    );
  }
  return {
    iv: Buffer.from(ivB64, "base64"),
    ciphertext: Buffer.from(bodyB64, "base64"),
    key: Buffer.from(keyB64, "base64"),
  };
}

function sliceQuarter(value, quarter) {
  return value.slice(
    (value.length * (quarter - 1)) / 4,
    (value.length * quarter) / 4,
  );
}
