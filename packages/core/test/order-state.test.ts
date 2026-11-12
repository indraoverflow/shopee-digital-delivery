import { describe, expect, it } from "vitest";
import { InvalidTransitionError, assertTransition, canTransition, isClaimableState, isTerminal } from "../src/order-state.js";

describe("order state machine", () => {
  it("moves a paid order along the happy path", () => {
    expect(canTransition("RECEIVED", "VALIDATED")).toBe(true);
    expect(canTransition("VALIDATED", "FULFILLED")).toBe(true);
    expect(canTransition("FULFILLED", "CLAIMED")).toBe(true);
    expect(canTransition("CLAIMED", "COMPLETED")).toBe(true);
  });

  it("refuses to rewind a claimed order when a late push arrives", () => {
    expect(canTransition("CLAIMED", "VALIDATED")).toBe(false);
    expect(canTransition("COMPLETED", "FULFILLED")).toBe(false);
    expect(() => assertTransition("CLAIMED", "VALIDATED")).toThrow(InvalidTransitionError);
  });

  it("treats a repeated push as idempotent", () => {
    expect(canTransition("VALIDATED", "VALIDATED")).toBe(true);
    expect(canTransition("CANCELLED", "CANCELLED")).toBe(true);
  });

  it("keeps every terminal state closed", () => {
    for (const state of ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"] as const) {
      expect(isTerminal(state)).toBe(true);
      for (const other of ["VALIDATED", "FULFILLED", "CLAIMED"] as const) {
        expect(canTransition(state, other)).toBe(false);
      }
    }
  });

  it("does not let an ineligible order deliver anything", () => {
    expect(isClaimableState("INELIGIBLE")).toBe(false);
    expect(isClaimableState("RECEIVED")).toBe(false);
    expect(isClaimableState("FULFILLED")).toBe(true);
  });
});
