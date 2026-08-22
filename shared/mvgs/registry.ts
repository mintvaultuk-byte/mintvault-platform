/**
 * MVGS rules-version registry — how a stored `mvgs_rules_version` is resolved
 * to the rules that produced it.
 *
 * The point of stamping a version on every grade is that a future ruleset must
 * never silently reinterpret an already-issued certificate. This registry is
 * where that promise is kept: given the version stored on a row, it returns the
 * calibration those rules were defined by. It FAILS CLOSED on a version it does
 * not know rather than guessing with the newest rules, because guessing is
 * exactly the failure this design exists to prevent.
 *
 * ADDING A FUTURE VERSION
 * ──────────────────────────────────────────────────────────────────────────
 * Create shared/mvgs/v1_5/, give it its own frozen calibration, add it to
 * KNOWN_RULES_VERSIONS below, and stamp new grades "v1.5". Do not edit v1.4.
 */
import type { MvgsCalibration } from "../mvgs-scoring";
import { MVGS_V1_4_CALIBRATION, MVGS_V1_4_VERSION } from "./v1_4/calibration";

/** The version stamped on grades written today. */
export const CURRENT_MVGS_RULES_VERSION = MVGS_V1_4_VERSION;

/**
 * Versions this build can interpret.
 *
 * v1.3 maps to v1.4's calibration DELIBERATELY, and this is the one place that
 * needs justifying rather than asserting. v1.4 differed from v1.3 in exactly one
 * respect — the floor rule's high-variance threshold became attainable at the 9
 * rung, so grade 9.5 could finally be awarded. The six calibration thresholds
 * were not touched, and production's stored calibration row has been unchanged
 * since 2026-06-04, well before either version. So a v1.3 row re-read under
 * these constants yields precisely the deduction figures it was issued with.
 *
 * This mapping affects only recomputed DISPLAY data — the defect map on a
 * label, the Pristine gate on a certificate page. It never rewrites a stored
 * grade: those are read from the database, not recalculated.
 */
const KNOWN_RULES_VERSIONS: Record<string, Readonly<MvgsCalibration>> = {
  "v1.3": MVGS_V1_4_CALIBRATION,
  "v1.4": MVGS_V1_4_CALIBRATION,
};

export class UnknownMvgsRulesVersion extends Error {
  constructor(version: string) {
    super(
      `Certificate carries MVGS rules version "${version}", which this build cannot interpret. ` +
        `Refusing to grade or re-render it under a different ruleset — that would silently restate ` +
        `a published grade. Deploy a build that implements "${version}".`
    );
    this.name = "UnknownMvgsRulesVersion";
  }
}

/**
 * Calibration for a stored rules version.
 *
 * `null`/empty means a row written before the column existed. Migration 0111
 * backfilled every graded row to "v1.3", so in practice this is only reached by
 * rows with no grade at all; it resolves to the current rules, which is what a
 * fresh grade will be stamped with anyway.
 */
export function calibrationForRulesVersion(version: string | null | undefined): Readonly<MvgsCalibration> {
  if (version == null || version === "") return MVGS_V1_4_CALIBRATION;
  const known = KNOWN_RULES_VERSIONS[version];
  if (!known) throw new UnknownMvgsRulesVersion(version);
  return known;
}

/** True if this build can interpret grades stamped `version`. */
export function isKnownRulesVersion(version: string | null | undefined): boolean {
  return version == null || version === "" || version in KNOWN_RULES_VERSIONS;
}
