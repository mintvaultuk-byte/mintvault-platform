/**
 * certificate-field-ownership.ts — the ONE contract describing which workflow
 * stage owns which certificate column.
 *
 * WHY THIS EXISTS (PR A, 2026-07-26)
 * The Card Details editor posted FULL form state on every auto-save, including
 * `gradeOverall` / `gradeType` / `labelType`. The hidden grading workstation
 * writes grading columns out-of-band on mount, but the Card Details form is
 * never re-seeded after that write — so the next metadata auto-save posted a
 * STALE grade and the server accepted it. Live evidence on staging: MV900007
 * went 9.0 → 10.0 (background grading write) → 9.0 (metadata save reverting it),
 * audit #1915 `gradeOverall: "10.0"->"9.0"`.
 *
 * The fix is an ownership boundary rather than a patch:
 *   • Card Details owns identity + catalogue metadata ONLY.
 *   • The grading workstation owns grading state ONLY.
 *   • Review owns approval state ONLY.
 *
 * Both the client payload builder and the server update route import from here,
 * so the two can never drift. Grading writes go exclusively through the
 * dedicated grading route (`PUT /certificates/:id/grade`).
 *
 * TRACKED FINDING (deliberately NOT fixed in this PR):
 * Pristine eligibility is not yet backed by a persisted authoritative 100-point MVGS result.
 * It is inferred from quad-10 subgrades plus a deduction check recomputed at render time, and
 * `isPristine()` falls back to a subgrades-only test when deductions are absent — so four
 * visible 10s alone can currently qualify a card as Pristine. Weak call sites today:
 * server/lib/cert-pristine.ts, server/showroom.ts, client grading-panel.tsx.
 * This is being handled in a separate prerequisite PR (PR B). Nothing in this file changes
 * Pristine, isPristine(), label rendering, certificate rendering, or the MVGS formula.
 */

/**
 * Columns the Card Details metadata editor is allowed to write.
 * Anything absent from this list is NOT metadata-owned and must not be
 * persisted by the metadata route, whatever the client sends.
 */
export const METADATA_OWNED_FIELDS = [
  // Card identity
  "cardGame",
  "setName",
  "cardName",
  "cardNumber",
  "year",
  "language",
  // Catalogue / classification identity
  "variant",
  "variantOther",
  "rarity",
  "rarityOther",
  "rarityCode",
  "finishVariant",
  "promoType",
  "subsetName",
  "designations",
  "era",
  // Collection / set code
  "collectionCode",
  "collectionOther",
  // Free text
  "notes",
  // Workflow status (not grading state)
  "status",
] as const;

/**
 * Fields the CREATE form may send that the metadata EDIT form may not.
 *
 * These are establish-once decisions: at POST time there is no certificate id,
 * so the surface that owns the field for an existing record is not mounted, and
 * omitting the field would silently force a wrong default. Every one of them is
 * scoped to `!isEdit` on the client and is NOT metadata-owned, so no UPDATE can
 * carry it and the metadata PUT boundary is untouched.
 *
 *   • `gradeType`  — the POST route establishes a certificate's initial KIND from
 *     `req.body.gradeType` (defaulting to "numeric"). For an existing record the
 *     kind is owned by the grading workstation's authentication control, so this
 *     stays grading-owned and the metadata PUT still rejects it (M-4/H-1 review).
 *
 *   • `submissionItemId` — the paid-submission linkage. The POST route validates
 *     it against `submission_items` (submission not draft, not soft-deleted, item
 *     not already linked) and stores `submission_item_id`. It is NOT a grading
 *     field and NOT an unrestricted bypass: it is create-only, so an EDIT can
 *     never silently re-link a certificate to a different submission item. There
 *     is deliberately no metadata-owned re-link path — re-linking an existing
 *     certificate is not a supported workflow on this route (hostile review H-1).
 *
 * Named CREATE_ONLY_FIELDS (was CREATE_ONLY_GRADING_KEYS) because it now holds
 * non-grading create-only fields too.
 */
