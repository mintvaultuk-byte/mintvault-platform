/**
 * MVGS v2 calibration storage helper.
 *
 * The three "[CALIBRATE]" values from MVGS-v2-spec.md §3 + §6 — whitening
 * edge-affected threshold, minor/visible split, dark-border multiplier, and
 * the crease %-span cutoffs — are not published by any grading body and must
 * be tuned against the operator's own cards, then LOCKED. They live in the
 * generic `pipeline_settings` key/value store under key "mvgs.calibration"
 * so the existing weekly-reel admin pattern (defaults-in-code,
 * row-when-overridden) applies unchanged. No schema migration needed: the
 * pipeline_settings table already exists, and a missing row falls back to
 * DEFAULT_MVGS_CALIBRATION (spec starting values).
 *
 * Two states (spec §6):
 *   1. Calibration mode — values adjustable; operator grades real cards,
 *      nudges the thresholds until grades land where their eye agrees.
 *   2. Locked + published — once satisfied, lock. The locked values become
 *      the published MVGS standard; further changes are a "standard v2.x"
 *      decision, not a casual nudge.
 *
 * The `locked` flag below carries the second state. The /standard page reads
 * the currently-locked values so the published standard always matches what
 * the engine actually computes.
 *
 * Phase 1 (this PR): storage + read helper, default-safe. The admin UI for
 * editing/locking ships in Phase 2/3 alongside the line-tool marker.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { DEFAULT_MVGS_CALIBRATION, type MvgsCalibration } from "@shared/mvgs-scoring";

export const MVGS_CALIBRATION_KEY = "mvgs.calibration";

/** Persisted shape — the calibration values + lock state. */
export interface PersistedMvgsCalibration extends MvgsCalibration {
  /** True once the operator has finished the calibration pass and locked the
   *  values. The /standard page reads these. Changing them while locked
   *  should be a deliberate v2.x bump, not a casual nudge. */
  locked: boolean;
  /** ISO8601 timestamp of the last edit (admin-facing audit). */
  updatedAt?: string;
  /** Operator who last edited (admin email or "system" for defaults). */
  updatedBy?: string;
}

/**
 * Read the current calibration. Falls back to spec defaults if no row exists
 * or the row is malformed — engine call sites never crash on missing config.
 */
export async function loadMvgsCalibration(): Promise<PersistedMvgsCalibration> {
  try {
    const result = await db.execute(
      sql`SELECT value FROM pipeline_settings WHERE key = ${MVGS_CALIBRATION_KEY} LIMIT 1`
    );
    const row = (result.rows[0] as { value?: unknown } | undefined)?.value;
    if (!row || typeof row !== "object") return { ...DEFAULT_MVGS_CALIBRATION, locked: false };
    const r = row as Partial<PersistedMvgsCalibration>;
    return {
      edgeAffectedPct: numberOr(r.edgeAffectedPct, DEFAULT_MVGS_CALIBRATION.edgeAffectedPct),
      minorVisibleSplitPct: numberOr(r.minorVisibleSplitPct, DEFAULT_MVGS_CALIBRATION.minorVisibleSplitPct),
      darkBorderMultiplier: numberOr(r.darkBorderMultiplier, DEFAULT_MVGS_CALIBRATION.darkBorderMultiplier),
      creaseMinorMaxPct: numberOr(r.creaseMinorMaxPct, DEFAULT_MVGS_CALIBRATION.creaseMinorMaxPct),
      creaseHalfMaxPct: numberOr(r.creaseHalfMaxPct, DEFAULT_MVGS_CALIBRATION.creaseHalfMaxPct),
      creaseThreeQuarterMaxPct: numberOr(r.creaseThreeQuarterMaxPct, DEFAULT_MVGS_CALIBRATION.creaseThreeQuarterMaxPct),
      locked: r.locked === true,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined,
      updatedBy: typeof r.updatedBy === "string" ? r.updatedBy : undefined,
    };
  } catch (err) {
    // DB unreachable or row malformed — engine still scores; spec defaults
    // apply. Logged once per call, not thrown, so the grading path never
    // fails because of a config read.
    console.warn("[mvgs-calibration] load failed, using defaults:", (err as Error).message);
    return { ...DEFAULT_MVGS_CALIBRATION, locked: false };
  }
}

/**
 * Upsert the calibration row. Refuses to update if `locked === true` on the
 * persisted row UNLESS the caller passes `force: true` (used by an explicit
 * "unlock + edit" admin action). Phase 1 doesn't expose an admin UI — this
 * helper is here so the API + tests can write the row.
 */
export async function saveMvgsCalibration(
  value: PersistedMvgsCalibration,
  opts?: { force?: boolean; updatedBy?: string }
): Promise<{ ok: true } | { ok: false; reason: "locked" }> {
  if (!opts?.force) {
    const current = await loadMvgsCalibration();
    if (current.locked) return { ok: false, reason: "locked" };
  }
  const next: PersistedMvgsCalibration = {
    ...value,
    updatedAt: new Date().toISOString(),
    updatedBy: opts?.updatedBy ?? "system",
  };
  await db.execute(sql`
    INSERT INTO pipeline_settings (key, value, updated_by)
    VALUES (${MVGS_CALIBRATION_KEY}, ${JSON.stringify(next)}::jsonb, ${opts?.updatedBy ?? "system"})
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
  `);
  return { ok: true };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
