/**
 * The pre-MVGS ("legacy") grading fallback — ONE implementation, shared.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The MVGS engine (shared/mvgs-scoring.ts) scores from CLASSIFIED DEFECT PINS. When a card
 * has no MVGS-classified pin, the grading workstation does NOT use the engine's headline
 * grade: it falls back to the per-zone steppers (corner/edge dropdowns) and a weighted
 * average. See client/src/components/grading/grading-panel.tsx:
 *
 *     const mvgsGrade = hasMvgsPins && … ? gradeFromMvgsScore(mvgsForOverall.score) : null;
 *     const overall   = mvgsGrade ?? calculateOverallGrade(sub, surface.hasCrease, surface.hasTear);
 *
 * That fallback used to live ONLY inside three React component modules, so the server had
 * no way to reach it. The partner adapter needs it — a partner operator grading with the
 * zone steppers and no pins must get the SAME grade an HQ operator gets from the same
 * evidence. The functions have therefore been MOVED here verbatim and are re-exported from
 * their original modules, so there is still exactly one implementation and every existing
 * client import path keeps working.
 *
 * NOTHING WAS CHANGED IN THE MOVE. No weight, no threshold, no rounding, no sentinel, no
 * ceiling. `calculateOverallGrade` still sources its structural ceiling from the engine via
 * `legacyCeilingForFlags`, which remains the single source of truth for crease/tear caps.
 */

import { legacyCeilingForFlags } from "./mvgs-scoring";

/** Per-corner operator steppers. 0 is the "unset" sentinel (the UI shows "—"). */
export interface CornerValues {
  frontTL: number;
  frontTR: number;
  frontBL: number;
  frontBR: number;
  backTL: number;
  backTR: number;
  backBL: number;
  backBR: number;
}

/** Per-edge operator steppers. 0 is the "unset" sentinel (the UI shows "—"). */
export interface EdgeValues {
  frontTop: number;
  frontBottom: number;
  frontLeft: number;
  frontRight: number;
  backTop: number;
  backBottom: number;
  backLeft: number;
  backRight: number;
}

export interface SubGrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

export function calcCornerSubgrade(v: CornerValues): { grade: number; worstKey: string } {
  const entries: [string, number][] = [
    ["Front Top-Left", v.frontTL],
    ["Front Top-Right", v.frontTR],
    ["Front Bottom-Left", v.frontBL],
    ["Front Bottom-Right", v.frontBR],
    ["Back Top-Left", v.backTL],
    ["Back Top-Right", v.backTR],
    ["Back Bottom-Left", v.backBL],
    ["Back Bottom-Right", v.backBR],
  ];
  // 0 is the "unset" sentinel (dropdown shows "—"; the minimum real grade is 1).
  // Option A — full marks by default: a card with NO zone marked carries no
  // recorded deduction, so it scores a perfect 10 and a flawless Pristine 10
  // finalizes without forcing the grader to type 10 into all eight zones.
  // Grading is deduction-driven: mark a specific zone LOWER and the subgrade
  // follows the worst MARKED zone (partial input still scores that zone, not 0).
  const set = entries.filter(([, g]) => g > 0);
  if (set.length === 0) return { grade: 10, worstKey: "" };
  const worst = set.reduce((a, b) => (a[1] <= b[1] ? a : b));
  return { grade: worst[1], worstKey: worst[0] };
}

export function calcEdgeSubgrade(v: EdgeValues): { grade: number; worstKey: string } {
  const entries: [string, number][] = [
    ["Front Top", v.frontTop],
    ["Front Bottom", v.frontBottom],
    ["Front Left", v.frontLeft],
    ["Front Right", v.frontRight],
    ["Back Top", v.backTop],
    ["Back Bottom", v.backBottom],
    ["Back Left", v.backLeft],
    ["Back Right", v.backRight],
  ];
  // Full marks by default — see calcCornerSubgrade. 0 = "unset" sentinel; no zone
  // marked = no recorded deduction = perfect 10; deduct by marking a zone lower.
  const set = entries.filter(([, g]) => g > 0);
  if (set.length === 0) return { grade: 10, worstKey: "" };
  const worst = set.reduce((a, b) => (a[1] <= b[1] ? a : b));
  return { grade: worst[1], worstKey: worst[0] };
}

/**
 * Weighted-average + lowest-subgrade-floor calculation for non-MVGS-classified
 * cards (the fallback path when no MVGS pins exist yet). Structural ceilings
 * (crease / tear) now flow through the engine via `legacyCeilingForFlags`
 * — this helper no longer carries its own crease/tear numbers per MVGS-v2
 * §5 single-source-of-truth requirement. Phase 2 swaps the boolean flags for
 * measurement-driven inputs at the call sites.
 */
export function calculateOverallGrade(sub: SubGrades, hasCrease: boolean, hasTear: boolean): number {
  const weighted = sub.centering * 0.1 + sub.corners * 0.25 + sub.edges * 0.25 + sub.surface * 0.4;
  let grade = Math.round(weighted);
  const lowest = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);
  grade = Math.min(grade, lowest + 1.0);
  // Structural ceiling sourced from the engine — single source of truth.
  const ceiling = legacyCeilingForFlags({ hasCrease, hasTear });
  if (ceiling) grade = Math.min(grade, ceiling.grade);
  return Math.max(1, Math.min(10, grade));
}