export const CREATE_ONLY_FIELDS = ["gradeType", "submissionItemId"] as const;

/**
 * Columns the metadata route derives and commits from IMAGE uploads. Explicitly
 * named rather than folded into the metadata allowlist, so the server commit
 * guard below can distinguish "the client asked for this" from "an upload
 * produced this".
 */
export const IMAGE_OWNED_FIELDS = ["frontImagePath", "backImagePath"] as const;

/**
 * Columns the structured rarity/variant picker derives server-side
 * (`applyStructuredVariantFromBody` → `structuredColumnsToCertFields`). The
 * client submits the five picker inputs; these are the columns actually written.
 */
export const STRUCTURED_METADATA_FIELDS = [
  "rarityCode",
  "rarityLabelStructured",
  "printedSymbol",
  "printedSymbolCount",
  "printedSymbolColour",
  "finishVariant",
  "promoType",
  "subsetName",
  "region",
  "era",
  "structuredVariantVersion",
] as const;

/**
 * Columns owned by the grading workstation or the approval flow. The metadata
 * route must never write these — they are listed explicitly so a submitted
 * value is REJECTED with a clear contract error rather than silently dropped.
 */
export const GRADING_OWNED_FIELDS = [
  // Headline grade + its derived label
  "gradeOverall",
  "gradeType",
  "labelType",
  // Sub-grades
  "gradeCentering",
  "gradeCorners",
  "gradeEdges",
  "gradeSurface",
  // Authenticity outcome — decides NO / AA, i.e. whether the certificate is
  // numeric at all. Owned by the grading workstation's authentication control.
  // NOTE: `auth_status` is a real database column but is NOT declared in
  // shared/schema.ts, so it is absent from a Drizzle-selected row. The route's
  // comparison below fails CLOSED for that case (see `gradingFieldChanges`).
  "authStatus",
  "authNotes",
  // Manual-override flag. See UNDECLARED_GRADING_COLUMNS below — this is a REAL
  // boolean column (`grade_manual_override`) that shared/schema.ts does not
  // declare, exactly like authStatus, so it also fails CLOSED.
  "gradeManualOverride",
  // Measurements + evidence feeding MVGS
  "centeringFrontLr",
  "centeringFrontTb",
  "centeringBackLr",
  "centeringBackTb",
  "centeringOuterFront",
  "centeringOuterBack",
  "centeringInnerFront",
  "centeringInnerBack",
  "centeringMethod",
  // Card-tool 8-dot evidence (jsonb). Real columns, undeclared in schema.
  "centeringPointsFront",
  "centeringPointsBack",
  "cornerValues",
  "edgeValues",
  "surfaceValues",
  "defects",
  "aiDefects",
  "verifiedDefects",
  "aiDefectCandidates",
  // MVGS modifiers / deduction inputs
  "darkBorder",
  "darkBorderFront",
  "darkBorderBack",
  "eyeAppealModifier",
  "whiteningLines",
  "creaseLines",
  "creaseSpanPct",
  "wrinkleSeverity",
  "tearSeverity",
  "gradeStrengthScore",
  "gradeExplanation",
  "aiDraftGrade",
  // Operator's submitted snapshot (grading work product, not metadata)
  "operatorGrade",
  "operatorSubgrades",
  "gradingReport",
  // Approval state
  "gradeApprovedBy",
  "gradeApprovedAt",
  "gradedAt",
  "gradedBy",
  "graderStatus",
  // Grading workflow state + acknowledgement, both real undeclared columns.
  "gradingStatus",
  "heavyDamageAcknowledgedAt",
  "imageQualityChecks",
  // Grading capture assets (the card tool's originals + crops).
  "gradingCardId",
  "gradingCardSource",
  "gradingAngledOriginal",
  "gradingAngledCropped",
  "gradingCloseupOriginal",
  "gradingCloseupCropped",
] as const;

