import { describe, expect, it } from "vitest";
import { phoneSuffixMatches, verifyBuyer } from "../src/claim.js";

const facts = {
  buyerUsername: "Rina_Kurnia",
  buyerPhoneMasked: "********2250",
};

describe("verifyBuyer", () => {
  it("accepts the buyer username, case and whitespace included", () => {
    expect(
      verifyBuyer("USERNAME", facts, { buyerUsername: "  rina_kurnia " }),
    ).toEqual({ ok: true, method: "USERNAME" });
  });

  it("rejects a wrong username", () => {
    expect(
      verifyBuyer("USERNAME", facts, { buyerUsername: "someone_else" }),
    ).toEqual({ ok: false, reason: "USERNAME_MISMATCH" });
  });

  it("requires the username even when a phone suffix matches", () => {
    expect(
      verifyBuyer("USERNAME_PHONE", facts, { phoneSuffix: "2250" }).ok,
    ).toBe(false);
  });

  it("accepts the last four digits of the masked phone", () => {
    expect(
      verifyBuyer("USERNAME_PHONE", facts, {
        buyerUsername: "rina_kurnia",
        phoneSuffix: "2250",
      }),
    ).toEqual({
      ok: true,
      method: "USERNAME_PHONE",
    });
  });

  it("rejects a phone suffix that does not match the order", () => {
    expect(
      verifyBuyer("USERNAME_PHONE", facts, {
        buyerUsername: "rina_kurnia",
        phoneSuffix: "9999",
      }),
    ).toEqual({
      ok: false,
      reason: "PHONE_SUFFIX_MISMATCH",
    });
  });

  it("fails closed when Shopee returned no phone for the policy that needs one", () => {
    expect(
      verifyBuyer(
        "USERNAME_PHONE",
        { buyerUsername: "rina_kurnia", buyerPhoneMasked: null },
        { buyerUsername: "rina_kurnia", phoneSuffix: "2250" },
      ),
    ).toEqual({
      ok: false,
      reason: "PHONE_UNAVAILABLE",
    });
  });

  it("rejects a phone suffix shorter than four digits", () => {
    expect(
      verifyBuyer("USERNAME_PHONE", facts, {
        buyerUsername: "rina_kurnia",
        phoneSuffix: "25",
      }),
    ).toEqual({
      ok: false,
      reason: "PHONE_SUFFIX_INVALID",
    });
  });

  it("never approves a MANUAL policy from the portal", () => {
    expect(
      verifyBuyer("MANUAL", facts, { buyerUsername: "rina_kurnia" }).ok,
    ).toBe(false);
  });
});

describe("USERNAME_OR_PHONE", () => {
  const facts = {
    buyerUsername: "rina_kurnia",
    buyerPhoneMasked: "********2250",
  };

  it("accepts the username alone, when the buyer forgot the old phone", () => {
    expect(
      verifyBuyer("USERNAME_OR_PHONE", facts, { buyerUsername: "rina_kurnia" }),
    ).toEqual({
      ok: true,
      method: "USERNAME",
    });
  });

  it("accepts the phone alone, when the buyer forgot the username", () => {
    expect(
      verifyBuyer("USERNAME_OR_PHONE", facts, { phoneSuffix: "2250" }),
    ).toEqual({
      ok: true,
      method: "USERNAME_PHONE",
    });
  });

  it("rejects when neither factor matches", () => {
    const result = verifyBuyer("USERNAME_OR_PHONE", facts, {
      buyerUsername: "orang_lain",
      phoneSuffix: "9999",
    });
    expect(result.ok).toBe(false);
  });

  it("asks for something when both fields are empty", () => {
    expect(verifyBuyer("USERNAME_OR_PHONE", facts, {})).toEqual({
      ok: false,
      reason: "USERNAME_MISSING",
    });
  });

  it("still accepts the username when Shopee sent no phone at all", () => {
    expect(
      verifyBuyer(
        "USERNAME_OR_PHONE",
        { buyerUsername: "rina_kurnia" },
        { buyerUsername: "rina_kurnia" },
      ),
    ).toEqual({ ok: true, method: "USERNAME" });
  });
});

describe("phoneSuffixMatches", () => {
  it("compares only the visible digits", () => {
    expect(phoneSuffixMatches("********2250", "2250")).toBe(true);
    expect(phoneSuffixMatches("+62******2250", "2250")).toBe(true);
    expect(phoneSuffixMatches("********2250", "2251")).toBe(false);
  });

  it("refuses a mask too short to be a real check", () => {
    expect(phoneSuffixMatches("******", "2250")).toBe(false);
  });
});
