/**
 * Order eligibility. A digital product is handed over only for a status Shopee
 * itself treats as paid; UNPAID is the only status that is definitely
 * unprofitable, but a cancelled or returned order must not deliver either.
 */

export const SHOPEE_ORDER_STATUSES = [
  "UNPAID",
  "READY_TO_SHIP",
  "PROCESSED",
  "RETRY_SHIP",
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "IN_CANCEL",
  "CANCELLED",
  "TO_RETURN",
  "COMPLETED",
] as const;

export type ShopeeOrderStatus = (typeof SHOPEE_ORDER_STATUSES)[number];

/** The documented default for a digital listing: paid, not cancelled. */
export const DEFAULT_ELIGIBLE_STATUSES: readonly string[] = [
  "READY_TO_SHIP",
  "PROCESSED",
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "COMPLETED",
];

/**
 * Statuses that revoke access, whatever else is configured. UNPAID is not one
 * of them: an unpaid order was never deliverable, and treating it as cancelled
 * would also make it terminal, so a buyer who pays a minute later could never
 * be served.
 */
export const REVOKING_STATUSES: readonly string[] = ["CANCELLED", "IN_CANCEL", "TO_RETURN"];

export type EligibilityReason =
  | "ELIGIBLE"
  | "UNKNOWN_STATUS"
  | "CANCELLED"
  | "NOT_PAID"
  | "NOT_IN_ALLOWED_LIST";

export interface EligibilityInput {
  shopeeStatus?: string | null;
  /** Per-store override; falls back to DEFAULT_ELIGIBLE_STATUSES. */
  eligibleStatuses?: readonly string[];
}

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** True when access that already exists must be revoked. */
  revokes: boolean;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const status = (input.shopeeStatus ?? "").toUpperCase();
  const allowed = (input.eligibleStatuses ?? DEFAULT_ELIGIBLE_STATUSES).map((value) => value.toUpperCase());

  if (status === "") {
    return { eligible: false, reason: "UNKNOWN_STATUS", revokes: false };
  }
  if (status === "UNPAID") {
    return { eligible: false, reason: "NOT_PAID", revokes: false };
  }
  if (REVOKING_STATUSES.includes(status)) {
    return { eligible: false, reason: "CANCELLED", revokes: true };
  }
  if (allowed.includes(status)) {
    return { eligible: true, reason: "ELIGIBLE", revokes: false };
  }
  return { eligible: false, reason: "NOT_IN_ALLOWED_LIST", revokes: false };
}

/** Order states after a non-eligible evaluation, given the current state. */
export function ineligibleTargetState(revokes: boolean): "CANCELLED" | "INELIGIBLE" {
  return revokes ? "CANCELLED" : "INELIGIBLE";
}
