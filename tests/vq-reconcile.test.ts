/**
 * Phase 7E — pure VQ orphan-reconciliation diff (R3-CON-01). Detection only; the
 * CLI wiring is a read-only tool and deletion is a separate unbuilt step.
 */
import { describe, it, expect } from "vitest";
import {
  reconcile,
  classifyKeyShape,
  isVqKey,
  referencedCandidateIdsFromPacks,
  type ReconcileInput,
} from "../server/vault-quest/lib/reconcile-logic";

const DAY = 86400000;
const base = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  candidates: [],
  objects: [],
  referencedKeys: new Set(),
  packRefs: [],
  nowMs: 1_000 * DAY,
  retentionTtlMs: 30 * DAY,
  minAgeMs: 0,
  ...over,
});

describe("key helpers", () => {
  it("classifyKeyShape", () => {
    expect(classifyKeyShape("vq/art-candidates/GNV-1/1-a.png")).toBe("candidate");
    expect(classifyKeyShape("vq/characters/X/candidates/1.png")).toBe("candidate");
    expect(classifyKeyShape("vq/characters/X/approved/master_portrait/1.png")).toBe("approved");
    expect(classifyKeyShape("vq/art/GNV-1/main.png")).toBe("art");
    expect(classifyKeyShape("vq/weird/thing.bin")).toBe("unknown");
  });
  it("isVqKey rejects grading + traversal", () => {
    expect(isVqKey("vq/art/GNV-1/main.png")).toBe(true);
    expect(isVqKey("images/MV1/front.png")).toBe(false);
    expect(isVqKey("vq/art/../images/x.png")).toBe(false);
  });
  it("referencedCandidateIdsFromPacks", () => {
    expect([
      ...referencedCandidateIdsFromPacks([{ characterId: "X", referenceType: "m", candidateId: 5, r2Key: "k" }]),
    ]).toEqual([5]);
  });
});

describe("reconcile", () => {
  it("DB row missing object → integrity failure when aged past grace", () => {
    const r = reconcile(
      base({
        candidates: [
          {
            id: 1,
            r2Key: "vq/art-candidates/GNV-1/x.png",
            status: "candidate",
            characterId: null,
            cardId: "GNV-1",
            referenceType: null,
            updatedAtMs: 1_000 * DAY - DAY,
          },
        ],
      })
    );
    expect(r.counts.candidate_missing_object).toBe(1);
    expect(r.integrityFailures).toBe(1);
  });
  it("fresh row missing object → reported but NOT an integrity failure (mid-write)", () => {
    const r = reconcile(
      base({
        candidates: [
          {
            id: 1,
            r2Key: "vq/art-candidates/GNV-1/x.png",
            status: "candidate",
            characterId: null,
            cardId: "GNV-1",
            referenceType: null,
            updatedAtMs: 1_000 * DAY - 1000,
          },
        ],
      })
    );
    expect(r.integrityFailures).toBe(0);
  });
  it("object missing row, old → SAFE_ORPHAN; too new → UNSAFE", () => {
    const old = reconcile(
      base({ objects: [{ key: "vq/art-candidates/GNV-2/x.png", lastModifiedMs: 1_000 * DAY - 60 * DAY }] })
    );
    expect(old.classCounts.SAFE_ORPHAN).toBe(1);
    const fresh = reconcile(
      base({
        minAgeMs: 7 * DAY,
        objects: [{ key: "vq/art-candidates/GNV-2/x.png", lastModifiedMs: 1_000 * DAY - 1 * DAY }],
      })
    );
    expect(fresh.classCounts.SAFE_ORPHAN).toBe(0);
    expect(fresh.classCounts.UNSAFE_REFERENCED).toBe(1);
  });
  it("referenced rejected candidate → UNSAFE, never retention_expired", () => {
    const r = reconcile(
      base({
        candidates: [
          {
            id: 9,
            r2Key: "vq/characters/X/candidates/9.png",
            status: "rejected",
            characterId: "X",
            cardId: null,
            referenceType: "master_portrait",
            updatedAtMs: 1_000 * DAY - 90 * DAY,
          },
        ],
        objects: [{ key: "vq/characters/X/candidates/9.png", lastModifiedMs: 1_000 * DAY - 90 * DAY }],
        packRefs: [
          {
            characterId: "X",
            referenceType: "master_portrait",
            candidateId: 9,
            r2Key: "vq/characters/X/approved/master_portrait.png",
          },
        ],
      })
    );
    expect(r.counts.referenced_by_pack).toBe(1);
    expect(r.counts.retention_expired).toBe(0);
  });
  it("safe old orphan → retention_expired / SAFE_ORPHAN", () => {
    const r = reconcile(
      base({
        candidates: [
          {
            id: 3,
            r2Key: "vq/characters/X/candidates/3.png",
            status: "deleted",
            characterId: "X",
            cardId: null,
            referenceType: "master_portrait",
            updatedAtMs: 1_000 * DAY - 60 * DAY,
          },
        ],
        objects: [{ key: "vq/characters/X/candidates/3.png", lastModifiedMs: 1_000 * DAY - 60 * DAY }],
      })
    );
    expect(r.counts.retention_expired).toBe(1);
    expect(r.safeOrphanCount).toBe(1);
  });
  it("current candidate → not classed safe", () => {
    const r = reconcile(
      base({
        candidates: [
          {
            id: 4,
            r2Key: "vq/characters/X/candidates/4.png",
            status: "candidate",
            characterId: "X",
            cardId: null,
            referenceType: "master_portrait",
            updatedAtMs: 1_000 * DAY - 3600000,
          },
        ],
        objects: [{ key: "vq/characters/X/candidates/4.png", lastModifiedMs: 1_000 * DAY - 3600000 }],
      })
    );
    expect(r.safeOrphanCount).toBe(0);
  });
  it("wrong prefix → WRONG_PREFIX", () => {
    const r = reconcile(base({ objects: [{ key: "vq/weird/thing.bin", lastModifiedMs: 1_000 * DAY }] }));
    expect(r.counts.wrong_prefix).toBe(1);
  });
  it("dangling pack ref (missing candidate) → INTEGRITY_FAILURE", () => {
    const r = reconcile(
      base({ packRefs: [{ characterId: "X", referenceType: "master_portrait", candidateId: 999, r2Key: null }] })
    );
    expect(r.counts.dangling_pack_ref).toBe(1);
    expect(r.integrityFailures).toBe(1);
  });
  it("duplicate approved slot → INTEGRITY_FAILURE", () => {
    const mk = (id: number, key: string) => ({
      id,
      r2Key: key,
      status: "approved",
      characterId: "X",
      cardId: null,
      referenceType: "master_portrait",
      updatedAtMs: 1_000 * DAY,
    });
    const r = reconcile(
      base({
        candidates: [mk(1, "vq/characters/X/candidates/1.png"), mk(2, "vq/characters/X/candidates/2.png")],
        objects: [{ key: "vq/characters/X/candidates/1.png" }, { key: "vq/characters/X/candidates/2.png" }],
      })
    );
    expect(r.counts.duplicate_approved_slot).toBe(1);
  });
  it("emits notes for the infra-blocked categories, plus a 4th when revisions is omitted (Phase 10A-7)", () => {
    expect(reconcile(base()).notes.length).toBe(4);
  });
});

