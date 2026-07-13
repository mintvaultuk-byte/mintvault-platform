/**
 * Pure, dependency-free write-sanitisation helpers for the Vault Quest backend.
 *
 * Extracted so the security-relevant logic (strip client-controlled scope/identity
 * columns; coerce numerics) can be unit-tested without importing the DB layer.
 * Used by production-storage.ts (mass-assignment guard) and generate.ts (card
 * numbering). No side effects, no imports.
 */

/** Columns a client must never set on a production write: `setCode` is always
 *  taken from the URL, and id/revision/timestamps are server-owned. */
export const WRITE_STRIP = new Set(["id", "setCode", "revision", "revisionNumber", "createdAt", "updatedAt"]);

/** Integer columns across the production tables — coerced "" / non-finite → null. */
export const WRITE_INT_FIELDS = new Set([
  "releaseYear", "cardCount", "boosterSize", "cardsPerPack", "variantSlots", "holoSlots", "printQuantity",
]);

/** Production columns that hold a Cloudflare R2 object key. A client must never be
 *  able to persist a grading/customer key (`images/…`, `labels/…`, `scans/…`) into
 *  one of these: nothing reads them from R2 today, but the first future
 *  "download print file / preview asset" reader would otherwise serve a
 *  cross-system object out of the shared bucket. Blank clears the field; any
 *  non-`vq/` value is rejected (see assertVqReadKey / assertVqWriteKey). */
export const WRITE_R2_KEY_FIELDS = new Set([
  "setLogoR2Key", "artworkR2Key", "mockupR2Key", "printPdfR2Key", "dielineR2Key",
  "fileR2Key", "finalExportR2Key", "r2Key",
]);

/** Coerce a client numeric field: "" / null / non-finite → null, else the number.
 *  Integer columns reject '' with Postgres 22P02 (a raw 500 instead of a clean save). */
export function intOrNull(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Strip immutable/scope columns and coerce integer columns from a client body.
 * Legitimate admin fields (status, approvalStatus, locked, checklist, names,
 * notes, R2 keys) pass through unchanged — on an admin-only tool the admin IS
 * the approver, so those are authorised actions, not a workflow bypass.
 */
export function sanitizeWrite(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (WRITE_STRIP.has(k)) continue;
    if (WRITE_INT_FIELDS.has(k)) { out[k] = intOrNull(v); continue; }
    if (WRITE_R2_KEY_FIELDS.has(k) && typeof v === "string" && v.trim() !== "" && !v.startsWith("vq/")) {
      throw new Error(`${k} must be a Vault Quest asset key (vq/…) — got a non-vq/ key`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * True if `candidateId` is the approved source of any reference-pack slot.
 * Used to block rejecting/deleting a candidate that a character's reference_pack
 * still points at (which would leave `reference_pack.<type>.candidateId` dangling).
 */
export function isCandidateReferencedInPack(
  pack: Record<string, { candidateId?: number | null } | null | undefined> | null | undefined,
  candidateId: number,
): boolean {
  if (!pack) return false;
  return Object.values(pack).some((slot) => !!slot && slot.candidateId === candidateId);
}

/**
 * Build the one-slot JSON payload for an atomic reference-pack merge
 * (`reference_pack || <this>::jsonb`). Only ever a SINGLE top-level key so a
 * concurrent approval of a different reference type can't clobber this one.
 * Pure: the caller supplies the ISO timestamp so this stays deterministic.
 */
export function referencePackMergeJson(
  referenceType: string,
  r2Key: string,
  candidateId: number | null,
  identityScore: number | null | undefined,
  approvedAtIso: string,
): string {
  return JSON.stringify({
    [referenceType]: { r2Key, candidateId, approvedAt: approvedAtIso, identityScore: identityScore ?? null },
  });
}

/**
 * Next free card number for a set. Card ids are `${setCode}-NNN`; the prefix must
 * match the set being generated (a hardcoded prefix breaks numbering for any other
 * set → id collision on create).
 */
export function nextCardNumFrom(cards: { cardId: string }[], setCode: string): number {
  const re = new RegExp(`^${setCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  let max = 0;
  for (const c of cards) {
    const m = re.exec(c.cardId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