/**
 * REAL `certificates` columns that shared/schema.ts does NOT declare, verified
 * against the live database on 2026-07-26 (staging `ep-purple-voice`, via
 * information_schema).
 *
 * WHY THIS LIST EXISTS. A Drizzle-selected row has no property for an undeclared
 * column, so `gradingFieldChanges` cannot prove a submitted value is a harmless
 * echo. Every name here is therefore treated as fail-CLOSED: a non-empty
 * submitted value is a CHANGE and is rejected. Correcting a previous revision of
 * this file: `gradeManualOverride` was NOT invented — `grade_manual_override`
 * is a real `boolean` column. It is restored above with both of its real names.
 *
 * This is documentation + safe rejection only. PR A deliberately does NOT
 * reconcile shared/schema.ts with the live database; that is separate work.
 *
 * Live grading-related columns absent from shared/schema.ts:
 *   auth_status (text) · auth_notes (text) · grade_manual_override (boolean) ·
 *   grading_status (text) · heavy_damage_acknowledged_at (timestamptz) ·
 *   image_quality_checks (jsonb) · centering_points_front (jsonb) ·
 *   centering_points_back (jsonb) · grading_card_id (text) ·
 *   grading_card_source (text) · grading_angled_original (text) ·
 *   grading_angled_cropped (text) · grading_closeup_original (text) ·
 *   grading_closeup_cropped (text)
 *
 * Also absent but NOT grading-owned, recorded here so the search is not repeated:
 *   cert_tracking_number · claim_code · current_listing_id · estimated_value_low ·
 *   estimated_value_high · market_value_updated_at · ingest_idempotency_key ·
 *   raw_uploaded · scan_status · private_notes · source · status_updated_at
 */
export const UNDECLARED_GRADING_COLUMNS = [
  "auth_status",
  "auth_notes",
  "grade_manual_override",
  "grading_status",
  "heavy_damage_acknowledged_at",
  "image_quality_checks",
  "centering_points_front",
  "centering_points_back",
  "grading_card_id",
  "grading_card_source",
  "grading_angled_original",
  "grading_angled_cropped",
  "grading_closeup_original",
  "grading_closeup_cropped",
] as const;
// NOTE: an earlier revision of this file also listed
// "centeringScore"/"cornersScore"/"edgesScore"/"surfaceScore" as OWNED keys.
// Those names ARE real, but they are the DATABASE column names for
// gradeCentering / gradeCorners / gradeEdges / gradeSurface, not separate
// fields; listing them there compared a submitted value against an
// always-undefined property. They are declared as aliases below, where they
// resolve to the real column.

/**
 * EVERY OTHER REAL NAME a grading-owned field travels under, mapped to its
 * canonical Drizzle/TypeScript key above.
 *
 * WHY THIS MATTERS
 * The metadata route builds its update object from METADATA_OWNED_FIELDS only,
 * so an unrecognised key can never be WRITTEN whatever it is called. But a
 * caller that submits a grading value under an unrecognised alias would receive
 * a 200 and believe its grading write landed. The contract must name every real
 * alias so the answer is an explicit rejection instead of a silent no-op.
 *
 * THREE NAMING FAMILIES EXIST IN THIS REPOSITORY
 *   1. Drizzle / TypeScript keys — `gradeCorners` (shared/schema.ts).
 *   2. Grading-API payload keys — `grade_corners`, `corners` (the body the
 *      grading workstation posts to PUT /certificates/:id/grade).
 *   3. Database / audit column names — `corners_score` (the actual column, and
 *      the name that appears in raw SQL and audit payloads).
 *
 * Every entry below is a name that genuinely appears in the repository: a
 * declared column in shared/schema.ts, a `b.<key>` read in the grade route, or
 * an audit fieldMap entry. No speculative variants.
 *
 * PROTOTYPE SAFETY (hostile review M-2). This map is built on a NULL PROTOTYPE
 * (`Object.create(null)`) and every lookup additionally goes through
 * `Object.prototype.hasOwnProperty.call`. A plain object literal inherits
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty` and `__proto__` from
 * Object.prototype, so `ALIASES[key]` returned a truthy FUNCTION for any of
 * those key names — a request body carrying a key called `constructor` was
 * therefore classified as a grading field, rejected with 409, and written to the
 * audit trail as an attempted grading write. A null-prototype map also makes
 * `__proto__` an ordinary own key rather than a setter, so the map cannot be
 * poisoned by a submitted `__proto__`.
 */
