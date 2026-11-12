/**
 * Mapping resolution: which digital product does this Shopee line deliver?
 *
 * Precedence is deliberately explicit, because "closest match wins" logic with
 * silent fallbacks is how a buyer who paid for 10 licences receives 1.
 */

export interface MappingCandidate {
  id: string;
  /** Variation id, or null for a listing-level mapping. */
  shopeeVariationId: string | null;
  digitalProductId: string;
  quantityMultiplier: number;
  isActive: boolean;
}

export interface MappingQuery {
  itemId: number;
  modelId?: number | null;
  /** Candidates already scoped to this Shopee listing. */
  candidates: readonly MappingCandidate[];
}

export type MappingOutcome =
  | { status: "MAPPED"; mapping: MappingCandidate; quantityMultiplier: number }
  | { status: "UNMAPPED"; reason: "NO_MAPPING" | "INACTIVE_ONLY" }
  | { status: "AMBIGUOUS"; reason: "MULTIPLE_MATCHES"; candidateIds: string[] };

/**
 * A variation mapping always beats a listing-level mapping: the seller mapped
 * the variation on purpose. Two live candidates at the same level is a data
 * fault and must be reported, never resolved by picking the first row.
 */
export function resolveMapping(query: MappingQuery, variationIdOf: (modelId: number) => string | undefined = () => undefined): MappingOutcome {
  const active = query.candidates.filter((candidate) => candidate.isActive);
  if (active.length === 0) {
    return { status: "UNMAPPED", reason: query.candidates.length > 0 ? "INACTIVE_ONLY" : "NO_MAPPING" };
  }

  const variationId = query.modelId ? variationIdOf(query.modelId) : undefined;
  const variationMatches = variationId ? active.filter((candidate) => candidate.shopeeVariationId === variationId) : [];

  if (variationMatches.length > 1) {
    return { status: "AMBIGUOUS", reason: "MULTIPLE_MATCHES", candidateIds: variationMatches.map((c) => c.id) };
  }
  if (variationMatches.length === 1) {
    const mapping = variationMatches[0]!;
    return { status: "MAPPED", mapping, quantityMultiplier: mapping.quantityMultiplier };
  }

  // No variation-level mapping: a listing-level mapping covers every variation.
  const listingMatches = active.filter((candidate) => candidate.shopeeVariationId === null);
  if (listingMatches.length > 1) {
    return { status: "AMBIGUOUS", reason: "MULTIPLE_MATCHES", candidateIds: listingMatches.map((c) => c.id) };
  }
  if (listingMatches.length === 1) {
    const mapping = listingMatches[0]!;
    return { status: "MAPPED", mapping, quantityMultiplier: mapping.quantityMultiplier };
  }

  // Variations exist but only some are mapped, and the buyer picked another.
  return { status: "UNMAPPED", reason: "NO_MAPPING" };
}

/**
 * The mapping is only usable when the purchased variation is known. A line with
 * a model_id whose variation has never been synced cannot be resolved even
 * against a listing-level mapping, because the multiplier may differ per
 * variation.
 */
export function variationKnown(modelId: number | null | undefined, variationId: string | undefined): boolean {
  if (modelId === null || modelId === undefined) return true;
  return variationId !== undefined;
}

/** Units to deliver for one line. Never below the purchased quantity. */
export function deliveredQuantity(purchased: number, multiplier: number): number {
  const quantity = Number.isFinite(purchased) && purchased > 0 ? Math.floor(purchased) : 1;
  const factor = Number.isFinite(multiplier) && multiplier > 0 ? Math.floor(multiplier) : 1;
  return quantity * factor;
}
