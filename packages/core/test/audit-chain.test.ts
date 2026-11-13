import { describe, expect, it } from "vitest";
import {
  auditEntryHash,
  canonicalAuditEntry,
  verifyAuditChain,
  type AuditChainRow,
} from "../src/audit-chain.js";

const base = {
  action: "store.create",
  actorType: "ADMIN",
  actorLabel: "admin@qansa.web.id",
  targetType: "store",
  targetId: "store-1",
  metadata: { shopId: 771001, environment: "SANDBOX" },
  ip: "10.0.0.1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function chain(count: number): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let previous: string | null = null;

  for (let index = 1; index <= count; index += 1) {
    const entry = {
      ...base,
      seq: index,
      action: `action.${index}`,
      metadata: { index },
    };
    const entryHash = auditEntryHash(previous, entry);
    rows.push({ ...entry, prevHash: previous, entryHash });
    previous = entryHash;
  }
  return rows;
}

/** Builds a chain whose sequence numbers start at `startSeq`. */
function chainFrom(startSeq: number, count: number): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let previous: string | null = null;

  for (let index = 0; index < count; index += 1) {
    const seq = startSeq + index;
    const entry = { ...base, seq, action: `action.${seq}`, metadata: { seq } };
    const entryHash = auditEntryHash(previous, entry);
    rows.push({ ...entry, prevHash: previous, entryHash });
    previous = entryHash;
  }
  return rows;
}

describe("canonical form", () => {
  it("does not depend on the key order of metadata", () => {
    const left = canonicalAuditEntry({
      ...base,
      seq: 1,
      metadata: { a: 1, b: 2 },
    });
    const right = canonicalAuditEntry({
      ...base,
      seq: 1,
      metadata: { b: 2, a: 1 },
    });
    expect(left).toBe(right);
  });

  it("changes when any field changes", () => {
    const original = canonicalAuditEntry({ ...base, seq: 1 });
    expect(canonicalAuditEntry({ ...base, seq: 2 })).not.toBe(original);
    expect(
      canonicalAuditEntry({ ...base, seq: 1, action: "store.delete" }),
    ).not.toBe(original);
    expect(canonicalAuditEntry({ ...base, seq: 1, ip: "10.0.0.2" })).not.toBe(
      original,
    );
  });
});

describe("verifyAuditChain", () => {
  it("accepts an untouched chain", () => {
    const result = verifyAuditChain(chain(5));
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(5);
  });

  it("detects an edited row", () => {
    const rows = chain(4);
    rows[1]!.action = "store.disconnect";
    const result = verifyAuditChain(rows);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("detects a deleted row", () => {
    const rows = chain(4).filter((row) => row.seq !== 2);
    const result = verifyAuditChain(rows);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toContain("prev hash");
  });

  it("verifies by sequence, so array order is not itself tampering", () => {
    const rows = chain(3);
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(verifyAuditChain(shuffled).valid).toBe(true);
  });

  it("detects a rewritten sequence number", () => {
    const rows = chain(3);
    // An attacker moving the last entry earlier, hoping to hide the gap.
    rows[2]!.seq = 2;
    expect(verifyAuditChain(rows).valid).toBe(false);
  });

  it("treats an empty log as valid and reports zero rows", () => {
    expect(verifyAuditChain([])).toEqual({
      valid: true,
      checked: 0,
      unhashed: 0,
      brokenAt: null,
      reason: null,
    });
  });

  it("starts at the first hashed row when older rows predate the chain", () => {
    const legacy = [
      { ...base, seq: 1, entryHash: null, prevHash: null },
      { ...base, seq: 2, entryHash: null, prevHash: null },
    ];
    const hashed = chainFrom(3, 3);

    const result = verifyAuditChain([...legacy, ...hashed]);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.unhashed).toBe(2);
  });

  it("still detects a break after the unhashed prefix", () => {
    const legacy = [{ ...base, seq: 1, entryHash: null, prevHash: null }];
    const hashed = chainFrom(2, 3);
    hashed[1]!.action = "tampered";

    const result = verifyAuditChain([...legacy, ...hashed]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
  });
});