const RAW_GRADING_FIELD_ALIASES: Record<string, GradingOwnedField> = {
  // ── Overall grade. Column is literally `grade` (shared/schema.ts:341). ──
  grade: "gradeOverall",
  grade_overall: "gradeOverall",
  overallGrade: "gradeOverall",
  overall_grade: "gradeOverall",
  // ── Kind + derived label ──
  grade_type: "gradeType",
  label_type: "labelType",
  // ── Sub-grades: API name, DB column name ──
  grade_centering: "gradeCentering",
  centeringScore: "gradeCentering",
  centering_score: "gradeCentering",
  grade_corners: "gradeCorners",
  cornersScore: "gradeCorners",
  corners_score: "gradeCorners",
  grade_edges: "gradeEdges",
  edgesScore: "gradeEdges",
  edges_score: "gradeEdges",
  grade_surface: "gradeSurface",
  surfaceScore: "gradeSurface",
  surface_score: "gradeSurface",
  // ── Authenticity outcome ──
  auth_status: "authStatus",
  auth_notes: "authNotes",
  // ── Manual override (real boolean column, undeclared in shared/schema.ts) ──
  grade_manual_override: "gradeManualOverride",
  // ── Centering measurements ──
  centering_front_lr: "centeringFrontLr",
  centering_front_tb: "centeringFrontTb",
  centering_back_lr: "centeringBackLr",
  centering_back_tb: "centeringBackTb",
  centering_outer_front: "centeringOuterFront",
  centering_outer_back: "centeringOuterBack",
  centering_inner_front: "centeringInnerFront",
  centering_inner_back: "centeringInnerBack",
  centering_method: "centeringMethod",
  centering_points_front: "centeringPointsFront",
  centering_points_back: "centeringPointsBack",
  // ── Per-zone evidence. The grade route reads these as bare `corners` /
  //    `edges` / `surface`; the columns are *_values. ──
  corners: "cornerValues",
  corner_values: "cornerValues",
  edges: "edgeValues",
  edge_values: "edgeValues",
  surface: "surfaceValues",
  surface_values: "surfaceValues",
  // ── Defects ──
  ai_defects: "aiDefects",
  verified_defects: "verifiedDefects",
  ai_defect_candidates: "aiDefectCandidates",
  // ── MVGS modifiers / deduction inputs ──
  dark_border: "darkBorder",
  dark_border_front: "darkBorderFront",
  dark_border_back: "darkBorderBack",
  eye_appeal_modifier: "eyeAppealModifier",
  whitening_lines: "whiteningLines",
  crease_lines: "creaseLines",
  crease_span_pct: "creaseSpanPct",
  wrinkle_severity: "wrinkleSeverity",
  tear_severity: "tearSeverity",
  grade_strength_score: "gradeStrengthScore",
  grade_explanation: "gradeExplanation",
  ai_draft_grade: "aiDraftGrade",
  // ── Operator snapshot + report ──
  operator_grade: "operatorGrade",
  operator_subgrades: "operatorSubgrades",
  grading_report: "gradingReport",
  // ── Approval state ──
  grade_approved_by: "gradeApprovedBy",
  grade_approved_at: "gradeApprovedAt",
  graded_at: "gradedAt",
  graded_by: "gradedBy",
  grader_status: "graderStatus",
  // ── Grading workflow state + capture assets ──
  grading_status: "gradingStatus",
  heavy_damage_acknowledged_at: "heavyDamageAcknowledgedAt",
  image_quality_checks: "imageQualityChecks",
  grading_card_id: "gradingCardId",
  grading_card_source: "gradingCardSource",
  grading_angled_original: "gradingAngledOriginal",
  grading_angled_cropped: "gradingAngledCropped",
  grading_closeup_original: "gradingCloseupOriginal",
  grading_closeup_cropped: "gradingCloseupCropped",
};

