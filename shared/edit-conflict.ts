/**
 * edit-conflict.ts — field-scoped, presence-aware stale-tab detection for the
 * admin certificate metadata editor.
 *
 * Original guard: owner-approved 2026-07-06 after the MV237 clobber.
 * Consolidation pass 2026-07-26: only a genuine SAME-FIELD disagreement may
 * interrupt the grader; unrelated concurrent edits merge silently.
 * Hostile-review remediation 2026-07-26:
 *   H5   designations is now guarded, as an ORDER-INSENSITIVE, DUPLICATE-SAFE set.
 *   MED  absent / null / "" / [] are no longer collapsed — PRESENCE decides
 *        whether a field was submitted at all, so a missing key can never be
 *        read as "clear this field".
 *   MED  related fields form CONSISTENCY GROUPS, so a merge can never assemble
 *        an identity that neither writer intended.
 *
 * The metadata form posts FULL state, so a tab opened before a concurrent
 * change silently writes old values back. A row-level updated_at check is too
 * coarse here: the grading workstation (same page) bumps the row on every grade
 * keystroke without touching metadata, which would throw false conflicts on
 * routine editing. So the client sends the metadata values it LOADED and the
 * server resolves each field three ways (loaded / posted / current).
 */

/** How a guarded field's value is compared. */
export type GuardedFieldKind = "scalar" | "stringArray";

/**
 * Consistency groups.
 *
 * A group is INTERLOCKED when mixing one writer's value with another writer's
 * value inside it produces a combination neither person intended.
 *
 *  • "variant" IS interlocked: rarity, finish, promo, subset and designations
 *    together compose ONE printed classification line, so a hybrid of two
 *    writers' choices can print something neither chose.
 *
 *  • "identity" is NOT interlocked: card name, number, year and language are
 *    independent attributes of the same card. Blocking a rename because someone
 *    else corrected the year would be exactly the "unnecessary interruption"
 *    the owner asked us to remove.
 *
 * Independently of interlocking, a field may GOVERN a group: the set fields
 * govern "variant", because a rarity/finish combination is only meaningful
 * relative to a set. If the set moved under the editor while they were editing
 * the variant, that IS a compound conflict.
 */
export type ConsistencyGroup = "identity" | "variant";

/** Groups where a cross-writer hybrid is unsafe. See above for why identity is
 *  deliberately absent. */
export const INTERLOCKED_GROUPS: readonly ConsistencyGroup[] = ["variant"];

export interface GuardedFieldSpec {
  /** form key = certificate record key = request body key. */
  key: string;
  kind: GuardedFieldKind;
  group: ConsistencyGroup;
  /**
   * Groups whose VALIDITY depends on this field. `setName` governs "variant"
   * because a rarity/finish combination is only meaningful relative to a set —
   * if the set moved under the editor, their variant edit must not be applied
   * blind to the new set.
   */
  governs?: readonly ConsistencyGroup[];
}

/** The metadata fields the editor owns. */
export const GUARDED_FIELD_SPECS: readonly GuardedFieldSpec[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { key: "cardGame", kind: "scalar", group: "identity", governs: ["variant"] },
  { key: "setName", kind: "scalar", group: "identity", governs: ["variant"] },
  { key: "collectionCode", kind: "scalar", group: "identity", governs: ["variant"] },
  { key: "collectionOther", kind: "scalar", group: "identity" },
  { key: "cardName", kind: "scalar", group: "identity" },
  { key: "cardNumber", kind: "scalar", group: "identity" },
  { key: "year", kind: "scalar", group: "identity" },
  { key: "language", kind: "scalar", group: "identity" },
  { key: "era", kind: "scalar", group: "identity", governs: ["variant"] },
  // ── Variant / classification ──────────────────────────────────────────────
  { key: "variant", kind: "scalar", group: "variant" },
  { key: "variantOther", kind: "scalar", group: "variant" },
  { key: "rarity", kind: "scalar", group: "variant" },
  { key: "rarityOther", kind: "scalar", group: "variant" },
  { key: "rarityCode", kind: "scalar", group: "variant" },
  { key: "finishVariant", kind: "scalar", group: "variant" },
  { key: "promoType", kind: "scalar", group: "variant" },
  { key: "subsetName", kind: "scalar", group: "variant" },
  // H5: designations carries designation AND optional-attribute codes. It is a
  // SET, not a scalar — see canonicalArray.
  { key: "designations", kind: "stringArray", group: "variant" },
];

