/**
 * MVGS (MintVault Grading Standard) — pure scoring helper.
 *
 * Lives in shared/ so both sides import the same code:
 *   server: `import { computeMvgsScore } from "./mvgs-scoring"`
 *           (via server/mvgs-scoring.ts re-export shim)
 *   client: `import { computeMvgsScore } from "@shared/mvgs-scoring"`
 *
 * Inputs: centering ratios (string form "55/45"), classified defect pins,
 * dark-border flag, eye-appeal modifier. Output: integer score 1–100,
 * grade label, breakdown of deductions for explainability.
 *
 * Pure function — no DB, no env, no React. Safe to call in render.
 *
 * Deduction tables and grade brackets follow the MVGS spec exactly:
 *   - Centering front bucket (worst of LR vs TB), 0..-20
 *   - Centering back bucket  (worst of LR vs TB), 0..-5
 *   - Corner defects: D1 -4/-2, D2 -0.5/-0.25, D3 0 (front/back),
 *     capped at -25 total
 *   - Edge defects: D1 -3/-2, D2 -0.5/-0.25, D3 0 (front/back),
 *     capped at -25 total
 *     · Dark border + WH (whitening): multiply that defect's deduction ×1.25
 *   - Surface defects in zones FA/FH/FB/BA/BB by mvgsCode + tier,
 *     capped at -25 total
 *     · D2 surface weights: PL -0.5, PS -0.25, PI -0.5, SC -0.5, WH -0.5
 *     · CR D1 (crease) sets a hard cap of 74 on the final score
 *     · SP D1 in art/holo zone (FA/FH) multiplies ×1.5
 *     · Back-surface zones (BA/BB) multiply final deduction ×0.5 —
 *       matches the published MVGS standard's lenient back treatment
 *   - Eye appeal modifier added last, clamped ±2
 *   - Final clamped 1..100, then lowest-subgrade floor rule applies:
 *     · per-category subgrades derived from deductions (25-pt budget each)
 *     · cap headline grade at lowest single subgrade (+0.5 when variance is high)
 *     · cappedScore sits at top of the next-up label bracket
 */

export interface MvgsDefect {
  tier: string;       // "D1" | "D2" | "D3"
  mvgsCode: string;
  zone: string;       // one of the 20 zone codes
}

export interface MvgsInput {
  centeringFrontLr: string | null;   // "55/45"
  centeringFrontTb: string | null;
  centeringBackLr: string | null;
  centeringBackTb: string | null;
  defects: MvgsDefect[];
  darkBorder: boolean;
  eyeAppealModifier: number;         // -2..+2
}

export interface MvgsResult {
  score: number;                     // 1..100, integer
  grade: string;                     // e.g. "Gem Mint 10"
  deductions: Record<string, number>; // breakdown, signed (always ≤ 0)
}

// ── Centering deduction tables ────────────────────────────────────────────
// Buckets are by "larger side" — for "55/45" the bigger value is 55.
// Brackets per spec.

function centeringFrontDeduction(ratio: string | null): number {
  const bigger = parseBigger(ratio);
  if (bigger == null) return 0;
  if (bigger <= 55) return 0;
  if (bigger <= 60) return -2;
  if (bigger <= 65) return -5;
  if (bigger <= 70) return -8;
  if (bigger <= 75) return -12;
  if (bigger <= 80) return -15;
  if (bigger <= 85) return -18;
  return -20;
}

function centeringBackDeduction(ratio: string | null): number {
  const bigger = parseBigger(ratio);
  if (bigger == null) return 0;
  if (bigger <= 75) return 0;
  if (bigger <= 85) return -1;
  if (bigger <= 90) return -3;
  return -5;
}

