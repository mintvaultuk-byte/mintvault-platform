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
 *   - Corner defects: D1 -4/-2, D2 -2/-1, D3 -0.5/-0.25 (front/back),
 *     capped at -25 total
 *   - Edge defects: D1 -3/-2, D2 -1/-0.5, D3 -0.5/-0.25 (front/back),
 *     capped at -25 total
 *     · Dark border + WH (whitening): multiply that defect's deduction ×1.25
 *   - Surface defects in zones FA/FH/FB/BA/BB by mvgsCode + tier,
 *     capped at -25 total
 *     · CR D1 (crease) sets a hard cap of 74 on the final score
 *     · SP D1 in art/holo zone (FA/FH) multiplies ×1.5
 *   - Eye appeal modifier added last, clamped ±2
 *   - Final clamped 1..100
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
  if (d.tier === "D1") return isFront ? -4   : -2;
  if (d.tier === "D2") return isFront ? -2   : -1;
  if (d.tier === "D3") return isFront ? -0.5 : -0.25;
  return 0;
}

function edgeDeduction(d: MvgsDefect, darkBorder: boolean): number {
  const isFront = FRONT_EDGE_ZONES.has(d.zone);
  const isBack  = BACK_EDGE_ZONES.has(d.zone);
  if (!isFront && !isBack) return 0;
  let base = 0;
  if (d.tier === "D1")      base = isFront ? -3   : -2;
  else if (d.tier === "D2") base = isFront ? -1   : -0.5;
  else if (d.tier === "D3") base = isFront ? -0.5 : -0.25;
  else return 0;
  // Dark-border + WH multiplier applies to whatever base the tier produced
  // (D1/D2/D3) — kept after the tier branch so D3 whitening on a dark border
  // still gets the ×1.25 boost.
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

  if (d.tier === "D1") {
    switch (d.mvgsCode) {
      case "SP": {
        let v = -4;
        if (FRONT_ART_HOLO_ZONES.has(d.zone)) v = v * 1.5;
        return { deduction: v, forceCap74: false };
      }
      case "CR": return { deduction: -10, forceCap74: true };
      case "SC": return { deduction: -2,  forceCap74: false };
      case "SV": return { deduction: -3,  forceCap74: false };
      case "ST": return { deduction: -2,  forceCap74: false };
      case "GL": return { deduction: -4,  forceCap74: false };
      default:   return { deduction: 0,   forceCap74: false };
    }
  }

  if (d.tier === "D2") {
    switch (d.mvgsCode) {
      case "PL": return { deduction: -1,    forceCap74: false };
      case "PS": return { deduction: -0.5,  forceCap74: false };
      case "PI": return { deduction: -1,    forceCap74: false };
      case "SC": return { deduction: -1,    forceCap74: false };
      default:   return { deduction: 0,     forceCap74: false };
    }
  }

  // D3 or unknown
  return { deduction: 0, forceCap74: false };
}

// ── Grade brackets ────────────────────────────────────────────────────────

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

  return {
    score,
    grade: gradeLabelForScore(score),
    deductions,
  };
}

// Convenience re-export of the grade-label lookup so the UI can label an
// already-computed score without going through the full pipeline.
export { gradeLabelForScore as mvgsGradeLabel };
