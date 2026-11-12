import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, maskSecret, sha256Hex, signPayload, slugify, verifyPassword, verifyPayload } from "../src/crypto.js";

const key = "a".repeat(64);

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password here", hash)).toBe(false);
  });

  it("refuses a short password instead of storing a weak one", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 10/);
  });

  it("rejects a mangled hash without throwing", async () => {
    expect(await verifyPassword("whatever", "not-a-hash")).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const encrypted = encryptSecret("access-token-value", key);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(encrypted).not.toContain("access-token-value");
    expect(decryptSecret(encrypted, key)).toBe("access-token-value");
  });

  it("fails to decrypt with another key instead of returning garbage", () => {
    const encrypted = encryptSecret("activation-code", key);
    expect(() => decryptSecret(encrypted, "b".repeat(64))).toThrow();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptSecret("x", "tooshort")).toThrow(/64 hex/);
  });

  it("masks a secret but keeps the tail readable", () => {
    expect(maskSecret("ABCD-EFGH-1234")).toMatch(/\*+1234$/);
  });
});

describe("signed payloads", () => {
  it("accepts a payload it signed and rejects tampering", () => {
    const token = signPayload("secret", { fulfillment: "f1", exp: Math.floor(Date.now() / 1000) + 60 });
    const ok = verifyPayload<{ fulfillment: string; exp: number }>("secret", token);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payload.fulfillment).toBe("f1");

    const [body] = token.split(".");
    expect(verifyPayload("secret", `${body}.deadbeef`)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyPayload("other-secret", token)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("expires a link on time", () => {
    const token = signPayload("secret", { fulfillment: "f1", exp: 1_000 });
    expect(verifyPayload("secret", token, new Date(1_000_000))).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("rejects a malformed token", () => {
    expect(verifyPayload("secret", "nodot")).toEqual({ ok: false, reason: "MALFORMED" });
  });
});

describe("helpers", () => {
  it("hashes deterministically for the webhook dedupe key", () => {
    expect(sha256Hex("body")).toBe(sha256Hex("body"));
    expect(sha256Hex("body")).not.toBe(sha256Hex("body "));
  });

  it("slugs a product name", () => {
    expect(slugify("E-Meterai 10.000 — Resmi!")).toBe("e-meterai-10-000-resmi");
  });
});
