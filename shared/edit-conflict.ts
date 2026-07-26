/**
 * edit-conflict.ts — field-scoped stale-tab detection for the admin cert
 * metadata editor (owner-approved 2026-07-06 after the MV237 clobber).
 *
 * The metadata form posts FULL state, so a tab opened before a concurrent
 * change silently writes old values back. A row-level updated_at check is too
 * coarse here: the grading workstation (same page) bumps the row on every
 * grade keystroke without touching metadata, which would make routine editing
 * throw false conflicts. Instead the client sends the metadata values it
 * LOADED; a field conflicts only when BOTH are true:
 *   1. the DB value changed since the tab loaded it (someone else wrote it), and
 *   2. this save would overwrite that newer DB value with something different.
 * Posting a value identical to the current DB value is always harmless.
 */

/** The metadata fields the editor owns (form key = cert record key = body key). */
export const CONFLICT_GUARDED_FIELDS = [
  "cardName",
  "setName",
  "cardNumber",
  "year",
  "variant",
  "variantOther",
  "rarity",
  "rarityOther",
  "language",
  "collectionCode",
  "collectionOther",
  // Structured rarity/variant fields (added with the visual picker). form key =
  // cert record key = body key, so the same stale-tab guard extends to them.
  // region + symbol columns are server-derived (never posted) so are not guarded.
  "rarityCode",
  "finishVariant",
  "promoType",
  "subsetName",
  "era",
] as const;

/** null/undefined/absent and whitespace-only all mean "empty". */
function norm(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/**
 * Returns the guarded fields where a stale tab would overwrite someone else's
 * newer value — empty array means the save is safe to apply.
 *
 * NOTE: kept for backwards compatibility. It reports EVERY divergent field,
 * including ones the editor never touched, which is why it was too disruptive
 * on its own. Prefer `resolveEditConflicts` — it separates the fields that can
 * be merged silently from the ones that genuinely need the operator.
 */
export function findStaleOverwrites(
  loaded: Record<string, unknown>,
  posted: Record<string, unknown>,
  current: Record<string, unknown>
): string[] {
  const conflicts: string[] = [];
  for (const f of CONFLICT_GUARDED_FIELDS) {
    const changedElsewhere = norm(current[f]) !== norm(loaded[f]);
    const wouldOverwrite = norm(posted[f]) !== norm(current[f]);
    if (changedElsewhere && wouldOverwrite) conflicts.push(f);
  }
  return conflicts;
}

export interface EditConflictResolution {
  /** TRUE conflicts: the editor changed this field AND someone else changed the
   *  same field to something different. Only these justify interrupting. */
  conflicts: string[];
  /** Fields the editor never touched but that moved in the DB. The DB value
   *  wins silently — the stale value in this tab is simply not written back. */
  merged: string[];
}

/**
 * Field-level three-way resolution for the full-state metadata editor
 * (owner spec 2026-07-26: "Only interrupt when the SAME FIELD has changed
 * elsewhere. If unrelated fields changed: merge safely, continue editing").
 *
 * For each guarded field, given what this tab LOADED, what it is POSTING, and
 * what the DB CURRENTLY holds:
 *
 *   • DB unchanged since load                  → nothing to do (normal save).
 *   • DB changed, editor did NOT touch it      → MERGE: keep the DB value. The
 *     tab is only echoing its stale load; overwriting would be the clobber.
 *   • DB changed, editor DID touch it, and the
 *     editor's value differs from the DB's     → TRUE CONFLICT: interrupt.
 *   • DB changed, editor DID touch it, but both
 *     landed on the same value                 → converged, harmless.
 *
 * This is what turns the old "any divergence 409s the whole save" behaviour
 * into "only a genuine same-field disagreement stops the grader".
 */
export function resolveEditConflicts(
  loaded: Record<string, unknown>,
  posted: Record<string, unknown>,
  current: Record<string, unknown>
): EditConflictResolution {
  const conflicts: string[] = [];
  const merged: string[] = [];
  for (const f of CONFLICT_GUARDED_FIELDS) {
    const changedElsewhere = norm(current[f]) !== norm(loaded[f]);
    if (!changedElsewhere) continue;
    const editorTouchedIt = norm(posted[f]) !== norm(loaded[f]);
    if (!editorTouchedIt) {
      merged.push(f);
      continue;
    }
    if (norm(posted[f]) === norm(current[f])) continue; // converged on the same value
    conflicts.push(f);
  }
  return { conflicts, merged };
}
