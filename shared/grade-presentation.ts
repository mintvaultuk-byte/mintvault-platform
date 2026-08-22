/**
 * MVGS grade PRESENTATION — the client-safe half of the grading vocabulary.
 *
 * WHY THIS MODULE EXISTS
 * ==========================================================================
 * `shared/schema.ts` is a barrel: it holds the complete Drizzle database
 * schema (~40 `pgTable(...)` calls) AND the handful of grade constants the
 * browser legitimately needs to RENDER a grade. A `pgTable(...)` call is a
 * side-effectful module-scope expression, so a bundler cannot tree-shake it —
 * which meant ONE value import from the barrel in an eagerly-loaded public
 * page (`pages/home.tsx` taking `pricingTiers`) shipped every internal
 * database column name, and the engine module the barrel imported, to every
 * unauthenticated visitor in the entry chunk.
 *
 * THE BOUNDARY
 * ==========================================================================
 * This file is a LEAF. It imports nothing — no Drizzle, no database schema,
 * and above all no scoring engine. It carries only what a browser needs to
 * DISPLAY an authoritative result the server already decided:
 *
 *   • the published grade ladder (NUMERIC_GRADES / NON_NUMERIC_GRADES)
 *   • validation of a grade VALUE against that ladder
 *   • grade -> abbreviation and grade -> tier name, both published at /standard
 *
 * It carries NO proprietary calculation. Deduction weights, centering bands,
 * the floor rule, structural ceilings, calibration and the Pristine gate all
 * stay in the server-only engine and must never be imported from here or by
 * any client module. The browser is told WHAT the grade is; it is never told
 * HOW the grade was reached.
 *
 * `mvgsTierName` lives HERE rather than in the engine deliberately: it is a
 * grade -> name lookup over the published band table, not scoring. Keeping it
 * here is what lets `shared/schema.ts` stop importing `shared/mvgs-scoring.ts`
 * at all. The engine re-exports it so existing server call sites are unchanged
 * and there is still exactly ONE definition — duplicating this ladder is what
 * the v1.4 reconciliation had to undo elsewhere, and must not be repeated.
 */

export const NUMERIC_GRADES = [
  { value: 10, label: "GEM MT", description: "Gem Mint" },
  { value: 9.5, label: "MINT+", description: "Mint+" },
  { value: 9, label: "MINT", description: "Mint" },
  { value: 8.5, label: "NM-MT+", description: "NM-Mint+" },
  { value: 8, label: "NM-MT", description: "Near Mint-Mint" },
  { value: 7.5, label: "NM+", description: "NM+" },
  { value: 7, label: "NM", description: "Near Mint" },
  { value: 6.5, label: "EX-MT+", description: "EX-Mint+" },
  { value: 6, label: "EX-MT", description: "Excellent-Mint" },
  { value: 5.5, label: "EX+", description: "Excellent+" },
  { value: 5, label: "EX", description: "Excellent" },
  { value: 4.5, label: "VG-EX+", description: "VG-EX+" },
  { value: 4, label: "VG-EX", description: "Very Good-Excellent" },
  { value: 3.5, label: "VG+", description: "VG+" },
  { value: 3, label: "VG", description: "Very Good" },
  { value: 2.5, label: "GOOD+", description: "Good+" },
  { value: 2, label: "GOOD", description: "Good" },
  { value: 1.5, label: "FAIR", description: "Fair" },
  { value: 1, label: "PR", description: "Poor" },
] as const;

export const NON_NUMERIC_GRADES = [
  { value: "NO", label: "AUTHENTIC", description: "Authentic Only" },
  { value: "AA", label: "AUTHENTIC ALTERED", description: "Authentic Altered" },
] as const;

// The complete set of valid MVGS overall grades — whole grades 1–10 plus the
// half grades (1.5, 2.5, … 9.5). Single source of truth for grade validation
// on both client and server; derived from NUMERIC_GRADES so it can never drift.
export const NUMERIC_GRADE_VALUES: readonly number[] = NUMERIC_GRADES.map((g) => g.value);

