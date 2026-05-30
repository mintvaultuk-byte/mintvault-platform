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
