/**
 * MVGS v1.4 — THE FROZEN GRADING AUTHORITY. Immutable. Do not edit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS A HISTORICAL PROTOCOL VERSION, NOT ORDINARY APPLICATION CODE
 * ══════════════════════════════════════════════════════════════════════════
 * Every certificate stamped `mvgs_rules_version = "v1.4"` must stay
 * reproducible under exactly these rules, forever. A grade is a published claim
 * about someone's physical property; re-interpreting it later silently rewrites
 * that claim on slabs already in customers' hands.
 *
 * So: this module and everything in its dependency closure are frozen by
 * SHA-256 in mvgs-v1_4-freeze.manifest.json, and by golden vectors in
 * tests/mvgs-v14-golden-vectors.test.ts. Both fail CI on any drift, whether the
 * change is to a threshold, a weight, a comment, or a dependency three files
 * away.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IF YOU ARE HERE TO CHANGE HOW CARDS GRADE
 * ══════════════════════════════════════════════════════════════════════════
 * Do not edit v1.4. Create `shared/mvgs/v1_5/`, implement the new rules there,
 * register it in shared/mvgs/registry.ts, and stamp new grades "v1.5". v1.4
 * stays exactly as it is so the ~700 certificates already issued under it — and
 * the physical slabs printed from them — remain interpretable.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE ENGINE FILES THEMSELVES ARE NOT INSIDE THIS DIRECTORY
 * ══════════════════════════════════════════════════════════════════════════
 * A deliberate deviation from the "move everything under v1_4/" shape, taken
 * because the freeze must not risk the thing it protects. Physically relocating
 * shared/mvgs-scoring.ts, shared/centering.ts, shared/pristine.ts and
 * shared/mvgs-input-builder.ts would rewrite imports across ~50 server modules
 * and produce a diff far too large to review line-by-line for behavioural
 * neutrality — on a system where a one-line change already proved able to make
 * a published grade unissuable for months.
 *
 * The immutability guarantee does not come from directory layout. It comes from
 * the hash manifest, the golden vectors and the CI gate, all of which cover the
 * files wherever they live. THIS module is the version boundary: it is the only
 * supported way to invoke v1.4, it pins the calibration, and it is what a
 * future v1.5 will sit beside.
 */
import { scoreMvgsV2, type MvgsV2PersistedFields } from "../../mvgs-input-builder";
import { gradeFromMvgsScore, type MvgsResult } from "../../mvgs-scoring";
import { centeringSubgrade, centeringSubgradeStrict } from "../../centering";
import { isPristine, type PristineSubgrades } from "../../pristine";
import { mvgsTierName } from "../../grade-presentation";
import { MVGS_V1_4_CALIBRATION, MVGS_V1_4_VERSION } from "./calibration";

export { MVGS_V1_4_CALIBRATION, MVGS_V1_4_VERSION };

/**
 * Score a card under MVGS v1.4.
 *
 * The calibration argument is deliberately ABSENT. Before the freeze, callers
 * passed `await loadMvgsCalibration()` — six thresholds read from a mutable
 * `pipeline_settings` row that was `locked: false` in production, so v1.4's
 * behaviour depended on database state that anyone with admin access could
 * change without touching a protected byte. v1.4 now carries its own frozen
 * calibration and cannot be re-tuned. Re-tuning means v1.5.
 */
export function scoreMvgsV1_4(fields: MvgsV2PersistedFields): MvgsResult {
  return scoreMvgsV2(fields, MVGS_V1_4_CALIBRATION);
}

/** Numeric 1-10 grade for a v1.4 score. */
export function gradeForScoreV1_4(score: number): number {
  return gradeFromMvgsScore(score);
}

/** Tier NAME for a v1.4 grade ("Mint+", "NM-Mint+", …). */
export function tierNameV1_4(grade: number): string {
  return mvgsTierName(grade);
}

/** Centering subgrade (worst of the four axes) under v1.4's chart. */
export const centeringSubgradeV1_4 = centeringSubgrade;
/** Strict variant: null unless all four ratios are present and well-formed. */
export const centeringSubgradeStrictV1_4 = centeringSubgradeStrict;

/** Pristine 10P / Black Label gate under v1.4. */
export function isPristineV1_4(
  sub: PristineSubgrades,
  overall: number,
  deductions?: Record<string, number> | null
): boolean {
  return isPristine(sub, overall, deductions);
}