/** Field keys only — the historical export shape. */
export const CONFLICT_GUARDED_FIELDS: readonly string[] = GUARDED_FIELD_SPECS.map((f) => f.key);

const SPEC_BY_KEY = new Map(GUARDED_FIELD_SPECS.map((f) => [f.key, f]));

// ── Presence ────────────────────────────────────────────────────────────────

/**
 * What the request actually carried for a field. ABSENT is the critical one:
 * a field that was never submitted must never be interpreted as an instruction
 * to clear. The other four are all legitimate, distinguishable submissions.
 */
export type FieldPresence = "absent" | "null" | "emptyString" | "emptyArray" | "value";

/** True property presence — NOT `?? ""`, and not falsiness. */
export function isSubmitted(body: unknown, key: string): boolean {
  return !!body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, key);
}

export function fieldPresence(body: unknown, key: string): FieldPresence {
  if (!isSubmitted(body, key)) return "absent";
  const v = (body as Record<string, unknown>)[key];
  if (v === null) return "null";
  if (v === undefined) return "absent"; // an explicit `undefined` is not a submission
  if (Array.isArray(v)) return v.length === 0 ? "emptyArray" : "value";
  if (typeof v === "string") {
    // A JSON-encoded empty array (multipart bodies stringify arrays).
    const t = v.trim();
    if (t === "") return "emptyString";
    if (t === "[]") return "emptyArray";
    return "value";
  }
  return "value";
}

/**
 * The valid CLEAR representation for each guarded field:
 *   • scalar      → explicit `null` or explicit `""`
 *   • stringArray → explicit `[]` (or the string "[]")
 * Anything absent is NOT a clear.
 */
export function isExplicitClear(body: unknown, key: string): boolean {
  const spec = SPEC_BY_KEY.get(key);
  const p = fieldPresence(body, key);
  if (p === "absent") return false;
  if (spec?.kind === "stringArray") return p === "emptyArray" || p === "null";
  return p === "null" || p === "emptyString";
}

// ── Canonicalisation (for EQUALITY only, never for presence) ────────────────

/** Scalars: null/undefined/whitespace all compare equal to "". This is about
 *  whether the STORED meaning differs, not whether the key was submitted —
 *  presence is tracked separately above, so this cannot cause a missing field
 *  to read as a clear. */
function canonicalScalar(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/**
 * Arrays: order-insensitive and duplicate-safe. Entries are trimmed, empties
 * dropped, de-duplicated, then sorted, and joined with a separator that cannot
 * occur in a designation code. Accepts a real array or a JSON string (multipart
 * bodies stringify arrays), so the wire format never changes the verdict.
 */
export function canonicalArray(v: unknown): string {
  let arr: unknown[];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return "";
    try {
      const parsed = JSON.parse(t);
      arr = Array.isArray(parsed) ? parsed : [t];
    } catch {
      arr = [t];
    }
  } else if (v === null || v === undefined) return "";
  else return String(v);

  const cleaned = arr
    .map((x) => (x === null || x === undefined ? "" : String(x).trim()))
    .filter((x) => x !== "");
  return Array.from(new Set(cleaned)).sort().join(" ");
}

/** The canonical ARRAY (not the join key) — for truthful audit payloads. */
export function canonicalArrayValue(v: unknown): string[] {
  const joined = canonicalArray(v);
  return joined === "" ? [] : joined.split(" ");
}

