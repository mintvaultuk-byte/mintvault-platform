/**
 * ONE source of truth for the locked NO / authentication-only business rule
 * (owner-approved 2026-07-25).
 *
 * THE RULE
 *   A certificate is either NUMERIC or AUTHENTICATION-ONLY (NO / AA). Which one it is
 *   belongs to the canonical stored record, never to a request body.
 *     • Normal APPROVAL may never change the kind — not in either direction, ever.
 *     • A published (approved) certificate's kind may not be changed by ordinary grading
 *       or editing routes at all; that requires Super Admin Correction Mode, which is
 *       explicit, separately confirmed and audited.
 *     • Setting the kind on a certificate that has never been approved is ordinary
 *       grading work, not a conversion, and stays allowed — otherwise a card could never
 *       be graded authentication-only in the first place.
 *
 * WHY THIS FILE EXISTS
 *   The first implementation of this rule was applied to two approval routes but only
 *   half-applied to the autosave route, which left a one-key body able to convert a LIVE
 *   published numeric certificate and null its grade and all four sub-grades. Five
 *   separate handlers write `certificates.grade_type`; each had its own ad-hoc derivation.
 *   Centralising the decision here is what stops them drifting apart again.
 *
 * Pure comparison and normalisation only — no scoring, weighting or formula logic, and
 * nothing here reads or writes a database.
 */

/** Every value the column is allowed to hold. `not_original` is the legacy long form of
 *  NO, `authentic_altered` of AA — both are still present in historical rows. */
export const CANONICAL_GRADE_TYPES = ["numeric", "NO", "AA", "not_original", "authentic_altered"] as const;
export type CanonicalGradeType = (typeof CANONICAL_GRADE_TYPES)[number];

/** The two kinds a certificate can be. */
export type GradeKind = "numeric" | "NO" | "AA";

/**
 * Coerce anything to a legal grade_type. Unrecognised junk becomes "numeric" rather than
 * being written back verbatim: `grade_type` is plain `text` with no CHECK constraint, and
 * one write path historically persisted an unvalidated body value, so junk is reachable.
 * Perpetuating it would leak into the public population labels, which emit the raw column.
 */
export function normaliseGradeType(value: unknown): CanonicalGradeType {
  const v = value == null ? "" : String(value).trim();
  return (CANONICAL_GRADE_TYPES as readonly string[]).includes(v) ? (v as CanonicalGradeType) : "numeric";
}

/** Which kind a stored/requested grade_type represents. Legacy long forms collapse onto
 *  their short form, because NO and AA are genuinely different printed outcomes but
 *  `not_original` and `NO` are the same outcome spelled two ways. */
export function kindOfGradeType(gradeType: unknown): GradeKind {
  const v = normaliseGradeType(gradeType);
  if (v === "AA" || v === "authentic_altered") return "AA";
  if (v === "NO" || v === "not_original") return "NO";
  return "numeric";
}

/** Kind implied by a client-sent `overall_grade` ("NO"/"AA" are the only non-numeric
 *  tokens the grading client sends; anything else means "numeric"). Deliberately exact —
 *  "no", " NO " and "not_original" are NOT accepted here, so a sloppy or hostile body
 *  cannot smuggle a kind change through. */
export function kindOfOverallGrade(overallGrade: unknown): GradeKind {
  if (overallGrade === "AA") return "AA";
  if (overallGrade === "NO") return "NO";
  return "numeric";
}

export interface KindChangeCheck {
  /** grade_type currently stored on the certificate. */
  storedGradeType: unknown;
  /** Kind the request is asking for. */
  requestedKind: GradeKind;
  /** True when the certificate is already published (grade_approved_at set). */
  isApproved: boolean;
  /**
   * false for approval routes: approval may NEVER change the kind, approved or not.
   * true for draft/edit routes: setting the kind on an unapproved certificate is
   * ordinary grading work.
   */
  allowChangeWhenUnapproved: boolean;
}

/**
 * Decide whether a request may set this kind. Returns an operator-facing message to
 * reject with, or null to allow.
 *
 * Fails closed: anything other than an exact kind match is refused unless it is
 * explicitly permitted grading work on an unapproved record.
 */
export function rejectKindChange(check: KindChangeCheck): string | null {
  const storedKind = kindOfGradeType(check.storedGradeType);
  if (storedKind === check.requestedKind) return null;

  if (check.allowChangeWhenUnapproved && !check.isApproved) return null;

  const conversionRoute =
    "To change a published certificate between numeric and authentication-only, use Super Admin Correction Mode — " +
    "it records the reason and keeps a full audit trail.";

  if (check.allowChangeWhenUnapproved) {
    // Draft/edit route on an already-published certificate.
    return storedKind === "numeric"
      ? `This certificate is published with a numeric grade. Saving it as authentication-only would change its type. ${conversionRoute}`
      : `This certificate is published as authentication-only. Saving it with a numeric grade would change its type. ${conversionRoute}`;
  }

  // Approval route: never permitted, regardless of approval state.
  if (storedKind === "numeric") {
    return (
      "This is a numeric certificate. Approving cannot convert it to authentication-only (NO/AA). " +
      "Set the authentication result in the grading workstation and save before approving, " +
      "or use Super Admin Correction Mode for a certificate that is already published."
    );
  }
  if (check.requestedKind === "numeric") {
    return (
      "This certificate is authentication-only. Approving cannot give it a numeric grade — that would change its type. " +
      conversionRoute
    );
  }
  return (
    "Approving cannot switch an authentication-only certificate between NO and AA. " +
    "Change it in the grading workstation and save before approving, or use Super Admin Correction Mode."
  );
}

/**
 * The grade_type value a write should persist.
 *  • kinds match  → keep the STORED value verbatim, so a legacy long form is never
 *    silently normalised into its short form by an unrelated save.
 *  • kinds differ (already permitted by rejectKindChange) → the canonical short form of
 *    the requested kind.
 * Junk stored values are normalised to "numeric" rather than written back.
 */
export function gradeTypeToPersist(storedGradeType: unknown, requestedKind: GradeKind): CanonicalGradeType {
  const stored = normaliseGradeType(storedGradeType);
  return kindOfGradeType(stored) === requestedKind ? stored : requestedKind;
}
