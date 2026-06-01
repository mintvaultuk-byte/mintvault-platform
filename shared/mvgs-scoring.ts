/**
 * MVGS (MintVault Grading Standard) — pure scoring helper.
 *
 * Lives in shared/ so both sides import the same code:
 *   server: `import { computeMvgsScore } from "./mvgs-scoring"`
 *           (via server/mvgs-scoring.ts re-export shim)
 *   client: `import { computeMvgsScore } from "@shared/mvgs-scoring"`
 *
 * Inputs: centering ratios (string form "55/45"), classified defect pins,
 * front/back dark-border flags, eye-appeal modifier. Output: integer score
 * 1–100, grade label, breakdown of deductions for explainability.
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
 *       Front edges use darkBorderFront flag; back edges use darkBorderBack.
 *       A card can have a dark front and a light back (or vice versa) and
 *       only the edges of the dark side get the WH multiplier.
 *   - Surface defects in zones FA/FH/FB/BA/BB by mvgsCode + tier,
 *     capped at -25 total
 *     · D2 surface weights: PL -0.5, PS -0.25, PI -0.5, SC -0.5, WH -0.5
 *     · CR D1 (crease) sets a hard cap of 74 on the final score
 *     · SP D1 in art/holo zone (FA/FH) multiplies ×1.5
 *     · Back-surface zones (BA/BB) multiply final deduction ×0.5 —
 *       matches the published MVGS standard's lenient back treatment
 *   - Eye appeal modifier added last, clamped ±2
 *   - Final clamped 1..100, then lowest-subgrade floor rule applies:
 *     · centering subgrade comes from the shared PSA centering chart
 *       (shared/centering.ts — worst of the four axes); corners/edges/surface
 *       subgrades derived from their deductions (25-pt budget each)
 *     · cap headline grade at lowest single subgrade (+0.5 when variance is high)
 *     · cappedScore sits at top of the next-up label bracket
 */

import { centeringScoreDeductions, centeringSubgrade } from "./centering";

export interface MvgsDefect {
  tier: string; // "D1" | "D2" | "D3"
  mvgsCode: string;
  zone: string; // one of the 20 zone codes
}

// ── v2: measurement-based ceilings + whitening ladder ─────────────────────
// New optional inputs introduced in MVGS v2 (docs/MVGS-v2-spec.md). All are
// optional with safe "no-penalty" defaults so legacy callers that don't yet
// pass them keep scoring exactly as before. The grading-workstation line tool
// (Phase 2) is what populates whiteningEdges / creaseSpanPct / wrinkleSeverity
// / tearSeverity for new captures; this engine phase implements the maths.

/** TAG-aligned wrinkle severity (surface ripple that doesn't break the stock).
 *  Each level is a grade CEILING — the worst of all ceilings caps the overall
 *  grade per the floor-rule resolution. */
export type WrinkleSeverity =
  | "tiny_back" // ceiling 6.5
  | "longer_back" // ceiling 6
  | "small_front" // ceiling 5.5
  | "multiple_front"; // ceiling 5

/** TAG-aligned tear severity. "major" routes to the existing non-numeric NO
 *  outcome (returned, not slabbed) per spec §4 — caller surfaces this via the
 *  `tearForceNotGraded` flag in MvgsResult and sets gradeType="non_numeric"
 *  on the cert. NQ = NO; no new code is created. */
export type TearSeverity =
  | "minor" // cap 2
  | "significant" // cap 1.5
  | "major"; // → non-numeric NO outcome

/** A single whitening LINE marked along one of the eight card edges (4 front +
 *  4 back). coveragePct = how much of THIS edge's length the line covers,
 *  0..100. Multiple lines on the same edge sum into one entry (caller
 *  consolidates). */
export interface WhiteningEdge {
  side: "front" | "back";
  /** Which of the four edges on this side. */
  edge: "top" | "right" | "bottom" | "left";
  /** % of this edge's length covered by whitening. 0..100. */
  coveragePct: number;
}

/** Calibration thresholds — the three "[CALIBRATE]" values in the spec that
 *  are not published by anyone and must be tuned, then locked. Stored in
 *  pipeline_settings under key "mvgs.calibration" (server reads + passes).
 *  Defaults below are the STARTING values from spec §3 + §6. */
