/**
 * MVGS v2 input builder — enforces precedence between v2 MEASUREMENTS and
 * legacy BOOLEAN checkboxes when constructing the input passed to the
 * engine (shared/mvgs-scoring.ts).
 *
 * Single rule, applied at every call site (server + client preview):
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ When a measurement is present, the engine ALWAYS uses it.        │
 *   │ The legacy boolean (has_crease / has_tear) is ONLY consulted as  │
 *   │ a fallback when the corresponding measurement is null.           │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The legacy fallback translates the boolean into the equivalent minimum-
 * severity measurement so the engine's ceiling logic is the single
 * authority:
 *
 *   has_crease=true, crease_span_pct=null   →  spanPct=10  (cap 4.5)
 *   has_tear=true,   tear_severity=null     →  severity="minor"  (cap 2)
 *
 * These values intentionally match `legacyCeilingForFlags` so the legacy
 * path produces the same ceiling as before. When the measurement IS set,
 * the boolean is ignored — no double-counting, no fighting precedence,
 * no path can produce a different ceiling than what the engine resolves.
 *
 * Wrinkle has no legacy boolean (the new severity input is the only
 * source). Whitening edges have no legacy fallback either — pin-based
 * edge deductions remain the engine's fallback when whiteningLines is
 * empty (handled inside computeMvgsScore via min(line, pins)).
 *
 * Engine (mvgs-scoring.ts) is UNCHANGED — this helper translates upstream.
 */

import {
  computeMvgsScore,
  type MvgsCalibration,
  type MvgsDefect,
  type MvgsInput,
  type MvgsResult,
  type TearSeverity,
  type WhiteningEdge,
  type WrinkleSeverity,
} from "./mvgs-scoring";

export interface MvgsV2PersistedFields {
  // Phase 1 fields (unchanged)
  centeringFrontLr: string | null;
  centeringFrontTb: string | null;
  centeringBackLr: string | null;
  centeringBackTb: string | null;
  defects: MvgsDefect[];
  darkBorderFront: boolean;
  darkBorderBack: boolean;
  eyeAppealModifier: number;

  // Phase 2 measurement inputs (all optional)
  whiteningLines?: WhiteningEdge[] | null;
  creaseSpanPct?: number | null;
  wrinkleSeverity?: WrinkleSeverity | null;
  tearSeverity?: TearSeverity | null;

  // Legacy booleans (used ONLY as fallback when the measurement is null).
  hasCrease?: boolean;
  hasTear?: boolean;
}

/** Equivalent crease span (% of card axis) for the legacy "has_crease" boolean.
 *  Maps to the least-severe new bracket (<25% span → cap 4.5) so the legacy
 *  fallback produces the same ceiling as the v1 `hasCrease` boolean did. */
export const LEGACY_HAS_CREASE_SPAN_PCT = 10;

/** Equivalent severity for the legacy "has_tear" boolean. The minor tear
 *  bucket caps at 2 — the existing legacy behaviour. The boolean never
 *  escalates to "major" / NO; that requires an explicit measurement input. */
export const LEGACY_HAS_TEAR_SEVERITY: TearSeverity = "minor";

/** Build the engine input from persisted cert fields + calibration.
 *
 *  This is the ONLY place precedence is resolved. Every call site (the 6
 *  computeMvgsScore consumers) routes through this helper so a measurement
 *  always wins over its legacy boolean, deterministically.
 *
 *  Calibration: server callers pass the loaded `mvgs.calibration` row.
 *  Client preview can pass `DEFAULT_MVGS_CALIBRATION` from mvgs-scoring.
 *  Omitted = engine uses defaults. */
export function buildMvgsInput(fields: MvgsV2PersistedFields, calibration?: MvgsCalibration): MvgsInput {
  // ── Crease precedence ──────────────────────────────────────────────────
  // Measurement wins. If absent AND the legacy boolean is set, translate
  // the boolean into the minimum-severity equivalent measurement. Else
  // null → engine returns no crease ceiling.
  let creaseSpanPct: number | null = fields.creaseSpanPct ?? null;
  if (creaseSpanPct == null && fields.hasCrease) {
    creaseSpanPct = LEGACY_HAS_CREASE_SPAN_PCT;
  }

  // ── Tear precedence ────────────────────────────────────────────────────
  // Same pattern. Note: the legacy boolean NEVER escalates to "major"
  // (which routes to NO) — that requires an explicit operator selection.
  let tearSeverity: TearSeverity | null = fields.tearSeverity ?? null;
  if (tearSeverity == null && fields.hasTear) {
    tearSeverity = LEGACY_HAS_TEAR_SEVERITY;
  }

  return {
    centeringFrontLr: fields.centeringFrontLr,
    centeringFrontTb: fields.centeringFrontTb,
    centeringBackLr: fields.centeringBackLr,
    centeringBackTb: fields.centeringBackTb,
    defects: fields.defects,
    darkBorderFront: fields.darkBorderFront,
    darkBorderBack: fields.darkBorderBack,
    eyeAppealModifier: fields.eyeAppealModifier,
    // Whitening lines pass straight through (no legacy boolean equivalent
    // — pin-based edge deductions remain the engine's existing fallback).
    whiteningEdges: fields.whiteningLines ?? null,
    creaseSpanPct,
    wrinkleSeverity: fields.wrinkleSeverity ?? null,
    tearSeverity,
    calibration,
  };
}

/** Convenience wrapper — build input + score in one call. */
export function scoreMvgsV2(fields: MvgsV2PersistedFields, calibration?: MvgsCalibration): MvgsResult {
  return computeMvgsScore(buildMvgsInput(fields, calibration));
}
