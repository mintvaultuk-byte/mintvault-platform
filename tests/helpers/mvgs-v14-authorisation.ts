/**
 * MVGS v1.4 half-grade reconciliation — the ONE founder authorisation, stated once.
 *
 * WHY THIS FILE EXISTS
 * ==========================================================================================
 * This repository carries TWO equivalent founder-signature guards over the MVGS engine files:
 * tests/variant-line-consolidation.test.ts (item 14) and tests/structured-variant-persistence.
 * test.ts (item 22). Signature G was once registered in only one of them, so the same
 * founder-authorised change passed one guard and was refused by the other — a defect in the
 * guard pair, recorded in G's own comment. This authorisation is therefore written ONCE, here,
 * and both guards call it, so neither can be satisfied by something the other would refuse.
 *
 * WHAT WAS AUTHORISED — founder approval, 2026-08-22
 * ==========================================================================================
 * Grade 9.5 (Mint+) is published at /standard, listed in NUMERIC_GRADES, bracketed in
 * GRADE_BRACKET_TOP, named by mvgsTierName and rendered by both the slab and the certificate
 * PDF — and it had NEVER been issued. A read of the live production database on 2026-08-22
 * found 0 of 714 graded certificates holding 9.5 while 140 sat at a lowest subgrade of 9.
 *
 * The cause was a boundary, not a rounding error. The floor rule's +0.5 high-variance bump
 * required an aggregate gap of 4 between the lowest subgrade and the others; with lowest = 9
 * the other three top out at 10 and can never exceed it by more than 3 in total. The bump was
 * arithmetically unreachable at the 9 rung and ONLY at the 9 rung, so cards fell 10 -> 9.
 *
 * THREE narrowly-scoped changes were approved, and nothing else:
 *
 *   1. shared/mvgs-scoring.ts — the floor rule's variance threshold is taken relative to the
 *      largest gap the rung can produce. Two executable lines change: the threshold itself,
 *      and `remainingToGrade` gaining an `export` so the grade authority can stop carrying a
 *      hand-copied duplicate that had drifted. NO deduction weight, band boundary, grade
 *      bracket, cap, ceiling or Pristine rule may move.
 *
 *   2. shared/centering.ts — PURELY ADDITIVE. A renderer that turns the existing band tables
 *      into prose. The bands themselves are untouched: this file may not lose a single line.
 *
 *   3. server/grading-prompt.ts — the four hand-written restatements of the centering chart,
 *      all of which had drifted from the engine (two claimed a 10 required 52/48 or better
 *      when the engine and the published standard both allow 55/45), are replaced by the
 *      renderer above. PROSE ONLY: no executable scoring logic may enter this file.
 *
 * WHAT THIS AUTHORISES NO PART OF
 * ==========================================================================================
 * It does not permit a change to any deduction weight, centering band, grade bracket, score
 * cap, structural ceiling, calibration value, subgrade ladder value, the Pristine/Black Label
 * gate, or certificate numbering. Those are all still hard-refused below and by the callers'
 * own calculation-token assertions, which are applied UNCHANGED on top of this.
 */
import { addedCodeOf } from "./strip-non-code";

/** Files this authorisation covers. Anything else stays hard-blocked by the callers. */
export const MVGS_V14_FILES = ["shared/mvgs-scoring.ts", "shared/centering.ts", "server/grading-prompt.ts"] as const;

/**
 * The ONLY executable lines shared/mvgs-scoring.ts is permitted to LOSE. Removal is the
 * dangerous direction: an added line can be inspected, but a silently deleted cap, ceiling or
 * band is how a scoring change hides. Both entries are quoted verbatim from the v1.3 source.
 */
const MVGS_SCORING_AUTHORISED_REMOVALS = [
  "let maxGrade = gap >= 4 ? lowest + 0.5 : lowest;",
  "function remainingToGrade(remaining: number): number {",
];

/** Executable lines, de-commented and de-prosed, for one side of a diff. */
function codeLines(diff: string, sign: "+" | "-"): string[] {
  return addedCodeOf(diff, sign)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== "*" && !l.startsWith("*"));
}

/**
 * Numbers that mean something to a grade. A scoring table entry, a band boundary, a bracket
 * edge or a cap all match; the two named threshold constants introduced by this change are
 * matched separately and allowed by name, so they cannot be used as cover for anything else.
 */
