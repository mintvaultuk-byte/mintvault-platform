/**
 * Client-side grade calculation logic.
 * Mirrors server/grade-calculator.ts exactly — keep in sync.
 */

// The zone-stepper sub-grade calculators and the weighted fallback formula MOVED to
// shared/legacy-grade-fallback.ts so the server-authoritative partner adapter can run the
// identical maths. Re-exported here unchanged — one implementation, every caller intact.
export type { SubGrades, CornerValues, EdgeValues } from "@shared/legacy-grade-fallback";
export { calculateOverallGrade, calcCornerSubgrade, calcEdgeSubgrade } from "@shared/legacy-grade-fallback";

export function getGradeLabel(grade: number | string): string {
  if (grade === "AA") return "AUTHENTIC ALTERED";
  if (grade === "NO") return "NOT ORIGINAL";
  const g = typeof grade === "string" ? parseFloat(grade) : grade;
  if (g >= 10) return "GEM MINT";
  if (g >= 9.5) return "MINT+";
  if (g >= 9) return "MINT";
  if (g >= 8.5) return "NM-MT+";
  if (g >= 8) return "NM-MT";
  if (g >= 7.5) return "NM+";
  if (g >= 7) return "NM";
  if (g >= 6.5) return "EX-MT+";
  if (g >= 6) return "EX-MT";
  if (g >= 5.5) return "EX+";
  if (g >= 5) return "EX";
  if (g >= 4.5) return "VG-EX+";
  if (g >= 4) return "VG-EX";
  if (g >= 3.5) return "VG+";
  if (g >= 3) return "VG";
  if (g >= 2.5) return "GOOD+";
  if (g >= 2) return "GOOD";
  if (g >= 1.5) return "FAIR";
  return "PR";
}

// Pristine 10P (black label) gate now lives in shared/ as the single source of
// truth shared by this grade panel and BOTH server approve routes. Re-exported
// here so the existing `isBlackLabel` import path in grading-panel.tsx keeps
// working unchanged. SubGrades (above) is structurally compatible with the
// shared PristineSubgrades, so callers pass it straight through.
export { isBlackLabel, isPristine, DEFECT_DEDUCTION_KEYS } from "@shared/pristine";

// ── Centering ─────────────────────────────────────────────────────────────
// The MVGS centering calculator and the legacy getCenteringGrade() lenient
// mapping that used to live here were removed in the PSA-consolidation change.
// Centering now has a single source of truth — shared/centering.ts
// (centeringAxisGrade / centeringSubgrade) — consumed by the score, the
// displayed subgrade, the locked chip, and the public /standard page alike.