describe("artwork revision ledger checks (Phase 10A-7, R6-F3)", () => {
  it("no note about skipped revision checks when revisions IS supplied", () => {
    const report = reconcile(base({ revisions: [] }));
    expect(report.notes.some((n) => n.includes("SKIPPED"))).toBe(false);
  });

  it("backup_state='failed' on an ACTIVE revision → BACKUP_FAILURE, not INTEGRITY_FAILURE", () => {
    const report = reconcile(
      base({
        objects: [{ key: "vq/art/GNV-001/main/rev-1.png" }],
        revisions: [
          {
            id: 1,
            entityType: "card",
            entityId: "GNV-001",
            slot: "main",
            r2Key: "vq/art/GNV-001/main/rev-1.png",
            isActive: true,
            backupState: "failed",
          },
        ],
      })
    );
    expect(report.classCounts.BACKUP_FAILURE).toBe(1);
    expect(report.classCounts.INTEGRITY_FAILURE).toBe(0); // a failed backup alone is NOT a live-artwork integrity failure
    expect(report.findings.find((f) => f.category === "backup_failed")?.revisionId).toBe(1);
  });

  it("an ACTIVE revision with a MISSING R2 object → INTEGRITY_FAILURE (live artwork is broken)", () => {
    const report = reconcile(
      base({
        objects: [], // the object simply isn't there
        revisions: [
          {
            id: 2,
            entityType: "character",
            entityId: "GNV-F01-S1",
            slot: "master_portrait",
            r2Key: "vq/characters/GNV-F01-S1/approved/master_portrait/rev-2.png",
            isActive: true,
            backupState: "pending",
          },
        ],
      })
    );
    expect(report.classCounts.INTEGRITY_FAILURE).toBe(1);
    expect(report.findings.find((f) => f.category === "active_revision_missing_object")?.revisionId).toBe(2);
  });

  it("an INACTIVE (historical) revision missing its object is NOT flagged — only the active pointer matters", () => {
    const report = reconcile(
      base({
        objects: [],
        revisions: [
          {
            id: 3,
            entityType: "card",
            entityId: "GNV-002",
            slot: "main",
            r2Key: "vq/art/GNV-002/main/old-rev.png",
            isActive: false,
            backupState: "archived",
          },
        ],
      })
    );
    expect(report.classCounts.INTEGRITY_FAILURE).toBe(0);
    expect(report.findings.filter((f) => f.category === "active_revision_missing_object").length).toBe(0);
  });

  it("a healthy active revision (object present, backup archived) produces no revision-related findings", () => {
    const report = reconcile(
      base({
        objects: [{ key: "vq/art/GNV-003/main/rev-4.png" }],
        revisions: [
          {
            id: 4,
            entityType: "card",
            entityId: "GNV-003",
            slot: "main",
            r2Key: "vq/art/GNV-003/main/rev-4.png",
            isActive: true,
            backupState: "archived",
          },
        ],
      })
    );
    expect(report.classCounts.BACKUP_FAILURE).toBe(0);
    expect(
      report.findings.filter((f) => f.category === "active_revision_missing_object" || f.category === "backup_failed")
        .length
    ).toBe(0);
  });
});