export interface MvgsCalibration {
  /** An edge counts as "affected" if whitening covers ≥ this % of its length.
   *  Starting: 10. */
  edgeAffectedPct: number;
  /** Split between "minor" (≤) and "visible" (>) whitening as % of the edge.
   *  Starting: 25. */
  minorVisibleSplitPct: number;
  /** Dark-border multiplier on whitening coverage before the ladder reads.
   *  Starting: 1.25. */
  darkBorderMultiplier: number;
  /** Crease span thresholds as % of card axis. Starting: 25 / 50 / 75. The
   *  ladder is < creaseMinorMaxPct → cap 4.5, ≤ creaseHalfMaxPct → cap 4,
   *  ≤ creaseThreeQuarterMaxPct → cap 3.5, > → cap 3. */
  creaseMinorMaxPct: number;
  creaseHalfMaxPct: number;
  creaseThreeQuarterMaxPct: number;
}

/** Starting calibration values per spec §3 + §6. Live in code as the default;
 *  the pipeline_settings row (key "mvgs.calibration") overrides per-deployment
 *  when admin tunes in the calibration panel (Phase 2/3 UI). */
export const DEFAULT_MVGS_CALIBRATION: MvgsCalibration = {
  edgeAffectedPct: 10,
  minorVisibleSplitPct: 25,
  darkBorderMultiplier: 1.25,
  creaseMinorMaxPct: 25,
  creaseHalfMaxPct: 50,
  creaseThreeQuarterMaxPct: 75,
};

export interface MvgsInput {
  centeringFrontLr: string | null; // "55/45"
  centeringFrontTb: string | null;
  centeringBackLr: string | null;
  centeringBackTb: string | null;
  defects: MvgsDefect[];
  /** Cards with a dark front border (e.g. Darkness-type Pokémon). Triggers
   *  the WH (whitening) ×1.25 multiplier on FRONT edges only. */
  darkBorderFront: boolean;
  /** Cards with a dark back border (e.g. standard Pokémon blue back).
   *  Triggers the WH ×1.25 multiplier on BACK edges only. */
  darkBorderBack: boolean;
  eyeAppealModifier: number; // -2..+2

  // ── v2 (all optional, omit = no v2 capping, score identical to v1) ───────
  /** Whitening lines marked along card edges. Drives the Edges subgrade via
   *  the §3 ladder (one of 10 / 9 / 8.5 / 8 for "affected count" tiers; lower
   *  rungs require additional pin-marked severity that lives in `defects`). */
  whiteningEdges?: WhiteningEdge[] | null;
  /** Crease length as % of the card's axis (0..100). 0 / null = no crease.
   *  Maps to a grade ceiling per spec §4 crease ladder. */
  creaseSpanPct?: number | null;
  /** Wrinkle severity per spec §4. null = none. */
  wrinkleSeverity?: WrinkleSeverity | null;
  /** Tear severity per spec §4. "major" routes to non-numeric NO. null = none. */
  tearSeverity?: TearSeverity | null;
  /** Calibration thresholds. Server callers load from pipeline_settings; client
   *  preview can pass DEFAULT_MVGS_CALIBRATION. Omit = use defaults. */
  calibration?: MvgsCalibration;
}

/** Structural ceiling (crease/wrinkle/tear) applied via the floor rule per
 *  spec §4 + §5. Worst ceiling wins; "source" names the strictest input.
 *  Returned in MvgsResult so consumers (grade-display, slab render, AI prompt)
 *  read this single authority instead of duplicating cap logic. */
export interface MvgsCeiling {
  source: "crease" | "wrinkle" | "tear";
  grade: number; // 1..10 — cap on overall grade
  reason: string; // human-readable, surfaced in the calc-details panel
}

export interface MvgsResult {
  score: number; // 1..100, integer
  grade: string; // e.g. "Gem Mint", "NM-Mint+"
  deductions: Record<string, number>; // breakdown, signed (always ≤ 0)
  /** Strictest structural ceiling, or null if none triggered. */
  ceiling: MvgsCeiling | null;
  /** Edges subgrade derived from the whitening line measurement when supplied.
   *  null = no measurement → caller's existing pin-derived subgrade stands. */
  edgesSubgradeFromWhitening: number | null;
  /** Tear severity "major" → existing non-numeric NO outcome. Caller surfaces
   *  this on the cert as gradeType="non_numeric" + grade label "NO". */
  tearForceNotGraded: boolean;
}

