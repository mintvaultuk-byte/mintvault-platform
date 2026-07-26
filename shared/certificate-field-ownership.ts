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
] as const;
// NOTE: an earlier revision of this file listed "gradeManualOverride" and
// "centeringScore"/"cornersScore"/"edgesScore"/"surfaceScore" as owned keys.
// `gradeManualOverride` matches NO column, request key or client field anywhere
// in the repository — it was invented, and has been removed. The four *Score
// names ARE real, but they are the DATABASE column names for gradeCentering /
// gradeCorners / gradeEdges / gradeSurface, not separate fields; listing them
// here compared a submitted value against an always-undefined property. They
// are now declared as aliases below, where they resolve to the real column.

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
 */
export const GRADING_FIELD_ALIASES: Readonly<Record<string, GradingOwnedField>> = {
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
};

export type MetadataOwnedField = (typeof METADATA_OWNED_FIELDS)[number];
export type GradingOwnedField = (typeof GRADING_OWNED_FIELDS)[number];

const METADATA_SET: ReadonlySet<string> = new Set(METADATA_OWNED_FIELDS);
const GRADING_SET: ReadonlySet<string> = new Set(GRADING_OWNED_FIELDS);

export function isMetadataOwnedField(key: string): boolean {
  return METADATA_SET.has(key);
}

/**
 * The canonical grading column a request key refers to, or null when the key is
 * not grading-owned under ANY of its names.
 */
export function canonicalGradingField(key: string): GradingOwnedField | null {
  if (GRADING_SET.has(key)) return key as GradingOwnedField;
  return GRADING_FIELD_ALIASES[key] ?? null;
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
  const norm = (v: unknown) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v).trim();
  };
  const changing = submitted.filter((key) => {
    const canonical = canonicalGradingField(key) as string;
    const posted = norm(body[key]);
    if (!Object.prototype.hasOwnProperty.call(stored ?? {}, canonical)) {
      // Cannot prove this is an echo — only an empty submission is harmless.
      return posted !== "";
    }
    return posted !== norm(stored[canonical]);
  });
  return { submitted, changing };
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
