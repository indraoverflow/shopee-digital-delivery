import { describe, expect, it } from "vitest";
import { DEFAULT_ELIGIBLE_STATUSES, evaluateEligibility, ineligibleTargetState } from "../src/eligibility.js";

describe("evaluateEligibility", () => {
  it("accepts a paid, shippable order", () => {
    expect(evaluateEligibility({ shopeeStatus: "READY_TO_SHIP" })).toEqual({ eligible: true, reason: "ELIGIBLE", revokes: false });
  });

  it("rejects an unpaid order and does not revoke a previous grant", () => {
    const result = evaluateEligibility({ shopeeStatus: "UNPAID" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("NOT_PAID");
    // Nothing to revoke, and the state must stay recoverable: the buyer may
    // still pay, and CANCELLED would be terminal.
    expect(result.revokes).toBe(false);
  });

  it("revokes access on cancellation and returns", () => {
    for (const status of ["CANCELLED", "IN_CANCEL", "TO_RETURN"]) {
      const result = evaluateEligibility({ shopeeStatus: status });
      expect(result.eligible).toBe(false);
      expect(result.revokes).toBe(true);
      expect(result.reason).toBe("CANCELLED");
    }
  });

  it("honours a per-store allow list", () => {
    const allowed = [...DEFAULT_ELIGIBLE_STATUSES, "TO_CONFIRM_RECEIVE"];
    expect(evaluateEligibility({ shopeeStatus: "TO_CONFIRM_RECEIVE", eligibleStatuses: allowed }).eligible).toBe(true);
    expect(evaluateEligibility({ shopeeStatus: "TO_CONFIRM_RECEIVE", eligibleStatuses: ["READY_TO_SHIP"] }).reason).toBe("NOT_IN_ALLOWED_LIST");
  });

  it("is case-insensitive and rejects an empty status instead of guessing", () => {
    expect(evaluateEligibility({ shopeeStatus: "ready_to_ship" }).eligible).toBe(true);
    expect(evaluateEligibility({ shopeeStatus: null }).reason).toBe("UNKNOWN_STATUS");
  });

  it("maps a revoke to CANCELLED and a plain rejection to INELIGIBLE", () => {
    expect(ineligibleTargetState(true)).toBe("CANCELLED");
    expect(ineligibleTargetState(false)).toBe("INELIGIBLE");
  });
});
