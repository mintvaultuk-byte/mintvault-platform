/**
 * MintVault centering — SINGLE SOURCE OF TRUTH (true PSA standard).
 *
 * One chart for the whole app. The displayed centering subgrade, the
 * "MVGS Calc" button, the locked chip, the public /standard tables, and the
 * 100-point score (computeMvgsScore) all read THESE tables. This replaces the
 * three divergent centering tables that previously lived in
 * shared/mvgs-scoring.ts (score) and grade-logic.ts (display + button).
 *
 * Standard = true PSA (Option 2): FRONT weighted strict, BACK lenient.
 * Centering subgrade = the WORST (minimum) of the four axis grades
 * (front L/R, front T/B, back L/R, back T/B). Whole-number grades 1–10 —
 * no half grades for centering.
 *
 * Keyed on bigger-side % (the wider side as a share of the pair's sum):
 *   "55/45" → 55, "60/30" → 66.7. Front carries a 20-pt deduction budget,
 *   back a 5-pt budget (preserving the existing MVGS front-20 / back-5 split).
 *
 * Pure — no DB, no env, no React. Safe to call in render and on the server.
 */

export type CenteringSide = "front" | "back";
export type CenteringAxis = "frontLR" | "frontTB" | "backLR" | "backTB";

interface CenteringBand {
  /** Inclusive upper bound on the bigger-side %. */
  maxBigger: number;
  /** Axis subgrade 1–10. */
  grade: number;
  /** Points off the side's deduction budget (front 0..-20, back 0..-5). */
  deduction: number;
}

// FRONT — strict. 10-band chart, 20-pt budget. Bigger-side %:
//   ≤55→10  ≤60→9  ≤65→8  ≤70→7  ≤75→6  ≤80→5  ≤85→4  ≤90→3  ≤95→2  >95→1
const FRONT_BANDS: CenteringBand[] = [
  { maxBigger: 55, grade: 10, deduction: 0 },
  { maxBigger: 60, grade: 9, deduction: -2 },
  { maxBigger: 65, grade: 8, deduction: -5 },
  { maxBigger: 70, grade: 7, deduction: -8 },
  { maxBigger: 75, grade: 6, deduction: -11 },
  { maxBigger: 80, grade: 5, deduction: -14 },
  { maxBigger: 85, grade: 4, deduction: -16 },
  { maxBigger: 90, grade: 3, deduction: -18 },
  { maxBigger: 95, grade: 2, deduction: -19 },
  { maxBigger: Infinity, grade: 1, deduction: -20 },
];

// BACK — lenient. 5-band chart, 5-pt budget. Bigger-side %:
//   ≤75→10  ≤85→9  ≤90→8  ≤95→6  >95→3
// (Deliberately forgiving — matches real PSA, which forgives backs to ~75/25
//  for a 10.)
const BACK_BANDS: CenteringBand[] = [
  { maxBigger: 75, grade: 10, deduction: 0 },
  { maxBigger: 85, grade: 9, deduction: -1 },
  { maxBigger: 90, grade: 8, deduction: -2 },
  { maxBigger: 95, grade: 6, deduction: -4 },
  { maxBigger: Infinity, grade: 3, deduction: -5 },
];

function bandsFor(side: CenteringSide): CenteringBand[] {
  return side === "front" ? FRONT_BANDS : BACK_BANDS;
}

/**
 * Parse "55/45" → bigger-side percentage (the wider value as a share of the
 * pair's sum, so the result is robust to ratios that don't sum to exactly
 * 100). Returns null on malformed/empty input. Non-numeric and div-zero
 * guarded.
 */
function parseBiggerPct(ratio: string | null | undefined): number | null {
  if (!ratio || typeof ratio !== "string") return null;
  const m = ratio.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const sum = a + b;
  if (sum === 0) return null;
  return (Math.max(a, b) / sum) * 100;
}

/** Raw point deviation (major − minor) for tie-breaking. null on malformed. */
function rawDeviation(ratio: string | null | undefined): number | null {
  if (!ratio || typeof ratio !== "string") return null;
  const m = ratio.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b);
}

// Float guard. Integer ratios like 55/45 compute to 55.00000000000001 via
// max/(a+b)*100 (0.55 is not exactly representable in IEEE-754), which would
// spill one ULP past an exact band boundary (55) and drop into the next grade.
// An epsilon far smaller than any real integer-ratio spacing snaps these
// boundary hits back onto the correct band. THIS is what makes the Sinistcha
// reference card (Front L/R 55/45) grade 10 and not 9.
const BAND_EPSILON = 1e-9;
function bandFor(biggerPct: number, side: CenteringSide): CenteringBand {
  const bands = bandsFor(side);
  for (const band of bands) if (biggerPct <= band.maxBigger + BAND_EPSILON) return band;
  return bands[bands.length - 1];
}

