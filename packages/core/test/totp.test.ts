import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  counterFor,
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  otpauthUrl,
  recoveryCodeHash,
  totpCode,
  verifyTotp,
} from "../src/totp.js";

/** RFC 6238 appendix B: the ASCII secret "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("base32", () => {
  it("matches the RFC 4648 vector", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
  });

  it("tolerates lower case, spaces and padding", () => {
    expect(base32Decode("mzxw 6ytb oi=====").toString()).toBe("foobar");
  });

  it("generates 160-bit secrets that decode back", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });
});

describe("totpCode", () => {
  it("reproduces the RFC 6238 SHA-1 vectors", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];

    for (const [epoch, expected] of vectors) {
      const counter = counterFor(new Date(epoch * 1000));
      expect(totpCode(RFC_SECRET, counter, { digits: 8 })).toBe(expected);
    }
  });

  it("gives six digits by default", () => {
    expect(totpCode(RFC_SECRET, 1)).toBe("287082");
  });
});

describe("verifyTotp", () => {
  const secret = RFC_SECRET;
  const at = (epoch: number) => new Date(epoch * 1000);

  it("accepts the current code", () => {
    const now = at(1111111111);
    expect(verifyTotp(secret, totpCode(secret, counterFor(now)), { now })).toBe(
      true,
    );
  });

  it("accepts one step of drift either way, and rejects two", () => {
    const now = at(1111111111);
    const previous = totpCode(secret, counterFor(now) - 1);
    const next = totpCode(secret, counterFor(now) + 1);
    const far = totpCode(secret, counterFor(now) + 3);

    expect(verifyTotp(secret, previous, { now })).toBe(true);
    expect(verifyTotp(secret, next, { now })).toBe(true);
    expect(verifyTotp(secret, far, { now })).toBe(false);
  });

  it("rejects a wrong code, a short code and a non-numeric code", () => {
    const now = at(1111111111);
    expect(verifyTotp(secret, "000000", { now })).toBe(now.getTime() < 0);
    expect(verifyTotp(secret, "12345", { now })).toBe(false);
    expect(verifyTotp(secret, "abcdef", { now })).toBe(false);
    expect(verifyTotp(secret, "", { now })).toBe(false);
  });

  it("rejects a secret too short to be real", () => {
    const now = at(1111111111);
    expect(verifyTotp("ABC", totpCode("ABC", counterFor(now)), { now })).toBe(
      false,
    );
  });

  it("tolerates spaces and dashes in what the user types", () => {
    const now = at(1111111111);
    const code = totpCode(secret, counterFor(now));
    expect(
      verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now }),
    ).toBe(true);
  });
});

describe("otpauthUrl", () => {
  it("encodes issuer, account and parameters", () => {
    const url = otpauthUrl({
      secret: "ABC234",
      account: "admin@qansa.web.id",
      issuer: "Qansa",
    });
    expect(url.startsWith("otpauth://totp/Qansa%3Aadmin%40qansa.web.id?")).toBe(
      true,
    );
    expect(url).toContain("secret=ABC234");
    expect(url).toContain("issuer=Qansa");
    expect(url).toContain("period=30");
  });
});

describe("recovery codes", () => {
  it("generates ten unique, readable codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(codes.join("")).not.toMatch(/[01OI]/);
  });

  it("hashes case and dash insensitively", () => {
    const code = "ABCD-2345";
    expect(recoveryCodeHash("abcd2345")).toBe(recoveryCodeHash(code));
    expect(normaliseRecoveryCode(" abcd-2345 ")).toBe("ABCD2345");
    expect(recoveryCodeHash(code)).not.toBe(recoveryCodeHash("ABCD-2346"));
  });
});