/**
 * The alias map actually consulted at runtime — a NULL-PROTOTYPE copy, so it
 * carries no inherited keys at all. Frozen so it cannot be mutated after load.
 */
export const GRADING_FIELD_ALIASES: Readonly<Record<string, GradingOwnedField>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, GradingOwnedField>, RAW_GRADING_FIELD_ALIASES),
);

export type MetadataOwnedField = (typeof METADATA_OWNED_FIELDS)[number];
export type GradingOwnedField = (typeof GRADING_OWNED_FIELDS)[number];

const METADATA_SET: ReadonlySet<string> = new Set(METADATA_OWNED_FIELDS);
const GRADING_SET: ReadonlySet<string> = new Set(GRADING_OWNED_FIELDS);

/**
 * TASK 7 · grading fields whose column is genuinely NUMERIC, so "10" and "10.0"
 * denote the same value. ONLY these get semantic numeric echo comparison.
 *
 * Deliberately EXCLUDED, and they must stay excluded:
 *   • gradeType / labelType / authStatus / graderStatus / gradingStatus — enums;
 *   • gradeManualOverride / darkBorder* — booleans (`grade_manual_override` is a
 *     real `boolean` column);
 *   • gradeApprovedAt / gradeApprovedBy / gradedAt / gradedBy /
 *     heavyDamageAcknowledgedAt — approval + provenance;
 *   • defects / aiDefects / verifiedDefects / aiDefectCandidates /
 *     operatorSubgrades / gradingReport / centeringPoints* / imageQualityChecks —
 *     JSON structures, where a numeric coercion would be meaningless;
 *   • wrinkleSeverity / tearSeverity / centeringMethod — severity/method labels,
 *     not proven numeric. Fail closed rather than guess.
 */
export const NUMERIC_GRADING_FIELDS = [
  "gradeOverall",
  "gradeCentering",
  "gradeCorners",
  "gradeEdges",
  "gradeSurface",
  "aiDraftGrade",
  "operatorGrade",
  "gradeStrengthScore",
  "creaseSpanPct",
  "eyeAppealModifier",
  "centeringFrontLr",
  "centeringFrontTb",
  "centeringBackLr",
  "centeringBackTb",
  "centeringOuterFront",
  "centeringOuterBack",
  "centeringInnerFront",
  "centeringInnerBack",
] as const;
const NUMERIC_GRADING_SET: ReadonlySet<string> = new Set(NUMERIC_GRADING_FIELDS);

/**
 * M-5 · THE SERVER-SIDE COMMITTED-KEY ALLOWLIST.
 *
 * `METADATA_OWNED_FIELDS` constrains what the CLIENT sends. It did not constrain
 * what the SERVER commits: the metadata route builds its update object through
 * convention — hard-coded `putGuarded(...)` calls, "OTHER"-companion
 * assignments, image-path assignments and an in-place merge from the structured
 * variant applier. Nothing stopped a future `putGuarded("gradeOverall")` from
 * quietly reintroducing exactly the defect PR A exists to remove.
 *
 * INVARIANT: every key the metadata route commits belongs to an explicit,
 * tightly named approved set. Deliberately a UNION of narrow sets rather than
 * one broad exception list, so each addition has to be justified in the set that
 * describes it.
 *
 *   METADATA_OWNED_FIELDS       — the client-editable metadata allowlist
 * ∪ IMAGE_OWNED_FIELDS          — derived from an uploaded image
 * ∪ STRUCTURED_METADATA_FIELDS  — derived by the structured rarity/variant picker
 * ∪ SERVER_DERIVED_METADATA_FIELDS — the documented server-derived remainder
 */
export const SERVER_DERIVED_METADATA_FIELDS = [
  // "OTHER" free-text companions. Not sent independently — the route derives
  // each from its GOVERNING field's submitted value, and nulls it otherwise.
  "rarityOther",
  "variantOther",
  "collectionOther",
] as const;

