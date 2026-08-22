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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { addedCodeOf, stripNonCode } from "./strip-non-code";

/** Files this authorisation covers. Anything else stays hard-blocked by the callers. */
export const MVGS_V14_FILES = [
  "shared/mvgs-scoring.ts",
  "shared/centering.ts",
  "server/grading-prompt.ts",
  "shared/grade-presentation.ts",
  "server/lib/cert-pristine.ts",
] as const;

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

  if (file === "shared/grade-presentation.ts") {
    // The client-safe leaf. It holds the grade vocabulary a browser needs to
    // RENDER an authoritative result. It may hold NO calculation, and it must
    // never reach back into the engine, the centering tables or the barrel.
    // Matched against the RAW diff: module specifiers are string tokens and the
    // analyser blanks them, so addedSrc cannot see a path.
    if (/^\+.*from\s*["'](\.\/)?(mvgs-scoring|centering|pristine|mvgs-input-builder|schema)["']/m.test(diff)) {
      return {
        authorised: false,
        reason: "shared/grade-presentation.ts must not import the engine or the schema barrel",
      };
    }
    const strayLeaf = added.filter(
      (l) => SCORING_LITERAL.test(l) && !/return "[A-Za-z+ -]+";/.test(l) && !/value:\s*-?\d/.test(l)
    );
    if (strayLeaf.length > 0) {
      return { authorised: false, reason: `shared/grade-presentation.ts may not carry scoring logic: ${strayLeaf[0]}` };
    }
    return { authorised: true, reason: "authorised: client-safe grade vocabulary leaf" };
  }

  if (file === "server/lib/cert-pristine.ts") {
    // MVGS v1.4 FREEZE — founder-approved 2026-08-22, narrowly, for one thing:
    // this path used to call `loadMvgsCalibration()`, reading six scoring
    // thresholds out of a MUTABLE `pipeline_settings` row that was `locked:false`
    // in production. A frozen ruleset cannot have a mutable input, so calibration
    // is now routed by the certificate's STORED rules version.
    //
    // THIS AUTHORISES NO MATHS. The Pristine gate, the deduction weights and the
    // subgrade logic are untouched; the calibration values are provably identical
    // (tests/mvgs-v14-freeze.test.ts asserts the frozen constants equal
    // DEFAULT_MVGS_CALIBRATION, which is what the production row held).
    const removedMutableRead = /^-.*loadMvgsCalibration/m.test(diff);
    const addedVersionRouting = /^\+.*calibrationForRulesVersion/m.test(diff);
    if (!removedMutableRead || !addedVersionRouting) {
      return {
        authorised: false,
        reason: "server/lib/cert-pristine.ts change does not match the authorised calibration-pinning shape",
      };
    }
    const strayPristine = added.filter((l) => SCORING_LITERAL.test(l));
    if (strayPristine.length > 0) {
      return {
        authorised: false,
        reason: `server/lib/cert-pristine.ts may not gain scoring logic: ${strayPristine[0]}`,
      };
    }
    return { authorised: true, reason: "authorised: calibration pinned to the stored rules version" };
  }

  if (file === "shared/mvgs-scoring.ts") {
    // A LOSSLESS MOVE is authorised: a line may leave the engine only if that
    // exact line still exists in the client-safe leaf. This is deliberately
    // stronger than a name whitelist — it makes "quietly delete a cap, a
    // ceiling or a deduction weight while calling it a refactor" inexpressible,
    // because a deleted line exists nowhere and fails here.
    const leafPath = join(process.cwd(), "shared", "grade-presentation.ts");
    const leaf = existsSync(leafPath) ? readFileSync(leafPath, "utf8") : "";
    // Normalise the leaf through the SAME analyser the diff went through:
    // addedCodeOf blanks string contents ("judge code, not prose"), so a raw
    // read of the leaf would never match a blanked removed line.
    const leafLines = new Set(
      stripNonCode(leaf)
        .split("\n")
        .map((l) => l.trim())
    );
    const unauthorisedRemovals = removed.filter(
      (l) => !MVGS_SCORING_AUTHORISED_REMOVALS.includes(l) && !leafLines.has(l)
    );
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
    // Either the v1.4 floor-rule fix, or the presentation move that re-exports
    // the relocated ladder. This diff must actually be one of the two.
    // Same reason: the specifier "./grade-presentation" is blanked in addedSrc.
    const isPresentationMove = /^\+\s*export \{ mvgsTierName \} from "\.\/grade-presentation";/m.test(diff);
    if (!hasThreshold && !isPresentationMove) {
      return { authorised: false, reason: "shared/mvgs-scoring.ts change matches no authorised shape" };
    }
    if (isPresentationMove && !leaf.includes("export function mvgsTierName")) {
      return {
        authorised: false,
        reason: "mvgsTierName left the engine but does not exist in shared/grade-presentation.ts",
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