const SCORING_LITERAL =
  /(maxBigger|deduction\s*:|grade\s*:\s*-?\d|return\s+-?\d+(\.\d+)?\s*;|>=\s*\d+(\.\d+)?\s*\)?\s*return|raw\s*=\s*-|\*\s*1\.\d|\bcap\w*\s*=\s*\d)/;

export interface MvgsV14Verdict {
  authorised: boolean;
  reason: string;
}

/**
 * Decide whether one protected engine file's diff is EXACTLY the founder-authorised v1.4
 * change and nothing more. Returns a verdict rather than asserting, so each caller can fail
 * with its own message and still apply its own extra prohibitions afterwards.
 */
export function mvgsV14Verdict(file: string, diff: string): MvgsV14Verdict {
  const added = codeLines(diff, "+");
  const removed = codeLines(diff, "-");
  const addedSrc = added.join("\n");

  if (file === "shared/centering.ts") {
    // Additive only. One lost line would mean a band moved.
    if (removed.length > 0) {
      return { authorised: false, reason: `shared/centering.ts must be purely additive; it removed: ${removed[0]}` };
    }
    // A band ENTRY is an object-literal field (`maxBigger: 55`). READING `band.maxBigger` to
    // render the table as prose is the whole point of the authorised change, so the check is on
    // the field declaration, not the property access.
    if (/maxBigger\s*:/.test(addedSrc)) {
      return { authorised: false, reason: "shared/centering.ts may not add or alter a band table entry" };
    }
    if (!/centeringChartLines|centeringChartText/.test(addedSrc)) {
      return { authorised: false, reason: "shared/centering.ts change does not match the authorised chart renderer" };
    }
    return { authorised: true, reason: "authorised: additive centering chart renderer" };
  }

  if (file === "server/grading-prompt.ts") {
    // Prose file. It may gain the interpolated chart and nothing executable that scores.
    if (!/centeringChartText|CENTERING_CHART/.test(addedSrc)) {
      return {
        authorised: false,
        reason: "server/grading-prompt.ts change does not match the authorised chart wiring",
      };
    }
    const scoring = added.filter((l) => SCORING_LITERAL.test(l));
    if (scoring.length > 0) {
      return { authorised: false, reason: `server/grading-prompt.ts may not gain scoring logic: ${scoring[0]}` };
    }
    return { authorised: true, reason: "authorised: prompts read the canonical centering chart" };
  }

  if (file === "shared/mvgs-scoring.ts") {
    const unauthorisedRemovals = removed.filter((l) => !MVGS_SCORING_AUTHORISED_REMOVALS.includes(l));
    if (unauthorisedRemovals.length > 0) {
      return {
        authorised: false,
        reason: `shared/mvgs-scoring.ts removed a line outside the authorisation: ${unauthorisedRemovals[0]}`,
      };
    }
    // The threshold change itself, named exactly.
    const hasThreshold =
      /const\s+varianceThreshold\s*=\s*Math\.min\(\s*HIGH_VARIANCE_GAP\s*,\s*MAX_SUBGRADE_GAP_PER_CATEGORY\s*\*\s*\(10\s*-\s*lowest\)\s*\)/.test(
        addedSrc
      ) && /let\s+maxGrade\s*=\s*gap\s*>=\s*varianceThreshold/.test(addedSrc);
    if (!hasThreshold) {
      return {
        authorised: false,
        reason: "shared/mvgs-scoring.ts change does not match the authorised floor-rule fix",
      };
    }
    // The two named constants are the ONLY new scoring-shaped literals permitted.
    const NAMED_CONSTANTS = /^const (HIGH_VARIANCE_GAP = 4|MAX_SUBGRADE_GAP_PER_CATEGORY = 3);$/;
    const stray = added.filter((l) => SCORING_LITERAL.test(l) && !NAMED_CONSTANTS.test(l));
    if (stray.length > 0) {
      return {
        authorised: false,
        reason: `shared/mvgs-scoring.ts may not add or alter a scoring value: ${stray[0]}`,
      };
    }
    return { authorised: true, reason: "authorised: floor-rule variance threshold + rules-version constant" };
  }

  return { authorised: false, reason: `${file} is not covered by the MVGS v1.4 authorisation` };
}