/**
 * Per-axis subgrade (1–10). Returns null if the ratio is malformed/empty —
 * use for display, where an empty input should highlight nothing.
 */
export function centeringAxisGradeOrNull(ratio: string | null | undefined, side: CenteringSide): number | null {
  const biggerPct = parseBiggerPct(ratio);
  if (biggerPct == null) return null;
  return bandFor(biggerPct, side).grade;
}

/**
 * Per-axis subgrade (1–10), lenient: malformed/empty → 10 (no penalty). Use
 * for scoring, where missing centering data must not tank the grade.
 */
export function centeringAxisGrade(ratio: string | null | undefined, side: CenteringSide): number {
  return centeringAxisGradeOrNull(ratio, side) ?? 10;
}

/** Per-axis deduction (front 0..-20, back 0..-5), lenient: malformed → 0. */
export function centeringAxisDeduction(ratio: string | null | undefined, side: CenteringSide): number {
  const biggerPct = parseBiggerPct(ratio);
  if (biggerPct == null) return 0;
  return bandFor(biggerPct, side).deduction;
}

export interface CenteringSubgradeResult {
  /** Worst (minimum) of the four axis grades, 1–10. */
  subgrade: number;
  perAxis: Record<CenteringAxis, number>;
  /** The axis that produced the subgrade (tie → largest raw deviation). */
  worstAxis: CenteringAxis;
}

const AXIS_ORDER: { axis: CenteringAxis; side: CenteringSide }[] = [
  { axis: "frontLR", side: "front" },
  { axis: "frontTB", side: "front" },
  { axis: "backLR", side: "back" },
  { axis: "backTB", side: "back" },
];

/**
 * Centering subgrade = worst (minimum) of the four axis grades. Lenient: a
 * missing/malformed axis is treated as a perfect 10 (no penalty), so this
 * always returns a result.
 *
 * On a TIE for the worst grade, the worst axis is the one with the largest
 * RAW deviation (major − minor) — NOT array order. This is what makes e.g.
 * Front L/R 55/45 (dev 10) tying Back L/R 56/44 (dev 12) at grade 10 report
 * worstAxis = backLR (the genuinely worse axis), fixing the old bug where the
 * loop always kept the first axis on a tie.
 */
export function centeringSubgrade(
  frontLR: string | null | undefined,
  frontTB: string | null | undefined,
  backLR: string | null | undefined,
  backTB: string | null | undefined
): CenteringSubgradeResult {
  const raw: Record<CenteringAxis, string | null | undefined> = { frontLR, frontTB, backLR, backTB };
  const perAxis: Record<CenteringAxis, number> = {
    frontLR: centeringAxisGrade(frontLR, "front"),
    frontTB: centeringAxisGrade(frontTB, "front"),
    backLR: centeringAxisGrade(backLR, "back"),
    backTB: centeringAxisGrade(backTB, "back"),
  };

  let worstAxis: CenteringAxis = "frontLR";
  let worstGrade = Infinity;
  let worstDev = -1;
  for (const { axis } of AXIS_ORDER) {
    const grade = perAxis[axis];
    const dev = rawDeviation(raw[axis]) ?? 0;
    if (grade < worstGrade || (grade === worstGrade && dev > worstDev)) {
      worstGrade = grade;
      worstDev = dev;
      worstAxis = axis;
    }
  }
  return { subgrade: worstGrade, perAxis, worstAxis };
}

/**
 * Strict variant for the "MVGS Calc" button: returns null if ANY of the four
 * ratios is missing/malformed, so the UI can show a "needs all 4 ratios"
 * message instead of silently treating blanks as perfect.
 */
export function centeringSubgradeStrict(
  frontLR: string | null | undefined,
  frontTB: string | null | undefined,
  backLR: string | null | undefined,
  backTB: string | null | undefined
): CenteringSubgradeResult | null {
  for (const r of [frontLR, frontTB, backLR, backTB]) {
    if (parseBiggerPct(r) == null) return null;
  }
  return centeringSubgrade(frontLR, frontTB, backLR, backTB);
}

/**
 * Front/back centering deductions for the 100-pt score. Worst front axis →
 * front deduction (0..-20), worst back axis → back deduction (0..-5).
 * Preserves the front-20 / back-5 weighting. Lenient on missing data (→ 0).
 */
export function centeringScoreDeductions(
  frontLR: string | null | undefined,
  frontTB: string | null | undefined,
  backLR: string | null | undefined,
  backTB: string | null | undefined
): { front: number; back: number } {
  const front = Math.min(centeringAxisDeduction(frontLR, "front"), centeringAxisDeduction(frontTB, "front"));
  const back = Math.min(centeringAxisDeduction(backLR, "back"), centeringAxisDeduction(backTB, "back"));
  return { front, back };
}
