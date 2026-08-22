/**
 * MVGS v1.4 — FROZEN CALIBRATION. Do not edit. Ever.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 * Until the freeze, MVGS v1.4's grading behaviour was NOT determined by code
 * alone. `server/lib/mvgs-calibration.ts` reads six scoring thresholds out of a
 * MUTABLE database row (`pipeline_settings`, key `mvgs.calibration`) and passes
 * them into the engine, where they drive:
 *
 *   • the §3 whitening-edges ladder, which sets the EDGES subgrade
 *   • the dark-border whitening multiplier
 *   • the crease-span ceilings, which cap the OVERALL grade
 *
 * That row was `locked: false` in production on 2026-08-22. Anyone with admin
 * access could have changed how a v1.4 card grades without touching one byte of
 * protected source — which would have made a file-hash freeze a false promise.
 *
 * A frozen ruleset cannot have a mutable input. So v1.4 now carries its own
 * calibration, here, as constants.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PROVENANCE — these are not "sensible defaults", they are what production ran
 * ══════════════════════════════════════════════════════════════════════════
 * Read from the production database (endpoint ep-wispy-morning, release v1120,
 * commit 320c731a) on 2026-08-22. The stored row was written by "mvgs-v2-launch"
 * on 2026-06-04 and is byte-identical to DEFAULT_MVGS_CALIBRATION, so pinning
 * changes NOTHING about how any card grades — it only removes the ability for
 * the row to change it later:
 *
 *   {"edgeAffectedPct":10,"minorVisibleSplitPct":25,"darkBorderMultiplier":1.25,
 *    "creaseMinorMaxPct":25,"creaseHalfMaxPct":50,"creaseThreeQuarterMaxPct":75}
 *
 * tests/mvgs-v14-freeze.test.ts asserts this equals DEFAULT_MVGS_CALIBRATION, so
 * the equivalence is proven on every CI run rather than asserted in a comment.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IF YOU WANT TO RECALIBRATE
 * ══════════════════════════════════════════════════════════════════════════
 * You are describing a NEW RULES VERSION. Create shared/mvgs/v1_5/, give it its
 * own calibration, stamp `mvgs_rules_version = "v1.5"`, and leave every one of
 * these numbers exactly where it is so the certificates already issued under
 * v1.4 stay reproducible. Editing this file re-grades history.
 */
import type { MvgsCalibration } from "../../mvgs-scoring";

/**
 * The calibration MVGS v1.4 is defined by. Frozen; `as const` so a caller
 * cannot mutate it in place, and deliberately NOT read from any database.
 */
export const MVGS_V1_4_CALIBRATION: Readonly<MvgsCalibration> = Object.freeze({
  edgeAffectedPct: 10,
  minorVisibleSplitPct: 25,
  darkBorderMultiplier: 1.25,
  creaseMinorMaxPct: 25,
  creaseHalfMaxPct: 50,
  creaseThreeQuarterMaxPct: 75,
} as const);

/** The rules version these constants define. Stamped onto every grade write. */
export const MVGS_V1_4_VERSION = "v1.4" as const;
