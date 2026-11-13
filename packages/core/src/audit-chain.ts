import { createHash } from "node:crypto";

/**
 * Tamper-evident audit trail. Every row covers the previous row's hash, so a
 * deleted row, an edited amount or a re-ordered timeline can be detected by
 * replaying the chain. It cannot prevent an attacker with database write access
 * from rewriting the whole chain, but it makes silent single-row edits visible,
 * which is the realistic threat for an operator covering their tracks.
 */

export interface AuditChainInput {
  seq: number;
  action: string;
  actorType: string;
  actorLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: Date | string;
}

/** Key order must not matter, so metadata is serialised with sorted keys. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function canonicalAuditEntry(entry: AuditChainInput): string {
  const createdAt =
    entry.createdAt instanceof Date
      ? entry.createdAt.toISOString()
      : new Date(entry.createdAt).toISOString();
  return JSON.stringify({
    seq: entry.seq,
    action: entry.action,
    actorType: entry.actorType,
    actorLabel: entry.actorLabel,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ? stableValue(entry.metadata) : null,
    ip: entry.ip,
    createdAt,
  });
}

export function auditEntryHash(
  previousHash: string | null,
  entry: AuditChainInput,
): string {
  return createHash("sha256")
    .update(`${previousHash ?? "genesis"}|${canonicalAuditEntry(entry)}`)
    .digest("hex");
}

export interface AuditChainRow extends AuditChainInput {
  entryHash: string | null;
  prevHash: string | null;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /**
   * Rows written before the chain existed. They carry no hash, so they cannot be
   * verified: the chain starts at the first hashed row, and pretending otherwise
   * would either fail forever or hide a real break.
   */
  unhashed: number;
  /** The first sequence number whose stored hash does not match the replay. */
  brokenAt: number | null;
  reason: string | null;
}

/** Replays the chain in sequence order and compares every stored hash. */
export function verifyAuditChain(
  rows: readonly AuditChainRow[],
): ChainVerification {
  let previous: string | null = null;
  let checked = 0;
  let unhashed = 0;

  for (const row of [...rows].sort((left, right) => left.seq - right.seq)) {
    if (row.entryHash === null) {
      unhashed += 1;
      continue;
    }

    const expected = auditEntryHash(previous, row);
    if (row.prevHash !== previous) {
      return {
        valid: false,
        checked,
        unhashed,
        brokenAt: row.seq,
        reason: "prev hash does not match the previous entry",
      };
    }
    if (row.entryHash !== expected) {
      return {
        valid: false,
        checked,
        unhashed,
        brokenAt: row.seq,
        reason: "entry hash does not match its content",
      };
    }
    previous = row.entryHash;
    checked += 1;
  }

  return { valid: true, checked, unhashed, brokenAt: null, reason: null };
}
