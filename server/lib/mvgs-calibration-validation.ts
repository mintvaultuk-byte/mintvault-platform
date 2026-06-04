/**
 * Validation + clamp + ordering for the Grading Calibration admin panel
 * (Phase 3 Step 1). Pure functions, no DB, no HTTP — server route imports
 * them; vitest exercises them without booting express.
 *
 * Two responsibilities, kept separate:
 *
 *   1. `clampField(key, raw)` — sanitises a single field value to its allowed
 *      range. Used per-PATCH so a typo in the UI (or hostile client) can't
 *      drive the engine into nonsense. Returns null when `raw` isn't a finite
 *      number; route layer treats that as "field absent / skip".
 *
 *   2. `validateCalibration(values)` — whole-object cross-field check. The
 *      crease cutoffs must be strictly ordered minor < half < threeQuarter;
 *      out-of-order cutoffs collapse a bracket to nothing, so the route
 *      REJECTS them with a clear error instead of silently saving. Returns
 *      `{ok: true}` or `{ok: false, error: string}` — the error string is
 *      what the route ships back as `400 Bad Request`.
 *
 * Field min/max picks (spec §3 + §6 derivation):
 *
 *   - edgeAffectedPct:           1..50    — must be > 0; >50 would call
 *                                           more than half an edge "affected"
 *                                           by definition of edge length.
 *   - minorVisibleSplitPct:      1..90    — same; >90 makes the visible tier
 *                                           unreachable.
 *   - darkBorderMultiplier:      1.0..2.5 — ≥1 so it never reduces coverage;
 *                                           2.5 is the sanity ceiling.
 *   - creaseMinorMaxPct:         1..99
 *   - creaseHalfMaxPct:          1..99
 *   - creaseThreeQuarterMaxPct:  1..99    — ordering enforced separately.
 */

import { DEFAULT_MVGS_CALIBRATION, type MvgsCalibration } from "@shared/mvgs-scoring";

/** Allowed range for each calibration field. The lock-step bounds here mirror
 *  the client-side input `min` / `max` attributes — if you change one, change
 *  the other. */
export const FIELD_RANGES: Record<keyof MvgsCalibration, { min: number; max: number }> = {
  edgeAffectedPct: { min: 1, max: 50 },
  minorVisibleSplitPct: { min: 1, max: 90 },
  darkBorderMultiplier: { min: 1, max: 2.5 },
  creaseMinorMaxPct: { min: 1, max: 99 },
  creaseHalfMaxPct: { min: 1, max: 99 },
  creaseThreeQuarterMaxPct: { min: 1, max: 99 },
};

/** Clamp a single field. Returns the clamped number or null if `raw` isn't a
 *  finite number (route treats null as "field absent — keep current value").
 *  `null` / `undefined` short-circuit BEFORE `Number()` because `Number(null)`
 *  is 0 (a finite number) which would clamp to min — not the intent of "field
 *  not provided." */
export function clampField(key: keyof MvgsCalibration, raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const { min, max } = FIELD_RANGES[key];
  return Math.max(min, Math.min(max, n));
}

/** Cross-field validation. The crease cutoffs MUST be strictly ordered:
 *  minor < half < threeQuarter. Equal or out-of-order values collapse a
 *  bracket to nothing and rebound on the ladder lookup in non-obvious ways.
 *  The route rejects with this error instead of silently letting it through. */
export function validateCalibration(values: MvgsCalibration): { ok: true } | { ok: false; error: string } {
  for (const k of Object.keys(FIELD_RANGES) as Array<keyof MvgsCalibration>) {
    const v = values[k];
    if (!Number.isFinite(v)) {
      return { ok: false, error: `${k} must be a finite number (got ${String(v)})` };
    }
    const { min, max } = FIELD_RANGES[k];
    if (v < min || v > max) {
      return { ok: false, error: `${k} out of range (must be ${min}..${max}, got ${v})` };
    }
  }
  if (!(values.creaseMinorMaxPct < values.creaseHalfMaxPct)) {
    return {
      ok: false,
      error: `creaseMinorMaxPct (${values.creaseMinorMaxPct}) must be < creaseHalfMaxPct (${values.creaseHalfMaxPct})`,
    };
  }
  if (!(values.creaseHalfMaxPct < values.creaseThreeQuarterMaxPct)) {
    return {
      ok: false,
      error: `creaseHalfMaxPct (${values.creaseHalfMaxPct}) must be < creaseThreeQuarterMaxPct (${values.creaseThreeQuarterMaxPct})`,
    };
  }
  return { ok: true };
}

/** Convenience — produce the default object. Re-exported so the client page
 *  and the route layer agree on what "reset to defaults" means. */
export function defaultCalibration(): MvgsCalibration {
  return { ...DEFAULT_MVGS_CALIBRATION };
}