/** True if `grade` is one of the permitted MVGS numeric grades (incl. half grades). */
export function isValidNumericGrade(grade: number): boolean {
  return Number.isFinite(grade) && NUMERIC_GRADE_VALUES.includes(grade);
}

export function isNonNumericGrade(gradeType: string): boolean {
  // Accept the legacy long-form aliases that some grade write-paths persisted
  // ("not_original" == NO / Authentic, "authentic_altered" == AA) so cert pages,
  // /verify, search, labels and PDFs classify those certs correctly. New writes
  // should use the canonical "NO"/"AA"; normalising the write-paths + a data
  // backfill is the follow-up that lets these aliases be removed again.
  return gradeType === "NO" || gradeType === "AA" || gradeType === "not_original" || gradeType === "authentic_altered";
}

export function gradeLabel(grade: number): string {
  if (grade >= 10) return "GEM MT";
  if (grade >= 9.5) return "MINT+";
  if (grade >= 9) return "MINT";
  if (grade >= 8.5) return "NM-MT+";
  if (grade >= 8) return "NM-MT";
  if (grade >= 7.5) return "NM+";
  if (grade >= 7) return "NM";
  if (grade >= 6.5) return "EX-MT+";
  if (grade >= 6) return "EX-MT";
  if (grade >= 5.5) return "EX+";
  if (grade >= 5) return "EX";
  if (grade >= 4.5) return "VG-EX+";
  if (grade >= 4) return "VG-EX";
  if (grade >= 3.5) return "VG+";
  if (grade >= 3) return "VG";
  if (grade >= 2.5) return "GOOD+";
  if (grade >= 2) return "GOOD";
  if (grade >= 1.5) return "FAIR";
  if (grade >= 1) return "PR";
  return "";
}

export function gradeLabelFull(gradeType: string, gradeOverall: string): string {
  if (gradeType === "NO" || gradeType === "not_original") return "AUTHENTIC";
  if (gradeType === "AA" || gradeType === "authentic_altered") return "AUTHENTIC ALTERED";
  // Tier NAME from the exact grade via the canonical MVGS tier table — no
  // rounding, so half grades read their TRUE tier (8.5 → "NM-MINT+", 9.5 →
  // "MINT+") and agree with the displayed number. Same source the cert page,
  // slab, PDF and logbook use. (The numeric VALUE is rendered separately by
  // callers; this returns the name only.)
  const g = parseFloat(gradeOverall);
  if (!Number.isFinite(g)) return "";
  return mvgsTierName(g).toUpperCase();
}

/**
 * MVGS tier NAME for a numeric 1-10 grade (no score, no trailing number).
 * Single source of truth for grade→name on the physical slab and the cert
 * page, so the two can never disagree. Mirrors gradeLabelForScore /
 * gradeFromMvgsScore but keyed by the grade itself, so a half-grade renders
 * its TRUE tier instead of being rounded up into the next whole tier.
 * Callers uppercase as needed.
 */
export function mvgsTierName(grade: number): string {
  if (grade >= 10) return "Gem Mint";
  if (grade >= 9.5) return "Mint+";
  if (grade >= 9) return "Mint";
  if (grade >= 8.5) return "NM-Mint+";
  if (grade >= 8) return "NM-Mint";
  if (grade >= 7.5) return "NM+";
  if (grade >= 7) return "Near Mint";
  if (grade >= 6.5) return "EX-Mint+";
  if (grade >= 6) return "EX-Mint";
  if (grade >= 5.5) return "Excellent+";
  if (grade >= 5) return "Excellent";
  if (grade >= 4.5) return "VG-EX+";
  if (grade >= 4) return "VG-EX";
  if (grade >= 3.5) return "VG+";
  if (grade >= 3) return "Very Good";
  if (grade >= 2.5) return "Good+";
  if (grade >= 2) return "Good";
  if (grade >= 1.5) return "Fair";
  return "Poor";
}