// ── Centering ─────────────────────────────────────────────────────────────
// Centering deductions + subgrade live in the shared single source of truth
// (shared/centering.ts — true PSA chart, front strict / back lenient). The
// old per-side deduction tables that used to live here were removed in the
// PSA-consolidation change so the score, the displayed subgrade, and the
// public /standard page can never diverge again.

// ── Zone classifiers ──────────────────────────────────────────────────────

const FRONT_CORNER_ZONES = new Set(["FC1", "FC2", "FC3", "FC4"]);
const BACK_CORNER_ZONES = new Set(["BC1", "BC2", "BC3", "BC4"]);
const FRONT_EDGE_ZONES = new Set(["FE1", "FE2", "FE3", "FE4"]);
const BACK_EDGE_ZONES = new Set(["BE1", "BE2", "BE3", "BE4"]);
const FRONT_SURFACE_ZONES = new Set(["FA", "FH", "FB"]);
const BACK_SURFACE_ZONES = new Set(["BA", "BB"]);
const FRONT_ART_HOLO_ZONES = new Set(["FA", "FH"]);

// ── Per-defect deduction logic ────────────────────────────────────────────

function cornerDeduction(d: MvgsDefect): number {
  const isFront = FRONT_CORNER_ZONES.has(d.zone);
  const isBack = BACK_CORNER_ZONES.has(d.zone);
  if (!isFront && !isBack) return 0;
  if (d.tier === "D1") return isFront ? -4 : -2;
  if (d.tier === "D2") return isFront ? -0.5 : -0.25;
  if (d.tier === "D3") return 0; // Factory — documented only, no deduction.
  return 0;
}

function edgeDeduction(d: MvgsDefect, darkBorderFront: boolean, darkBorderBack: boolean): number {
  const isFront = FRONT_EDGE_ZONES.has(d.zone);
  const isBack = BACK_EDGE_ZONES.has(d.zone);
  if (!isFront && !isBack) return 0;
  let base = 0;
  if (d.tier === "D1") base = isFront ? -3 : -2;
  else if (d.tier === "D2") base = isFront ? -0.5 : -0.25;
  // D3: Factory — documented only, no deduction (matches the published
  // standard at /standard). Falling through to return 0 here also skips
  // the dark-border WH multiplier below, which is correct: 0 × 1.25 = 0.
  else return 0;
  // Dark-border + WH multiplier applies to whatever base the tier produced
  // (D1/D2 only after the D3-returns-zero change above). Per-side: a card
  // with a dark front but light back applies the multiplier only to its
  // front edges, and vice versa.
  const sideHasDarkBorder = isFront ? darkBorderFront : darkBorderBack;
  if (sideHasDarkBorder && d.mvgsCode === "WH") base = base * 1.25;
  return base;
}

interface SurfaceOutcome {
  deduction: number;
  forceCap74: boolean; // CR D1 crease triggers a hard 74 cap
}

