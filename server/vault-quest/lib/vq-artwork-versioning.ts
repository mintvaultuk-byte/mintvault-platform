/**
 * Pure, dependency-free artwork-versioning + backup/restore-safety logic
 * (R4-OPS-02), Phase 7D. Only import is node:crypto (a builtin). No R2/B2/DB.
 * Unit-testable in isolation, like lib/vq-keys.ts.
 *
 * Problem: approved VQ artwork lives at DETERMINISTIC, overwrite-in-place keys
 * (vq/characters/{id}/approved/{type}.png, vq/art/{cardId}/{slot}.png) with no R2
 * versioning, no B2 copy, and no stored hash — so re-approving destroys the prior
 * image irrecoverably. The fix: immutable per-revision keys + a vq_artwork_revisions
 * ledger (active pointer) + sha256/size integrity + a B2 sibling backup. This module
 * is the safety brain: key builder, hash-verify, cross-domain guards, and the
 * pointer-swap planner. The ledger insert + R2/B2 I/O + route wiring are Category C.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type VqRevisionEntityType = "character" | "card";

const safeSeg = (s: string) => String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_").slice(0, 80);

/**
 * Immutable, versioned R2 key for an approved-artwork revision — never overwritten.
 * character → vq/characters/{id}/approved/{slot}/{revisionId}.png
 * card      → vq/art/{cardId}/{slot}/{revisionId}.png
 * Derived from server-owned ids; a hostile segment is sanitised and dot-runs are
 * collapsed so it can never smuggle a traversal.
 */
export function buildApprovedRevisionKey(
  entityType: VqRevisionEntityType,
  entityId: string,
  slot: string,
  revisionId: string | number,
): string {
  const id = safeSeg(entityId);
  const s = safeSeg(slot);
  const rev = safeSeg(String(revisionId));
  const key =
    entityType === "character"
      ? `vq/characters/${id}/approved/${s}/${rev}.png`
      : `vq/art/${id}/${s}/${rev}.png`;
  // Defence-in-depth: the built key must itself be a valid VQ backup target.
  return assertVqBackupKey(key);
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Verify stored bytes against recorded integrity metadata. Constant-time hash
 *  compare. Used before activating a restore and by the B2 backup verify step. */
export function verifyIntegrity(
  buf: Buffer,
  expected: { sha256: string; byteSize?: number | null },
): { ok: boolean; actualSha: string; actualSize: number } {
  const actualSha = sha256Hex(buf);
  const actualSize = buf.length;
  const a = Buffer.from(actualSha, "hex");
  const b = Buffer.from(String(expected.sha256 ?? ""), "hex");
  const shaOk = a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  const sizeOk = expected.byteSize == null || expected.byteSize === actualSize;
  return { ok: shaOk && sizeOk, actualSha, actualSize };
}

const isTraversal = (key: string) =>
  key.includes("..") || key.includes("\\") || key.startsWith("/") || /[\x00-\x1f]/.test(key); // eslint-disable-line no-control-regex

/**
 * A key eligible for VQ artwork backup: approved character art or card art only.
 * Explicitly EXCLUDES candidates (churn, non-canonical) and hard-rejects any
 * grading/customer prefix — so a VQ backup worker can never copy a cert image.
 */
export function assertVqBackupKey(key: string): string {
  const ok =
    !isTraversal(key) &&
    !key.includes("/candidates/") &&
    !key.startsWith("vq/art-candidates/") &&
    (/^vq\/characters\/[^/]+\/approved\//.test(key) || /^vq\/art\/[^/]+\//.test(key));
  if (!ok) throw new Error(`not a VQ approved-artwork backup key: "${key.slice(0, 80)}"`);
  return key;
}

/**
 * Guard a restore target: the key must belong to the expected entity (parsed from
 * the key), be a valid backup key, and NEVER be a grading/cert object. Refuses in
 * both directions so a restore can't cross the VQ/grading boundary.
 */
export function assertVqRestoreTarget(
  key: string,
  expectedEntityType: VqRevisionEntityType,
  expectedEntityId: string,
): string {
  assertVqBackupKey(key); // throws on grading prefixes / candidates / traversal
  const id = safeSeg(expectedEntityId);
  const expected =
    expectedEntityType === "character" ? `vq/characters/${id}/approved/` : `vq/art/${id}/`;
  if (!key.startsWith(expected)) {
    throw new Error(`restore target does not belong to ${expectedEntityType} ${id.slice(0, 40)}`);
  }
  return key;
}

// ── active-pointer selection + swap planning (pure) ──────────────────────────

export interface RevisionRow {
  id: number;
  isActive: boolean;
  r2Key: string;
  sha256: string;
}

export function selectActiveRevision<T extends RevisionRow>(rows: T[]): T | null {
  return rows.find((r) => r.isActive) ?? null;
}

/**
 * Plan the transaction for a restore/approve: deactivate the current active
 * revision (if any and different), activate the target, and point the entity's
 * pointer column at the target's immutable key. Pure — the caller runs it in one DB
 * transaction. Never deletes the previous revision row (it stays as history).
 */
export function planPointerSwap(
  target: RevisionRow,
  currentActive: RevisionRow | null,
): { deactivateId: number | null; activateId: number; pointerKey: string; noop: boolean } {
  if (currentActive && currentActive.id === target.id) {
    return { deactivateId: null, activateId: target.id, pointerKey: target.r2Key, noop: true };
  }
  return {
    deactivateId: currentActive ? currentActive.id : null,
    activateId: target.id,
    pointerKey: target.r2Key,
    noop: false,
  };
}
