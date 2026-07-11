/**
 * Phase 7D — pure artwork-versioning + backup/restore-safety logic (R4-OPS-02).
 * No R2/B2/DB. The ledger insert, R2/B2 I/O, approve-site rewiring, and the B2
 * sibling worker are Category C/D; this locks the safety brain they use.
 */
import { describe, it, expect } from "vitest";
import {
  buildApprovedRevisionKey,
  sha256Hex,
  verifyIntegrity,
  assertVqBackupKey,
  assertVqRestoreTarget,
  selectActiveRevision,
  planPointerSwap,
  type RevisionRow,
} from "../server/vault-quest/lib/vq-artwork-versioning";

describe("buildApprovedRevisionKey — immutable versioned keys", () => {
  it("builds character + card revision keys", () => {
    expect(buildApprovedRevisionKey("character", "GNV-F01-S1", "master_portrait", 7)).toBe("vq/characters/GNV-F01-S1/approved/master_portrait/7.png");
    expect(buildApprovedRevisionKey("card", "GNV-014", "main", "abc")).toBe("vq/art/GNV-014/main/abc.png");
  });
  it("sanitises a hostile id / slot (no traversal survives)", () => {
    const k = buildApprovedRevisionKey("character", "../../x", "..", 1);
    expect(k).toBe("vq/characters/____x/approved/_/1.png");
    expect(k.includes("..")).toBe(false);
  });
});

describe("integrity", () => {
  const buf = Buffer.from("hello vault quest");
  const sha = sha256Hex(buf);
  it("passes when hash and size match", () => {
    expect(verifyIntegrity(buf, { sha256: sha, byteSize: buf.length })).toMatchObject({ ok: true });
  });
  it("fails on hash mismatch", () => {
    expect(verifyIntegrity(buf, { sha256: sha256Hex(Buffer.from("other")), byteSize: buf.length }).ok).toBe(false);
  });
  it("fails on size mismatch", () => {
    expect(verifyIntegrity(buf, { sha256: sha, byteSize: 999 }).ok).toBe(false);
  });
  it("tolerates absent size (hash-only verify)", () => {
    expect(verifyIntegrity(buf, { sha256: sha }).ok).toBe(true);
  });
});

describe("assertVqBackupKey — approved art only, never grading/candidates", () => {
  it("accepts approved character art and card art", () => {
    expect(assertVqBackupKey("vq/characters/GNV-F01-S1/approved/master_portrait/7.png")).toContain("approved");
    expect(assertVqBackupKey("vq/art/GNV-014/main/1.png")).toContain("vq/art/");
  });
  it("rejects candidates, grading prefixes, and traversal", () => {
    expect(() => assertVqBackupKey("vq/art-candidates/GNV-014/1-a.png")).toThrow();
    expect(() => assertVqBackupKey("vq/characters/X/candidates/1.png")).toThrow();
    expect(() => assertVqBackupKey("images/MV1/front.jpg")).toThrow();
    expect(() => assertVqBackupKey("grading/MV1/front.jpg")).toThrow();
    expect(() => assertVqBackupKey("vq/art/../images/MV1.png")).toThrow();
  });
});

describe("assertVqRestoreTarget — must belong to the expected entity, both-way domain guard", () => {
  it("accepts a key that belongs to the entity", () => {
    expect(assertVqRestoreTarget("vq/characters/GNV-F01-S1/approved/master_portrait/7.png", "character", "GNV-F01-S1")).toContain("approved");
  });
  it("rejects a key for a different entity", () => {
    expect(() => assertVqRestoreTarget("vq/characters/GNV-F02-S1/approved/master_portrait/7.png", "character", "GNV-F01-S1")).toThrow();
  });
  it("refuses a grading object being restored into VQ", () => {
    expect(() => assertVqRestoreTarget("images/MV1/front.jpg", "card", "GNV-014")).toThrow();
  });
});

describe("active-revision selection + pointer-swap plan", () => {
  const rows: RevisionRow[] = [
    { id: 1, isActive: false, r2Key: "vq/art/GNV-014/main/1.png", sha256: "a" },
    { id: 2, isActive: true, r2Key: "vq/art/GNV-014/main/2.png", sha256: "b" },
  ];
  it("selects the active revision", () => {
    expect(selectActiveRevision(rows)?.id).toBe(2);
    expect(selectActiveRevision([])).toBeNull();
  });
  it("plans a swap that deactivates the old active and never deletes it", () => {
    const plan = planPointerSwap(rows[0], rows[1]);
    expect(plan).toMatchObject({ deactivateId: 2, activateId: 1, pointerKey: "vq/art/GNV-014/main/1.png", noop: false });
  });
  it("is a noop when the target is already active", () => {
    expect(planPointerSwap(rows[1], rows[1]).noop).toBe(true);
  });
  it("handles restoring when there is no current active", () => {
    expect(planPointerSwap(rows[0], null)).toMatchObject({ deactivateId: null, activateId: 1, noop: false });
  });
});