function surfaceDeduction(d: MvgsDefect): SurfaceOutcome {
  const isFrontSurf = FRONT_SURFACE_ZONES.has(d.zone);
  const isBackSurf = BACK_SURFACE_ZONES.has(d.zone);
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
      case "CR":
        raw = -10;
        forceCap74 = true;
        break;
      case "SC":
        raw = -2;
        break;
      case "SV":
        raw = -3;
        break;
      case "ST":
        raw = -2;
        break;
      case "GL":
        raw = -4;
        break;
    }
  } else if (d.tier === "D2") {
    switch (d.mvgsCode) {
      case "PL":
        raw = -0.5;
        break;
      case "PS":
        raw = -0.25;
        break;
      case "PI":
        raw = -0.5;
        break;
      case "SC":
        raw = -0.5;
        break;
      // WH (whitening) on a surface zone — added in the D2 weight update.
      // Distinct from WH on an edge zone, which routes through
      // edgeDeduction and gets the dark-border ×1.25 multiplier.
      case "WH":
        raw = -0.5;
        break;
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
  if (remaining >= 8) return 5;
  if (remaining >= 5) return 4;
  if (remaining >= 3) return 3;
  if (remaining >= 1) return 2;
  return 1;
}

/**
 * Top of each label bracket — the highest score that gradeLabelForScore
 * returns the matching label for. When the floor rule caps finalGrade at
 * grade N, the cappedScore drops to GRADE_BRACKET_TOP[N] so the displayed
 * label matches finalGrade exactly.
 *
 * v2 (MVGS-v2-spec.md §2) — TAG-aligned bands, full half-grade ladder down
 * to 1. The v1 table was shifted ~5 points lenient AND skipped half-grades
 * below 7.5; both are corrected here to match TAG's published rubric ÷10.
 * 9.5 is removed (TAG does not use it). Boundaries are inclusive on the
 * lower side, exclusive on the upper (score 95 = Gem Mint; 94 = Mint).
 */
const GRADE_BRACKET_TOP: Record<number, number> = {
  10: 100, // Pristine 10P (99-100) + Gem Mint (95-98.9), integer top = 100
  9: 94, // Mint 9 (90-94.9)
  8.5: 89, // NM-Mint+ 8.5 (85-89.9)
  8: 84, // NM-Mint 8 (80-84.9)
  7.5: 79, // NM+ 7.5 (75-79.9)
  7: 74, // Near Mint 7 (70-74.9)
  6.5: 69, // EX-Mint+ 6.5 (65-69.9)
  6: 64, // EX-Mint 6 (60-64.9)
  5.5: 59, // Excellent+ 5.5 (55-59.9)
  5: 54, // Excellent 5 (50-54.9)
  4.5: 49, // VG-EX+ 4.5 (45-49.9)
  4: 44, // VG-EX 4 (40-44.9)
  3.5: 39, // VG+ 3.5 (35-39.9)
  3: 34, // Very Good 3 (30-34.9)
  2.5: 29, // Good+ 2.5 (25-29.9)
  2: 24, // Good 2 (20-24.9)
  1.5: 19, // Fair 1.5 (15-19.9)
  1: 14, // Poor 1 (10-14.9; score < 10 still labels Poor)
};
function bracketTopFor(grade: number): number {
  if (GRADE_BRACKET_TOP[grade] !== undefined) return GRADE_BRACKET_TOP[grade];
  return GRADE_BRACKET_TOP[Math.floor(grade)] ?? 100;
}

/** Score → label per spec §2 band table. */
function gradeLabelForScore(score: number): string {
  if (score >= 99) return "Pristine 10P";
  if (score >= 95) return "Gem Mint";
  if (score >= 90) return "Mint";
  if (score >= 85) return "NM-Mint+";
  if (score >= 80) return "NM-Mint";
  if (score >= 75) return "NM+";
  if (score >= 70) return "Near Mint";
  if (score >= 65) return "EX-Mint+";
  if (score >= 60) return "EX-Mint";
  if (score >= 55) return "Excellent+";
  if (score >= 50) return "Excellent";
  if (score >= 45) return "VG-EX+";
  if (score >= 40) return "VG-EX";
  if (score >= 35) return "VG+";
  if (score >= 30) return "Very Good";
  if (score >= 25) return "Good+";
  if (score >= 20) return "Good";
  if (score >= 15) return "Fair";
  return "Poor";
}

// ── v2: ceiling helpers (crease / wrinkle / tear) ─────────────────────────
// Each helper returns the grade ceiling for its input, or null when the
// input is absent / zero. Callers combine via worstCeiling() (lowest grade
// wins) before the floor rule resolves the final overall grade. Single source
// of truth — client grade-logic + grade-display + the AI prompt all read
// from these helpers (or from MvgsResult.ceiling), not duplicates of the
// hard-coded numbers below.

/** Crease ceiling by % of card axis per spec §4. Calibrated thresholds are
 *  read from the calibration object so the same number that drives scoring
 *  drives the public /standard page (no claim-without-code drift). */
function creaseCeiling(spanPct: number | null | undefined, c: MvgsCalibration): MvgsCeiling | null {
  if (spanPct == null || spanPct <= 0) return null;
  let grade: number;
  let span: string;
  if (spanPct < c.creaseMinorMaxPct) {
    grade = 4.5;
    span = `<${c.creaseMinorMaxPct}%`;
  } else if (spanPct <= c.creaseHalfMaxPct) {
    grade = 4;
    span = `${c.creaseMinorMaxPct}-${c.creaseHalfMaxPct}%`;
  } else if (spanPct <= c.creaseThreeQuarterMaxPct) {
    grade = 3.5;
    span = `${c.creaseHalfMaxPct}-${c.creaseThreeQuarterMaxPct}%`;
  } else {
    grade = 3;
    span = `>${c.creaseThreeQuarterMaxPct}%`;
  }
  return { source: "crease", grade, reason: `crease ${spanPct.toFixed(1)}% of card span (${span} bracket)` };
}

/** Wrinkle ceiling per spec §4. */
function wrinkleCeiling(sev: WrinkleSeverity | null | undefined): MvgsCeiling | null {
  if (!sev) return null;
  const map: Record<WrinkleSeverity, number> = {
    tiny_back: 6.5,
    longer_back: 6,
    small_front: 5.5,
    multiple_front: 5,
  };
  return { source: "wrinkle", grade: map[sev], reason: `wrinkle: ${sev.replace("_", " ")}` };
}

/** Tear ceiling per spec §4. "major" → non-numeric NO outcome (existing code,
 *  not a new one) — caller acts on tearForceNotGraded in MvgsResult. */
function tearCeiling(sev: TearSeverity | null | undefined): { ceiling: MvgsCeiling | null; forceNotGraded: boolean } {
  if (!sev) return { ceiling: null, forceNotGraded: false };
  if (sev === "major") {
    // Major tear routes to the existing "Not Graded" non-numeric outcome.
    // The ceiling is informational; the engine still surfaces a score so
    // the floor rule has a number to work with, but the caller treats this
    // as gradeType=non_numeric / grade label "NO".
    return {
      ceiling: { source: "tear", grade: 1, reason: "major tear / missing material — routed to NO (existing code)" },
      forceNotGraded: true,
    };
  }
  const grade = sev === "minor" ? 2 : 1.5;
  return {
    ceiling: { source: "tear", grade, reason: `tear: ${sev}` },
    forceNotGraded: false,
  };
}

/** Take the strictest (lowest-grade) ceiling out of any supplied. */
function worstCeiling(...ceilings: Array<MvgsCeiling | null>): MvgsCeiling | null {
  let worst: MvgsCeiling | null = null;
  for (const c of ceilings) {
    if (c && (!worst || c.grade < worst.grade)) worst = c;
  }
  return worst;
}

/** Legacy boolean → ceiling mapping. The original surface-grading UI uses
 *  has_crease / has_tear flags (no length measurement). Phase 1 keeps that
 *  signal but routes it through the same v2 ladder so client + display + AI
 *  prompt all read the SAME ceiling — no path carries its own crease/tear
 *  numbers any more (spec §5 single-source-of-truth requirement).
 *
 *  Mapping conservatively to the LEAST-severe bucket in each ladder because
 *  the legacy boolean is too coarse to imply more:
 *   - has_crease = true → "less than minor" bucket → cap 4.5
 *   - has_tear   = true → "minor" tear → cap 2 (major-tear-NO is reserved
 *     for the explicit tearSeverity="major" path; the legacy boolean alone
 *     never escalates to NO).
 *  Phase 2 swaps these for measurement-driven inputs (creaseSpanPct,
 *  tearSeverity) at the call sites; this helper goes away then. */
export function legacyCeilingForFlags(opts: { hasCrease: boolean; hasTear: boolean }): MvgsCeiling | null {
  const cCrease = opts.hasCrease
    ? ({ source: "crease", grade: 4.5, reason: "crease present (legacy flag)" } as const)
    : null;
  const cTear = opts.hasTear ? ({ source: "tear", grade: 2, reason: "tear present (legacy flag)" } as const) : null;
  return worstCeiling(cCrease, cTear);
}

/** §3 whitening edges ladder. Counts how many edges are "affected" (coverage
 *  ≥ calibration.edgeAffectedPct), splits "minor" vs "visible" at the
 *  calibration split, and reads the ladder. Dark-border WH multiplier from
 *  the caller (passed darkBorderFront/Back) is applied to coverage BEFORE
 *  thresholding so a dark edge with 8% coverage × 1.25 = 10% counts as
 *  affected.
 *
 *  Returns null when no whitening edges are supplied (legacy callers); the
 *  caller's pin-derived edges subgrade stays in force. Returns 10 when
 *  measurements exist but no edge clears the affected threshold.
 *
 *  Phase 1 covers the first four rungs (10 / 9 / 8.5 / 8) cleanly from the
 *  count + severity-split signal. Worse rungs (7.5 and below — notching,
 *  chipping, severe wear) sit on top of pin-marked severity codes (CH/PI/
 *  SP D1) that flow through the existing pin-based edges deduction; the
 *  combined min() at the call site makes sure neither can over-rule the
 *  other. */
function whiteningEdgesSubgrade(
  edges: WhiteningEdge[] | null | undefined,
  c: MvgsCalibration,
  darkBorderFront: boolean,
  darkBorderBack: boolean
): number | null {
  if (!edges || edges.length === 0) return null;

  // Dedupe by (side, edge): an edge counts once, with worst (max) coverage.
  const byKey = new Map<string, { side: "front" | "back"; edge: string; effectiveCoverage: number }>();
  for (const e of edges) {
    const key = `${e.side}:${e.edge}`;
    const sideDark = e.side === "front" ? darkBorderFront : darkBorderBack;
    const eff = sideDark ? e.coveragePct * c.darkBorderMultiplier : e.coveragePct;
    const prev = byKey.get(key);
    if (!prev || eff > prev.effectiveCoverage) byKey.set(key, { side: e.side, edge: e.edge, effectiveCoverage: eff });
  }

  // Affected = ≥ edgeAffectedPct. Visible = > minorVisibleSplitPct (else minor).
  let affectedFront = 0;
  let affectedBack = 0;
  let visibleFront = 0;
  let visibleBack = 0;
  for (const v of byKey.values()) {
    if (v.effectiveCoverage < c.edgeAffectedPct) continue;
    if (v.side === "front") {
      affectedFront++;
      if (v.effectiveCoverage > c.minorVisibleSplitPct) visibleFront++;
    } else {
      affectedBack++;
      if (v.effectiveCoverage > c.minorVisibleSplitPct) visibleBack++;
    }
  }
  const totalAffected = affectedFront + affectedBack;

  // Ladder rungs covered in Phase 1 (count-based, no severity codes needed):
  //   Clean / hi-res artifacts only         → 10  (zero edges clear threshold)
  //   Minor whitening, 1-2 edges            →  9
  //   Visible, multiple edges (front)       →  8.5
  //   All four edges affected               →  8
  if (totalAffected === 0) return 10;
  if (totalAffected >= 4) return 8;
  // "Visible, multiple edges (front)" — 2+ front edges past the visible split.
  if (visibleFront >= 2) return 8.5;
  // "Minor whitening, 1-2 edges" — 1-2 edges affected at the minor level.
  return 9;
}

// ── Public entry point ────────────────────────────────────────────────────

export function computeMvgsScore(input: MvgsInput): MvgsResult {
  const deductions: Record<string, number> = {};
  // v2 calibration — caller passes pipeline_settings overrides; defaults
  // otherwise. Engine never goes to the DB, stays pure.
  const calibration = input.calibration ?? DEFAULT_MVGS_CALIBRATION;

  // Centering — worst front axis → front deduction (0..-20), worst back axis
  // → back deduction (0..-5). Both come from the shared PSA chart so the
  // points-off the score and the displayed subgrade are the same standard.
  const { front: centFront, back: centBack } = centeringScoreDeductions(
    input.centeringFrontLr,
    input.centeringFrontTb,
    input.centeringBackLr,
    input.centeringBackTb
  );
  if (centFront !== 0) deductions.centering_front = centFront;
  if (centBack !== 0) deductions.centering_back = centBack;

  // Corners — capped at -25.
  let cornerSum = 0;
  for (const d of input.defects) cornerSum += cornerDeduction(d);
  if (cornerSum < -25) cornerSum = -25;
  if (cornerSum !== 0) deductions.corners = cornerSum;

  // Edges — capped at -25. Dark-border + WH multiplier applied per-pin
  // inside edgeDeduction, before the sum.
  let edgeSum = 0;
  for (const d of input.defects) edgeSum += edgeDeduction(d, input.darkBorderFront, input.darkBorderBack);
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
  // Centering subgrade comes straight from the PSA chart (worst of the four
  // axes) — the SAME number the grader sees on the chip — so the floor rule
  // caps the headline grade at the displayed centering subgrade rather than a
  // bucket re-derived from the deduction. Corners/edges/surface still bucket
  // from their 25-pt deduction budgets.
  const centeringSub = centeringSubgrade(
    input.centeringFrontLr,
    input.centeringFrontTb,
    input.centeringBackLr,
    input.centeringBackTb
  ).subgrade;

  // v2 §3 — whitening line measurement, if supplied, drives the displayed
  // edges subgrade alongside the pin-derived one. The lower (worse) of the
  // two wins so neither path can over-rule the other:
  //   - line says "all 4 affected" (8) but pins only mark a single CH D2
  //     (subgrade ~10): operator-marked whitening dominates, edges = 8.
  //   - pins mark a severe CH D1 (subgrade ~7 from deductions) and no line
  //     measurement: pin path dominates, edges = 7.
  // The PIN-derived edges deduction is still summed into the score; the
  // line subgrade only constrains the DISPLAYED subgrade + the floor rule.
  // (Phase 2 will add a corresponding deduction-equivalent so the score
  // also reflects line measurements end-to-end — out of scope here.)
  const edgesSubgradeFromWhitening = whiteningEdgesSubgrade(
    input.whiteningEdges,
    calibration,
    input.darkBorderFront,
    input.darkBorderBack
  );
  const edgesSubgradeFromPins = remainingToGrade(25 - Math.abs(deductions.edges ?? 0));
  const edgesSub =
    edgesSubgradeFromWhitening != null
      ? Math.min(edgesSubgradeFromWhitening, edgesSubgradeFromPins)
      : edgesSubgradeFromPins;

  const subList = [
    centeringSub,
    remainingToGrade(25 - Math.abs(deductions.corners ?? 0)),
    edgesSub,
    remainingToGrade(25 - Math.abs(deductions.surface ?? 0)),
  ];
  const lowest = Math.min(...subList);
  const others = subList.filter((s) => s !== lowest);
  const gap = others.reduce((sum, s) => sum + (s - lowest), 0);
  let maxGrade = gap >= 4 ? lowest + 0.5 : lowest;

  // v2 §4 — structural ceilings (crease / wrinkle / tear) cap the overall
  // grade if they're stricter than the floor rule. Worst ceiling wins per
  // §5 DINGS: a card with both a wrinkle (cap 6.5) AND a minor tear (cap 2)
  // resolves at 2; lesser ceilings do not compound.
  const cCrease = creaseCeiling(input.creaseSpanPct, calibration);
  const cWrinkle = wrinkleCeiling(input.wrinkleSeverity);
  const tearResult = tearCeiling(input.tearSeverity);
  const ceiling = worstCeiling(cCrease, cWrinkle, tearResult.ceiling);
  if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);

  const scoreGrade = gradeFromMvgsScore(score);
  const finalGrade = Math.min(scoreGrade, maxGrade);
  const cappedScore = Math.min(score, bracketTopFor(finalGrade));

  return {
    score: cappedScore,
    grade: gradeLabelForScore(cappedScore),
    deductions,
    ceiling,
    edgesSubgradeFromWhitening,
    tearForceNotGraded: tearResult.forceNotGraded,
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
  // v2 band table per spec §2 — full TAG half-grade ladder.
  if (score >= 99) return 10; // Pristine 10P → grade 10 ("P" is label-only)
  if (score >= 95) return 10; // Gem Mint
  if (score >= 90) return 9; // Mint
  if (score >= 85) return 8.5; // NM-Mint+
  if (score >= 80) return 8; // NM-Mint
  if (score >= 75) return 7.5; // NM+
  if (score >= 70) return 7; // Near Mint
  if (score >= 65) return 6.5; // EX-Mint+
  if (score >= 60) return 6; // EX-Mint
  if (score >= 55) return 5.5; // Excellent+
  if (score >= 50) return 5; // Excellent
  if (score >= 45) return 4.5; // VG-EX+
  if (score >= 40) return 4; // VG-EX
  if (score >= 35) return 3.5; // VG+
  if (score >= 30) return 3; // Very Good
  if (score >= 25) return 2.5; // Good+
  if (score >= 20) return 2; // Good
  if (score >= 15) return 1.5; // Fair
  return 1; // Poor
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
