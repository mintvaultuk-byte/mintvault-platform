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
  "centeringScore",
  "cornersScore",
  "edgesScore",
  "surfaceScore",
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
  "gradeManualOverride",
  // Approval state
  "gradeApprovedBy",
  "gradeApprovedAt",
  "gradedAt",
  "gradedBy",
  "graderStatus",
] as const;

export type MetadataOwnedField = (typeof METADATA_OWNED_FIELDS)[number];
export type GradingOwnedField = (typeof GRADING_OWNED_FIELDS)[number];

const METADATA_SET: ReadonlySet<string> = new Set(METADATA_OWNED_FIELDS);
const GRADING_SET: ReadonlySet<string> = new Set(GRADING_OWNED_FIELDS);

export function isMetadataOwnedField(key: string): boolean {
  return METADATA_SET.has(key);
}

export function isGradingOwnedField(key: string): boolean {
  return GRADING_SET.has(key);
}

/**
 * Grading-owned keys present in a request body. Used by the metadata route to
 * produce an explicit contract error instead of silently ignoring them.
 */
export function gradingFieldsIn(body: Record<string, unknown>): string[] {
  if (!body || typeof body !== "object") return [];
  return GRADING_OWNED_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
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