function canonicalFor(spec: GuardedFieldSpec, v: unknown): string {
  return spec.kind === "stringArray" ? canonicalArray(v) : canonicalScalar(v);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Where a field's final value came from — recorded in the audit (H6). */
export type FieldProvenance =
  /** taken from this request */
  | "request"
  /** the request omitted the field entirely; the stored value is retained */
  | "omitted"
  /** the request carried a stale value it never edited; the concurrent DB value wins */
  | "merged";

export interface ResolvedField {
  key: string;
  provenance: FieldProvenance;
  /** Canonical previous (DB) value. string for scalars, string[] for arrays. */
  previous: string | string[];
  /** Canonical value that will be persisted. */
  next: string | string[];
  /** True when `next` differs from `previous` — i.e. this is a real change. */
  changed: boolean;
}

export interface EditConflictResolution {
  /** TRUE conflicts: the editor changed this field AND someone else changed the
   *  same field to something different. Only these justify interrupting. */
  conflicts: string[];
  /** Fields the editor never edited but that moved in the DB. The DB value wins
   *  silently — the stale value in this tab is simply not written back. */
  merged: string[];
  /** Guarded fields the request did not submit at all. Left untouched. */
  omitted: string[];
  /** Consistency groups where a hybrid would have been assembled. */
  compoundConflicts: Array<{ group: ConsistencyGroup; editorEdited: string[]; movedElsewhere: string[] }>;
  /** Per-field outcome, including provenance and canonical before/after. */
  fields: ResolvedField[];
  /** Only the fields that genuinely CHANGED — the truthful audit diff (H6). */
  changes: ResolvedField[];
  /** Values to persist for guarded fields, keyed by field. Fields whose
   *  provenance is "omitted" are absent: the caller must not write them. */
  valuesToPersist: Record<string, string | string[]>;
  /** True when nothing may be written. */
  blocked: boolean;
}

/**
 * Three-way resolution for the full-state metadata editor.
 *
 * For each guarded field, given what this tab LOADED, what it is POSTING, and
 * what the DB CURRENTLY holds:
 *
 *   • not submitted at all                     → OMITTED. Never a clear. The
 *     stored value is retained untouched.
 *   • DB unchanged since load                  → write the submitted value.
 *   • DB changed, editor did NOT edit it       → MERGE: keep the DB value. The
 *     tab is only echoing its stale load; overwriting would be the clobber.
 *   • DB changed, editor DID edit it, values
 *     still differ                             → TRUE CONFLICT.
 *   • DB changed, editor DID edit it, both
 *     landed on the same value                 → converged, harmless.
 *
 * Then, across consistency groups: if the editor edited a field in a group and
 * a DIFFERENT field in that same group (or a field GOVERNING it, e.g. the set)
 * moved elsewhere, the per-field merge would assemble an identity that neither
 * writer intended — so that escalates to a compound conflict.
 */
export function resolveEditConflicts(
  loaded: Record<string, unknown>,
  posted: Record<string, unknown>,
  current: Record<string, unknown>
): EditConflictResolution {
  const conflicts: string[] = [];
  const merged: string[] = [];
  const omitted: string[] = [];
  const fields: ResolvedField[] = [];
  const valuesToPersist: Record<string, string | string[]> = {};

  const editorEditedByGroup = new Map<ConsistencyGroup, string[]>();
  const movedElsewhereByGroup = new Map<ConsistencyGroup, string[]>();
  const push = (m: Map<ConsistencyGroup, string[]>, g: ConsistencyGroup, k: string) => {
    const list = m.get(g) ?? [];
    list.push(k);
    m.set(g, list);
  };

  for (const spec of GUARDED_FIELD_SPECS) {
    const k = spec.key;
    const loadedC = canonicalFor(spec, loaded[k]);
    const currentC = canonicalFor(spec, current[k]);
    const changedElsewhere = currentC !== loadedC;

    const previousValue: string | string[] =
      spec.kind === "stringArray" ? canonicalArrayValue(current[k]) : currentC;

    // ── Not submitted: never interpret as a clear. ──────────────────────────
    if (!isSubmitted(posted, k)) {
      omitted.push(k);
      fields.push({ key: k, provenance: "omitted", previous: previousValue, next: previousValue, changed: false });
      if (changedElsewhere) push(movedElsewhereByGroup, spec.group, k);
      continue;
    }

    const postedC = canonicalFor(spec, posted[k]);
    const editorEdited = postedC !== loadedC;
    if (editorEdited) push(editorEditedByGroup, spec.group, k);
    // M-1: a field that moved in the DB but that this request is posting the
    // SAME canonical value for has CONVERGED — both writers agree. Convergence
    // is not disagreement, so it must not seed a compound conflict. Only a field
    // that still DISAGREES with the database counts as "moved elsewhere".
    //
    // Worked example this fixes: set was "Base"; the editor changes it to
    // "Jungle" and also picks a Variant; another writer independently sets the
    // same "Jungle". The set agrees, so the Variant edit proceeds. Had the other
    // writer chosen a DIFFERENT set, the disagreement stands and the compound
    // conflict still fires.
    const convergedWithDb = postedC === currentC;
    if (changedElsewhere && !convergedWithDb) push(movedElsewhereByGroup, spec.group, k);

    if (changedElsewhere && editorEdited && postedC !== currentC) {
      conflicts.push(k);
      fields.push({ key: k, provenance: "request", previous: previousValue, next: previousValue, changed: false });
      continue;
    }

    if (changedElsewhere && !editorEdited) {
      // SAFE MERGE — the concurrent DB value wins.
      merged.push(k);
      fields.push({ key: k, provenance: "merged", previous: previousValue, next: previousValue, changed: false });
      valuesToPersist[k] = previousValue;
      continue;
    }

    const nextValue: string | string[] =
      spec.kind === "stringArray" ? canonicalArrayValue(posted[k]) : postedC;
    fields.push({
      key: k,
      provenance: "request",
      previous: previousValue,
      next: nextValue,
      changed: postedC !== currentC,
    });
    valuesToPersist[k] = nextValue;
  }

  // ── Compound (related-field) conflicts ─────────────────────────────────────
  const compoundConflicts: EditConflictResolution["compoundConflicts"] = [];
  const groups: ConsistencyGroup[] = ["identity", "variant"];
  for (const g of groups) {
    const edited = editorEditedByGroup.get(g) ?? [];
    if (edited.length === 0) continue;

    // Fields in the SAME group that moved elsewhere but the editor did not edit
    // — only meaningful for INTERLOCKED groups (see ConsistencyGroup docs).
    const movedSameGroup = INTERLOCKED_GROUPS.includes(g)
      ? (movedElsewhereByGroup.get(g) ?? []).filter((k) => !edited.includes(k))
      : [];

    // Fields in ANY group that GOVERN this group and moved elsewhere.
    const movedGoverning: string[] = [];
    for (const [og, keys] of movedElsewhereByGroup) {
      for (const k of keys) {
        const spec = SPEC_BY_KEY.get(k);
        if (!spec?.governs?.includes(g)) continue;
        if (og === g && edited.includes(k)) continue;
        movedGoverning.push(k);
      }
    }

    const movedElsewhere = Array.from(new Set([...movedSameGroup, ...movedGoverning]));
    if (movedElsewhere.length > 0) {
      compoundConflicts.push({ group: g, editorEdited: edited, movedElsewhere });
    }
  }

  const blocked = conflicts.length > 0 || compoundConflicts.length > 0;
  return {
    conflicts,
    merged,
    omitted,
    compoundConflicts,
    fields,
    changes: blocked ? [] : fields.filter((f) => f.changed),
    valuesToPersist: blocked ? {} : valuesToPersist,
    blocked,
  };
}

/**
 * @deprecated Superseded by {@link resolveEditConflicts}.
 *
 * RETAINED DELIBERATELY as part of the public helper contract: it reports EVERY
 * divergent guarded field, including ones the editor never touched, which is
 * the strictest possible stale-tab signal. It has NO production caller — the
 * route uses resolveEditConflicts — but the original MV237 regression tests
 * assert against it, and keeping it lets a reviewer diff "strictest" against
 * "shipped" without reconstructing the old logic. Do not wire it into a route.
 */
export function findStaleOverwrites(
  loaded: Record<string, unknown>,
  posted: Record<string, unknown>,
  current: Record<string, unknown>
): string[] {
  const out: string[] = [];
  for (const spec of GUARDED_FIELD_SPECS) {
    const changedElsewhere = canonicalFor(spec, current[spec.key]) !== canonicalFor(spec, loaded[spec.key]);
    const wouldOverwrite = canonicalFor(spec, posted[spec.key]) !== canonicalFor(spec, current[spec.key]);
    if (changedElsewhere && wouldOverwrite) out.push(spec.key);
  }
  return out;
}
