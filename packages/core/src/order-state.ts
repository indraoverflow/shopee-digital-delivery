/**
 * The order state machine. The pipeline may only move an order along these
 * edges; anything else throws, which keeps a late or duplicated Shopee push
 * from dragging a CLAIMED order back to VALIDATED and re-issuing access.
 */
export const ORDER_STATES = [
  "RECEIVED",
  "VALIDATED",
  "FULFILLED",
  "CLAIMED",
  "COMPLETED",
  "INELIGIBLE",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/** Terminal states: no further push may move an order out of them. */
export const TERMINAL_STATES: readonly OrderState[] = ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"];

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  // A push can arrive before payment settles or after it; INELIGIBLE is
  // recoverable because Shopee statuses move forward (UNPAID -> READY_TO_SHIP).
  RECEIVED: ["VALIDATED", "INELIGIBLE", "FAILED", "CANCELLED"],
  INELIGIBLE: ["VALIDATED", "CANCELLED", "EXPIRED", "FAILED"],
  VALIDATED: ["FULFILLED", "INELIGIBLE", "CANCELLED", "FAILED", "EXPIRED"],
  // FULFILLED means the claim link is live. A refund can still cancel it.
  FULFILLED: ["CLAIMED", "CANCELLED", "EXPIRED", "FAILED"],
  CLAIMED: ["COMPLETED", "CANCELLED", "FAILED"],
  // No edge out of a terminal state, not even to CANCELLED: revocation of a
  // completed delivery is a claim-level action, not an order-state rollback.
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`cannot move an order from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  if (from === to) return true; // idempotent re-delivery of the same push
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function nextStates(from: OrderState): readonly OrderState[] {
  return TRANSITIONS[from];
}

/**
 * The hops needed to reach `to`. A push often jumps two steps (an order is
 * first seen already paid), so the pipeline applies the intermediate states
 * rather than pretending RECEIVED can go straight to FULFILLED. An empty array
 * means the target is unreachable and the caller must keep the current state.
 */
export function planTransition(from: OrderState, to: OrderState): OrderState[] {
  if (from === to) return [];

  const seen = new Set<OrderState>([from]);
  const queue: OrderState[][] = [[from]];

  while (queue.length > 0) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    for (const next of TRANSITIONS[last]) {
      if (next === to) return [...path.slice(1), next];
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return [];
}

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** States whose digital products may be handed to a buyer. */
export function isClaimableState(state: OrderState): boolean {
  return state === "FULFILLED" || state === "CLAIMED" || state === "COMPLETED";
}
