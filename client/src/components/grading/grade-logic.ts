/**
 * Client-side grade calculation logic.
 * Mirrors server/grade-calculator.ts exactly — keep in sync.
 */

export interface SubGrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

export function calculateOverallGrade(sub: SubGrades, hasCrease: boolean, hasTear: boolean): number {
  const weighted = sub.centering * 0.1 + sub.corners * 0.25 + sub.edges * 0.25 + sub.surface * 0.4;
  let grade = Math.round(weighted);
  const lowest = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);
  grade = Math.min(grade, lowest + 1.0);
  if (hasCrease) grade = Math.min(grade, 5);
  if (hasTear) grade = Math.min(grade, 3);
  return Math.max(1, Math.min(10, grade));
}

export function getGradeLabel(grade: number | string): string {
  if (grade === "AA") return "AUTHENTIC ALTERED";
  if (grade === "NO") return "NOT ORIGINAL";
  const g = typeof grade === "string" ? parseFloat(grade) : grade;
  if (g >= 10) return "GEM MINT";
  if (g >= 9) return "MINT";
  if (g >= 8) return "NM-MT";
  if (g >= 7) return "NM";
  if (g >= 6) return "EX-MT";
  if (g >= 5) return "EX";
  if (g >= 4) return "VG-EX";
  if (g >= 3) return "VG";
  if (g >= 2) return "GOOD";
  return "PR";
}

// Deduction keys that represent real card defects. A Pristine 10P (black
// label) card must have ZERO of these — eye_appeal is a subjective modifier,
// not a defect, so it is intentionally excluded.
const DEFECT_DEDUCTION_KEYS = ["centering_front", "centering_back", "corners", "edges", "surface"] as const;

/**
 * Pristine 10P (black label) gate. Requires BOTH:
 *  - overall 10 and all four subgrades 10, AND
 *  - when `deductions` is supplied, zero raw deduction in every defect
 *    category. A card with e.g. corners -1.5 / edges -1.25 buckets to a 10
 *    chip but is NOT flawless, so it must not wear the Pristine badge. Pass
 *    computeMvgsScore(...).deductions to enforce this; omit it for the legacy
 *    subgrades-only check.
 */
export function isBlackLabel(sub: SubGrades, overall: number, deductions?: Record<string, number>): boolean {
  const subsAllTen =
    overall === 10 && sub.centering === 10 && sub.corners === 10 && sub.edges === 10 && sub.surface === 10;
  if (!subsAllTen) return false;
  if (!deductions) return true;
  return DEFECT_DEDUCTION_KEYS.every((k) => !((deductions[k] ?? 0) < 0));
}

// ── Centering ─────────────────────────────────────────────────────────────
// The MVGS centering calculator and the legacy getCenteringGrade() lenient
// mapping that used to live here were removed in the PSA-consolidation change.
// Centering now has a single source of truth — shared/centering.ts
// (centeringAxisGrade / centeringSubgrade) — consumed by the score, the
// displayed subgrade, the locked chip, and the public /standard page alike.