// Deduplicated: the structured picker's five INPUT columns (rarityCode,
// finishVariant, promoType, subsetName, era) are legitimately in both the
// client metadata allowlist and the structured set.
export const SERVER_METADATA_COMMIT_FIELDS: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...METADATA_OWNED_FIELDS,
    ...IMAGE_OWNED_FIELDS,
    ...STRUCTURED_METADATA_FIELDS,
    ...SERVER_DERIVED_METADATA_FIELDS,
  ]),
]);

const SERVER_COMMIT_SET: ReadonlySet<string> = new Set(SERVER_METADATA_COMMIT_FIELDS);

/** Keys in a would-be update object that are NOT server-approved for commit. */
export function unapprovedCommitKeys(data: Record<string, unknown>): string[] {
  if (!data || typeof data !== "object") return [];
  return Object.keys(data).filter((k) => !SERVER_COMMIT_SET.has(k));
}

/**
 * Fail CLOSED immediately before persistence. Throws rather than filtering: a
 * key outside the approved set means the route's own construction logic is
 * wrong, and silently dropping it would hide that. The metadata route catches
 * this and returns 500, so a mistake is loud in tests and in production logs
 * instead of becoming a silent grading write.
 */
export function assertServerMetadataCommitKeys(data: Record<string, unknown>): void {
  const bad = unapprovedCommitKeys(data);
  if (bad.length === 0) return;
  const grading = bad.filter((k) => canonicalGradingField(k) !== null);
  throw new Error(
    `Metadata route attempted to commit key(s) outside SERVER_METADATA_COMMIT_FIELDS: ${bad.join(", ")}.` +
      (grading.length
        ? ` ${grading.join(", ")} is grading-owned and must be written through PUT /api/admin/certificates/:id/grade.`
        : ` Add it to the set that describes it (metadata / image / structured / server-derived) if it is legitimate.`),
  );
}

export function isMetadataOwnedField(key: string): boolean {
  return METADATA_SET.has(key);
}

const CREATE_ONLY_SET: ReadonlySet<string> = new Set(CREATE_ONLY_FIELDS);

/** Keys the Card Details form never serialises — pure UI state. */
export const CERTIFICATE_FORM_UI_ONLY_KEYS = ["unifiedSelect", "otherText"] as const;
const UI_ONLY_SET: ReadonlySet<string> = new Set(CERTIFICATE_FORM_UI_ONLY_KEYS);

/**
 * May the Card Details form send this key? The single decision behind
 * `buildCertFormData`, extracted so it is provable at RUNTIME rather than by
 * grepping the component (hostile review H-1).
 */
export function isSendableCertificateFormKey(key: string, opts: { isEdit: boolean }): boolean {
  if (UI_ONLY_SET.has(key)) return false;
  if (isMetadataOwnedField(key)) return true;
  // Create-only fields ride along on POST and are NEVER sent on an UPDATE, so
  // an edit can neither change the kind nor silently re-link the submission.
  return !opts.isEdit && CREATE_ONLY_SET.has(key);
}

/**
 * The exact [key, value] pairs `buildCertFormData` appends, given a form object.
 * Null/undefined values are dropped exactly as the FormData builder drops them.
 */
export function certificateFormEntriesToSend(
  form: Record<string, unknown>,
  opts: { isEdit: boolean },
): Array<[string, string]> {
  return Object.entries(form ?? {})
    .filter(([k]) => isSendableCertificateFormKey(k, opts))
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k, String(v)] as [string, string]);
}

/**
 * The canonical grading column a request key refers to, or null when the key is
 * not grading-owned under ANY of its names.
 */
