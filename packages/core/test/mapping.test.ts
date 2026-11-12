import { describe, expect, it } from "vitest";
import { deliveredQuantity, resolveMapping, variationKnown, type MappingCandidate } from "../src/mapping.js";

const variationMapping = (id: string, variationId: string | null, multiplier = 1, isActive = true): MappingCandidate => ({
  id,
  shopeeVariationId: variationId,
  digitalProductId: `dp-${id}`,
  quantityMultiplier: multiplier,
  isActive,
});

describe("resolveMapping", () => {
  const variationIds: Record<number, string> = { 1001: "var-1001", 1002: "var-1002" };
  const lookup = (modelId: number) => variationIds[modelId];

  it("prefers the variation mapping over the listing mapping", () => {
    const outcome = resolveMapping(
      { itemId: 1, modelId: 1002, candidates: [variationMapping("listing", null), variationMapping("five", "var-1002", 5)] },
      lookup,
    );
    expect(outcome.status).toBe("MAPPED");
    if (outcome.status === "MAPPED") {
      expect(outcome.mapping.id).toBe("five");
      expect(outcome.quantityMultiplier).toBe(5);
    }
  });

  it("falls back to the listing mapping for an unmapped variation", () => {
    const outcome = resolveMapping({ itemId: 1, modelId: 1001, candidates: [variationMapping("listing", null)] }, lookup);
    expect(outcome.status).toBe("MAPPED");
  });

  it("reports UNMAPPED rather than delivering the wrong package", () => {
    const outcome = resolveMapping({ itemId: 1, modelId: 1002, candidates: [variationMapping("one", "var-1001")] }, lookup);
    expect(outcome).toEqual({ status: "UNMAPPED", reason: "NO_MAPPING" });
  });

  it("reports an ambiguous mapping instead of picking the first row", () => {
    const outcome = resolveMapping(
      { itemId: 1, modelId: 1001, candidates: [variationMapping("a", "var-1001"), variationMapping("b", "var-1001")] },
      lookup,
    );
    expect(outcome.status).toBe("AMBIGUOUS");
    if (outcome.status === "AMBIGUOUS") expect(outcome.candidateIds).toEqual(["a", "b"]);
  });

  it("distinguishes an inactive mapping from a missing one", () => {
    const outcome = resolveMapping({ itemId: 1, candidates: [variationMapping("off", null, 1, false)] }, lookup);
    expect(outcome).toEqual({ status: "UNMAPPED", reason: "INACTIVE_ONLY" });
  });

  it("knows when a variation id has not been synced yet", () => {
    expect(variationKnown(undefined, undefined)).toBe(true);
    expect(variationKnown(9999, lookup(9999))).toBe(false);
    expect(variationKnown(1001, lookup(1001))).toBe(true);
  });

  it("multiplies quantity but never returns zero units", () => {
    expect(deliveredQuantity(2, 3)).toBe(6);
    expect(deliveredQuantity(0, 3)).toBe(3);
    expect(deliveredQuantity(1, 0)).toBe(1);
    expect(deliveredQuantity(1.7, 2)).toBe(2);
  });
});