function parseBigger(ratio: string | null): number | null {
  if (!ratio) return null;
  const parts = ratio.split("/").map((s) => Number(String(s).trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return Math.max(parts[0], parts[1]);
}

// ── Zone classifiers ──────────────────────────────────────────────────────

const FRONT_CORNER_ZONES = new Set(["FC1", "FC2", "FC3", "FC4"]);
const BACK_CORNER_ZONES  = new Set(["BC1", "BC2", "BC3", "BC4"]);
const FRONT_EDGE_ZONES   = new Set(["FE1", "FE2", "FE3", "FE4"]);
const BACK_EDGE_ZONES    = new Set(["BE1", "BE2", "BE3", "BE4"]);
const FRONT_SURFACE_ZONES = new Set(["FA", "FH", "FB"]);
const BACK_SURFACE_ZONES  = new Set(["BA", "BB"]);
const FRONT_ART_HOLO_ZONES = new Set(["FA", "FH"]);

// ── Per-defect deduction logic ────────────────────────────────────────────

function cornerDeduction(d: MvgsDefect): number {
  const isFront = FRONT_CORNER_ZONES.has(d.zone);
  const isBack  = BACK_CORNER_ZONES.has(d.zone);
  if (!isFront && !isBack) return 0;
  if (d.tier === "D1") return isFront ? -4    : -2;
  if (d.tier === "D2") return isFront ? -0.5  : -0.25;
  if (d.tier === "D3") return 0;  // Factory — documented only, no deduction.
  return 0;
}

function edgeDeduction(d: MvgsDefect, darkBorder: boolean): number {
  const isFront = FRONT_EDGE_ZONES.has(d.zone);
  const isBack  = BACK_EDGE_ZONES.has(d.zone);
  if (!isFront && !isBack) return 0;
  let base = 0;
  if (d.tier === "D1")      base = isFront ? -3   : -2;
  else if (d.tier === "D2") base = isFront ? -0.5 : -0.25;
  // D3: Factory — documented only, no deduction (matches the published
  // standard at /standard). Falling through to return 0 here also skips
  // the dark-border WH multiplier below, which is correct: 0 × 1.25 = 0.
  else return 0;
  // Dark-border + WH multiplier applies to whatever base the tier produced
  // (D1/D2 only after the D3-returns-zero change above).
  if (darkBorder && d.mvgsCode === "WH") base = base * 1.25;
  return base;
}

interface SurfaceOutcome {
  deduction: number;
  forceCap74: boolean;   // CR D1 crease triggers a hard 74 cap
}

function surfaceDeduction(d: MvgsDefect): SurfaceOutcome {
  const isFrontSurf = FRONT_SURFACE_ZONES.has(d.zone);
  const isBackSurf  = BACK_SURFACE_ZONES.has(d.zone);
  if (!isFrontSurf && !isBackSurf) return { deduction: 0, forceCap74: false };

  let raw = 0;
  let forceCap74 = false;

  if (d.tier === "D1") {
    switch (d.mvgsCode) {
      case "SP":
        raw = -4;
        // ×1.5 applies ONLY on the front art/holo zones (FA/FH). A back-
        // surface SP (BA/BB) skips this bonus and falls through to the
        // back-side ×0.5 multiplier at exit instead.
        if (FRONT_ART_HOLO_ZONES.has(d.zone)) raw = raw * 1.5;
        break;
      case "CR": raw = -10; forceCap74 = true; break;
      case "SC": raw = -2;  break;
      case "SV": raw = -3;  break;
      case "ST": raw = -2;  break;
      case "GL": raw = -4;  break;
    }
  } else if (d.tier === "D2") {
    switch (d.mvgsCode) {
      case "PL": raw = -0.5;  break;
      case "PS": raw = -0.25; break;
      case "PI": raw = -0.5;  break;
      case "SC": raw = -0.5;  break;
      // WH (whitening) on a surface zone — added in the D2 weight update.
      // Distinct from WH on an edge zone, which routes through
      // edgeDeduction and gets the dark-border ×1.25 multiplier.
      case "WH": raw = -0.5;  break;
    }
  }
  // D3 or unknown codes leave raw=0 → returns 0 below.

  // Back-surface ×0.5 multiplier — matches the published MVGS standard's
  // lenient treatment of back-side defects. Applied to the *deduction*
  // value only; forceCap74 still triggers if the underlying pin is a CR
  // crease, regardless of which side the crease is on (a creased card
  // is structurally degraded either way).
  const backMultiplier = isBackSurf ? 0.5 : 1;
  return { deduction: raw * backMultiplier, forceCap74 };
}

// ── Grade brackets ────────────────────────────────────────────────────────

/**
 * Map MVGS remaining-points-in-category (0..25) to a 1-10 subgrade. Mirror
 * of mvgsRemainingToGrade in grading-panel.tsx — kept in sync because the
 * lowest-subgrade floor rule (below) needs the same bucketing the UI uses
 * for chip display.
 */
function remainingToGrade(remaining: number): number {
  if (remaining >= 23) return 10;
  if (remaining >= 20) return 9;
  if (remaining >= 17) return 8;
  if (remaining >= 14) return 7;
  if (remaining >= 11) return 6;
  if (remaining >= 8)  return 5;
  if (remaining >= 5)  return 4;
  if (remaining >= 3)  return 3;
  if (remaining >= 1)  return 2;
  return 1;
}

/**
 * Top of each label bracket — the highest score that gradeLabelForScore
 * returns the matching label for. When the floor rule caps finalGrade at
 * grade N, the cappedScore drops to GRADE_BRACKET_TOP[N] so the displayed
 * label matches finalGrade exactly.
 *
 * The previous version offset each entry by +5 ("top of the next-up
 * bracket") which meant capping at 7.5 produced a cappedScore of 75 — and
 * gradeLabelForScore(75) is "NM-Mint 8", not "NM+ 7.5". That mis-display
 * was the bug fixed here: now strict per-bracket.
 *
 * Half-grades below 7 (2.5, 3.5, ...) have no label bracket of their own
 * (gradeLabelForScore brackets only support half-grades from 7.5 up), so
 * they fall through to the integer-floor lookup. E.g. finalGrade 2.5 →
 * bracketTopFor(2.5) = GRADE_BRACKET_TOP[2] = 20 → "Fair 2".
 */
const GRADE_BRACKET_TOP: Record<number, number> = {
  10:  100,  // top of "Pristine 10P" range (96-100); also covers "Gem Mint 10"
  9.5:  90,  // top of "Mint+ 9.5" (86-90)
  9:    85,  // top of "Mint 9" (81-85)
  8.5:  80,  // top of "NM-Mint+ 8.5" (76-80)
  8:    75,  // top of "NM-Mint 8" (71-75)
  7.5:  70,  // top of "NM+ 7.5" (66-70)
  7:    65,  // top of "Near Mint 7" (61-65)
  6:    60,  // top of "Excellent-Mint 6" (51-60)
  5:    50,  // top of "Excellent 5" (41-50)
  4:    40,  // top of "Very Good-Excellent 4" (31-40)
  3:    30,  // top of "Good 3" (21-30)
  2:    20,  // top of "Fair 2" (11-20)
  1:    10,  // top of "Poor 1" (1-10)
};
function bracketTopFor(grade: number): number {
  if (GRADE_BRACKET_TOP[grade] !== undefined) return GRADE_BRACKET_TOP[grade];
  return GRADE_BRACKET_TOP[Math.floor(grade)] ?? 100;
}

function gradeLabelForScore(score: number): string {
  if (score >= 96) return "Pristine 10P";
  if (score >= 91) return "Gem Mint 10";
  if (score >= 86) return "Mint+ 9.5";
  if (score >= 81) return "Mint 9";
  if (score >= 76) return "NM-Mint+ 8.5";
  if (score >= 71) return "NM-Mint 8";
  if (score >= 66) return "NM+ 7.5";
  if (score >= 61) return "Near Mint 7";
  if (score >= 51) return "Excellent-Mint 6";
  if (score >= 41) return "Excellent 5";
  if (score >= 31) return "Very Good-Excellent 4";
  if (score >= 21) return "Good 3";
  if (score >= 11) return "Fair 2";
  return "Poor 1";
}

// ── Public entry point ────────────────────────────────────────────────────

export function computeMvgsScore(input: MvgsInput): MvgsResult {
  const deductions: Record<string, number> = {};

  // Centering — worst of LR vs TB for each side.
  const centFrontLr = centeringFrontDeduction(input.centeringFrontLr);
  const centFrontTb = centeringFrontDeduction(input.centeringFrontTb);
  const centFront = Math.min(centFrontLr, centFrontTb); // most negative
  if (centFront !== 0) deductions.centering_front = centFront;

  const centBackLr = centeringBackDeduction(input.centeringBackLr);
  const centBackTb = centeringBackDeduction(input.centeringBackTb);
  const centBack = Math.min(centBackLr, centBackTb);
  if (centBack !== 0) deductions.centering_back = centBack;

  // Corners — capped at -25.
  let cornerSum = 0;
  for (const d of input.defects) cornerSum += cornerDeduction(d);
  if (cornerSum < -25) cornerSum = -25;
  if (cornerSum !== 0) deductions.corners = cornerSum;

  // Edges — capped at -25. Dark-border + WH multiplier applied per-pin
  // inside edgeDeduction, before the sum.
  let edgeSum = 0;
  for (const d of input.defects) edgeSum += edgeDeduction(d, input.darkBorder);
  if (edgeSum < -25) edgeSum = -25;
  if (edgeSum !== 0) deductions.edges = edgeSum;

  // Surface — capped at -25 same as corners/edges. CR D1 also forces a
  // hard 74 cap on the final score (applied below after totals sum).
  let surfaceSum = 0;
  let surfaceForceCap = false;
  for (const d of input.defects) {
    const r = surfaceDeduction(d);
    surfaceSum += r.deduction;
    if (r.forceCap74) surfaceForceCap = true;
  }
  if (surfaceSum < -25) surfaceSum = -25;
  if (surfaceSum !== 0) deductions.surface = surfaceSum;

  // Eye appeal modifier — clamped ±2.
  const eye = Math.max(-2, Math.min(2, Math.trunc(input.eyeAppealModifier || 0)));
  if (eye !== 0) deductions.eye_appeal = eye;

  // Sum all deductions and apply to base 100. Round to nearest integer —
  // CR-cap then sits at most at 74.
  const total = centFront + centBack + cornerSum + edgeSum + surfaceSum + eye;
  let raw = Math.round(100 + total);
  if (surfaceForceCap && raw > 74) raw = 74;
  const score = Math.max(1, Math.min(100, raw));

  // ── Lowest-subgrade floor rule ────────────────────────────────────────
  // Derive per-category subgrades from deductions, find the lowest, and cap
  // the headline grade so a near-perfect card with one destroyed category
  // can't whitewash that category. Two regimes:
  //   gap ≥ 4 (high variance): maxGrade = lowest + 0.5  (one half-grade above)
  //   gap < 4 (low variance) : maxGrade = lowest        (strict cap to lowest)
  // The cappedScore then sits at the top of the bracket one step ABOVE
  // finalGrade, matching how the engine surfaces labels through
  // gradeLabelForScore (see GRADE_BRACKET_TOP rationale).
  const catScores = {
    centering: 25 - Math.abs((deductions.centering_front ?? 0) + (deductions.centering_back ?? 0)),
    corners:   25 - Math.abs(deductions.corners ?? 0),
    edges:     25 - Math.abs(deductions.edges   ?? 0),
    surface:   25 - Math.abs(deductions.surface ?? 0),
  };
  const subList = Object.values(catScores).map(remainingToGrade);
  const lowest  = Math.min(...subList);
  const others  = subList.filter((s) => s !== lowest);
  const gap     = others.reduce((sum, s) => sum + (s - lowest), 0);
  const maxGrade   = gap >= 4 ? lowest + 0.5 : lowest;
  const scoreGrade = gradeFromMvgsScore(score);
  const finalGrade = Math.min(scoreGrade, maxGrade);
  const cappedScore = Math.min(score, bracketTopFor(finalGrade));

  return {
    score: cappedScore,
    grade: gradeLabelForScore(cappedScore),
    deductions,
  };
}

// Convenience re-export of the grade-label lookup so the UI can label an
// already-computed score without going through the full pipeline.
export { gradeLabelForScore as mvgsGradeLabel };

/**
 * Numeric 1-10 grade that corresponds to a 0-100 MVGS score. Mirrors the
 * brackets in gradeLabelForScore — Pristine 10P collapses to grade 10
 * (the "P" suffix is a label-only distinction, not a separate grade).
 *
 * Used by the admin grading panel to substitute the AI/manual overall
 * grade with the MVGS-derived grade when defects have been MVGS-classified.
 */
export function gradeFromMvgsScore(score: number): number {
  if (score >= 96) return 10;     // Pristine 10P → 10
  if (score >= 91) return 10;     // Gem Mint 10
  if (score >= 86) return 9.5;    // Mint+ 9.5
  if (score >= 81) return 9;      // Mint 9
  if (score >= 76) return 8.5;    // NM-Mint+ 8.5
  if (score >= 71) return 8;      // NM-Mint 8
  if (score >= 66) return 7.5;    // NM+ 7.5
  if (score >= 61) return 7;      // Near Mint 7
  if (score >= 51) return 6;      // Excellent-Mint 6
  if (score >= 41) return 5;      // Excellent 5
  if (score >= 31) return 4;      // Very Good-Excellent 4
  if (score >= 21) return 3;      // Good 3
  if (score >= 11) return 2;      // Fair 2
  return 1;                       // Poor 1
}