export function canonicalGradingField(key: string): GradingOwnedField | null {
  if (typeof key !== "string") return null;
  if (GRADING_SET.has(key)) return key as GradingOwnedField;
  // Belt AND braces (M-2): the map has a null prototype, and the lookup is
  // still an own-property test. Either alone would fix the inherited-key bug;
  // both together mean a future refactor back to an object literal cannot
  // silently reintroduce it. `constructor`, `toString`, `valueOf`,
  // `hasOwnProperty` and `__proto__` all return null here.
  if (!Object.prototype.hasOwnProperty.call(GRADING_FIELD_ALIASES, key)) return null;
  const canonical = GRADING_FIELD_ALIASES[key];
  // Final guard: only a value that is itself a declared grading-owned field is
  // ever returned, so an inherited or injected non-string can never leak out.
  return typeof canonical === "string" && GRADING_SET.has(canonical) ? canonical : null;
}

export function isGradingOwnedField(key: string): boolean {
  return canonicalGradingField(key) !== null;
}

/**
 * Grading-owned keys present in a request body, UNDER WHATEVER NAME the caller
 * used. The submitted name is returned (not the canonical one) so the error
 * names the key the client actually sent and is actionable.
 */
export function gradingFieldsIn(body: Record<string, unknown>): string[] {
  if (!body || typeof body !== "object") return [];
  return Object.keys(body).filter((k) => canonicalGradingField(k) !== null);
}

/**
 * Split the grading-owned keys in a request body into the ones that would
 * CHANGE stored grading state and the ones that merely echo it back.
 *
 * A harmless echo (older client posting the value it just read) is tolerated so
 * the boundary does not break clients that predate it — it still writes nothing,
 * because the route's update object is built from the metadata allowlist alone.
 *
 * FAILS CLOSED. When the canonical column is ABSENT from the stored row — which
 * happens for a real database column that shared/schema.ts does not declare, so
 * a Drizzle-selected row has no such property (`authStatus`) — a submitted
 * non-empty value is treated as a CHANGE and rejected. It is never assumed to
 * match.
 *
 * @param body     the request body
 * @param stored   the certificate row as read before the write
 */
export function gradingFieldChanges(
  body: Record<string, unknown>,
  stored: Record<string, unknown>,
): { submitted: string[]; changing: string[] } {
  const submitted = gradingFieldsIn(body);
  const changing = submitted.filter((key) => {
    const canonical = canonicalGradingField(key) as GradingOwnedField;
    const posted = normaliseEcho(body[key]);
    if (!Object.prototype.hasOwnProperty.call(stored ?? {}, canonical)) {
      // Cannot prove this is an echo — only an empty submission is harmless.
      return posted !== "";
    }
    const current = normaliseEcho(stored[canonical]);
    if (posted === current) return false;
    // TASK 7 · OPTION A, NARROWLY SCOPED. For the grading fields whose column is
    // genuinely NUMERIC, "10" and "10.0" are the SAME grade — Postgres `numeric`
    // returns "10.0" while the workstation posts "10", so a string comparison
    // rejected a save that changed nothing. Semantic equality is applied ONLY to
    // the fields in NUMERIC_GRADING_FIELDS, and only when BOTH sides parse as
    // finite numbers. Everything else keeps the strict string comparison:
    // grade type, label type, auth status, the boolean gradeManualOverride, the
    // approval timestamps, provenance and every JSON defect structure.
    if (NUMERIC_GRADING_SET.has(canonical)) {
      const a = Number(posted);
      const b = Number(current);
      // "" and "abc" are NOT numbers — `Number("")` is 0, which would make a
      // stored 0 look equal to a cleared value. Require a non-empty numeric
      // literal on BOTH sides before comparing numerically.
      if (posted !== "" && current !== "" && Number.isFinite(a) && Number.isFinite(b)) {
        return a !== b;
      }
    }
    return true;
  });
  return { submitted, changing };
}

/** Shared value normalisation for echo comparison. Exported for its tests. */
export function normaliseEcho(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

/**
 * The error the metadata route returns when a caller submits grading-owned
 * state. Named so the message is identical in the route and in its tests.
 */
export function gradingFieldContractError(fields: string[]): string {
  return (
    `This endpoint owns certificate metadata only and cannot change grading state. ` +
    `Rejected grading-owned field(s): ${fields.join(", ")}. ` +
    `Grading changes must go through the grading route (PUT /api/admin/certificates/:id/grade).`
  );
}
