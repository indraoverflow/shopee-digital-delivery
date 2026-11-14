/**
 * Buyer verification. The order number alone is not a secret: it appears in
 * Shopee emails, chat threads and screenshots, so a claim portal that accepts
 * only an order number hands the product to whoever saw that number.
 *
 * Two factors are available from the official Order API without asking the
 * buyer for anything they do not already own:
 *   - buyer_username, which only the buyer knows for their own order;
 *   - the recipient phone, which Shopee returns masked ("********1234"), so
 *     only its last digits can be compared.
 *
 * When Shopee returns no phone at all, the USERNAME_PHONE policy fails closed
 * rather than silently downgrading to one factor.
 */

export type VerificationPolicy =
  "USERNAME" | "USERNAME_PHONE" | "USERNAME_OR_PHONE" | "MANUAL";

export interface BuyerOrderFacts {
  buyerUsername?: string | null;
  /** Raw phone field from the order, possibly masked. */
  buyerPhoneMasked?: string | null;
}

export interface BuyerClaimInput {
  buyerUsername?: string | null;
  phoneSuffix?: string | null;
}

export type VerificationFailure =
  | "ORDER_NOT_FOUND"
  | "USERNAME_MISMATCH"
  | "USERNAME_MISSING"
  | "PHONE_SUFFIX_MISMATCH"
  | "PHONE_SUFFIX_INVALID"
  | "PHONE_UNAVAILABLE"
  | "ORDER_NOT_ELIGIBLE"
  | "ORDER_NOT_CLAIMABLE"
  | "TOO_MANY_ATTEMPTS";

export type VerificationResult =
  /** MANUAL is granted by the caller after an operator approved the order. */
  | { ok: true; method: "USERNAME" | "USERNAME_PHONE" | "MANUAL" }
  | { ok: false; reason: VerificationFailure };

const normaliseUsername = (value: string): string => value.trim().toLowerCase();
const digitsOf = (value: string): string => value.replace(/\D/g, "");

/**
 * Compares what the buyer typed with the masked phone on the order. Shopee
 * masks the prefix and keeps the tail, e.g. "********1234" or "******8899".
 * Only the visible digits are compared, and only when at least four of them
 * are visible: fewer would make a guess cheap.
 */
export function phoneSuffixMatches(
  maskedPhone: string,
  suffix: string,
): boolean {
  const visible = digitsOf(maskedPhone);
  const provided = digitsOf(suffix);
  if (provided.length < 4) return false;
  if (visible.length < 4) return false;
  return visible.endsWith(provided);
}

export function verifyBuyer(
  policy: VerificationPolicy,
  facts: BuyerOrderFacts,
  input: BuyerClaimInput,
): VerificationResult {
  if (policy === "MANUAL") {
    // Manual policies are approved by an operator; the portal never decides.
    return { ok: false, reason: "ORDER_NOT_CLAIMABLE" };
  }

  const expectedUsername = facts.buyerUsername
    ? normaliseUsername(facts.buyerUsername)
    : "";
  const providedUsername = input.buyerUsername
    ? normaliseUsername(input.buyerUsername)
    : "";

  /**
   * OR: either factor from the same order is enough. The order number is the secret;
   * the username and the phone are two things the buyer may or may not still have, and
   * someone who changed SIM cards should not lose a product they paid for. This branch
   * runs before the username checks, because a buyer may arrive with only the phone.
   */
  if (policy === "USERNAME_OR_PHONE") {
    const masked = facts.buyerPhoneMasked ?? "";
    const typedPhone = digitsOf(input.phoneSuffix ?? "");
    const phoneVisible = digitsOf(masked).length >= 4;

    if (
      providedUsername &&
      expectedUsername &&
      expectedUsername === providedUsername
    )
      return { ok: true, method: "USERNAME" };
    if (
      typedPhone.length >= 4 &&
      phoneVisible &&
      phoneSuffixMatches(masked, typedPhone)
    )
      return { ok: true, method: "USERNAME_PHONE" };
    if (!providedUsername && typedPhone.length < 4)
      return { ok: false, reason: "USERNAME_MISSING" };
    if (!phoneVisible && !expectedUsername)
      return { ok: false, reason: "PHONE_UNAVAILABLE" };
    return {
      ok: false,
      reason: providedUsername ? "USERNAME_MISMATCH" : "PHONE_SUFFIX_MISMATCH",
    };
  }

  if (!expectedUsername) return { ok: false, reason: "USERNAME_MISSING" };
  if (!providedUsername) return { ok: false, reason: "USERNAME_MISSING" };
  if (expectedUsername !== providedUsername)
    return { ok: false, reason: "USERNAME_MISMATCH" };

  if (policy === "USERNAME") return { ok: true, method: "USERNAME" };

  const maskedPhone = facts.buyerPhoneMasked ?? "";
  if (digitsOf(maskedPhone).length < 4)
    return { ok: false, reason: "PHONE_UNAVAILABLE" };

  const suffix = input.phoneSuffix ?? "";
  if (digitsOf(suffix).length < 4)
    return { ok: false, reason: "PHONE_SUFFIX_INVALID" };
  if (!phoneSuffixMatches(maskedPhone, suffix))
    return { ok: false, reason: "PHONE_SUFFIX_MISMATCH" };

  return { ok: true, method: "USERNAME_PHONE" };
}

/** Human-readable text for the portal; never leaks the expected value. */
export const FAILURE_MESSAGES: Record<VerificationFailure, string> = {
  ORDER_NOT_FOUND:
    "Nomor pesanan tidak ditemukan. Periksa kembali nomor pesanan Shopee Anda.",
  USERNAME_MISMATCH: "Username pembeli tidak cocok dengan pesanan ini.",
  USERNAME_MISSING: "Username pembeli wajib diisi.",
  PHONE_SUFFIX_MISMATCH:
    "4 digit terakhir nomor HP tidak cocok dengan pesanan ini.",
  PHONE_SUFFIX_INVALID:
    "Masukkan minimal 4 digit terakhir nomor HP yang dipakai saat membeli.",
  PHONE_UNAVAILABLE:
    "Pesanan ini tidak menyertakan nomor HP. Hubungi dukungan untuk verifikasi manual.",
  ORDER_NOT_ELIGIBLE:
    "Pesanan belum dibayar atau sudah dibatalkan, jadi produk digital belum bisa diklaim.",
  ORDER_NOT_CLAIMABLE:
    "Pesanan ini belum siap diklaim. Coba lagi beberapa saat setelah pembayaran dikonfirmasi.",
  TOO_MANY_ATTEMPTS:
    "Terlalu banyak percobaan. Tunggu beberapa menit sebelum mencoba lagi.",
};
