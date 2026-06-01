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

/** Whitening line as persisted on the cert (`certificates.whitening_lines` jsonb).
 *  Superset of the engine's WhiteningEdge — extra fields (id, start/end for
 *  redraw, color for display) ride alongside the three engine-visible fields.
 *  Narrowed to WhiteningEdge at the buildMvgsInput boundary so the engine
 *  never sees colour, ids, or geometry. */
export interface PersistedWhiteningLine {
  id?: string;
  side: "front" | "back";
  edge: "top" | "right" | "bottom" | "left";
  coveragePct: number;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  /** Display-only — hex string. Stripped before the engine sees the entry. */
  color?: string;
}

/** Crease line as persisted on the cert (`certificates.crease_lines` jsonb).
 *  Multi-crease list — engine input derives `creaseSpanPct = max(spanPct)`
 *  per spec §4/§5 (longest crease wins, no compounding). */
export interface PersistedCreaseLine {
  id: string;
  side: "front" | "back";
  spanPct: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Display-only — hex string. */
  color?: string;
}

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

  // Phase 2 measurement inputs (all optional). whiteningLines accepts both
  // the bare engine shape and the persisted superset (with id/start/end/color)
  // — the builder narrows down to the engine shape at the boundary.
  whiteningLines?: PersistedWhiteningLine[] | WhiteningEdge[] | null;
  /** Multi-crease persistence (Phase 2.1). Engine reads max(spanPct). When
   *  supplied, takes precedence over the legacy single creaseSpanPct field. */
  creaseLines?: PersistedCreaseLine[] | null;
  /** Legacy single-crease % (pre-2.1). Kept for back-compat; the builder
   *  prefers creaseLines when both are present. */
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
  // ── Crease precedence (multi-crease aware) ─────────────────────────────
  // Priority order:
  //   1. creaseLines[] (multi-crease v2.1): engine reads max(spanPct).
  //   2. creaseSpanPct (legacy single-crease v2.0): pass through.
  //   3. hasCrease boolean: translate to LEGACY_HAS_CREASE_SPAN_PCT.
  //   4. null: no crease ceiling.
  //
  // Longest crease wins per spec §4/§5 — strictest cap, no compounding.
  let creaseSpanPct: number | null = null;
  if (fields.creaseLines && fields.creaseLines.length > 0) {
    creaseSpanPct = fields.creaseLines.reduce(
      (max, l) => (typeof l.spanPct === "number" && l.spanPct > max ? l.spanPct : max),
      0
    );
    if (creaseSpanPct === 0) creaseSpanPct = null; // all-zero array = no crease
  } else if (fields.creaseSpanPct != null) {
    creaseSpanPct = fields.creaseSpanPct;
  } else if (fields.hasCrease) {
    creaseSpanPct = LEGACY_HAS_CREASE_SPAN_PCT;
  }

  // ── Tear precedence ────────────────────────────────────────────────────
  // Measurement wins. If absent AND the legacy boolean is set, translate the
  // boolean into the minimum-severity equivalent measurement. The legacy
  // boolean NEVER escalates to "major" (which routes to NO) — that requires
  // an explicit operator selection.
  let tearSeverity: TearSeverity | null = fields.tearSeverity ?? null;
  if (tearSeverity == null && fields.hasTear) {
    tearSeverity = LEGACY_HAS_TEAR_SEVERITY;
  }

  // ── Whitening narrowing (display-only fields stripped at this boundary) ─
  // The persisted shape includes id/start/end/color so the line redraws on
  // reload and renders in the operator-picked colour. The engine
  // (shared/mvgs-scoring.ts, frozen at fe0d60c) only reads side/edge/
  // coveragePct. Strip everything else here so colour can't leak into
  // scoring — single boundary, easy to audit, engine stays frozen.
  const whiteningEdges: WhiteningEdge[] | null = fields.whiteningLines
    ? fields.whiteningLines.map((l) => ({
        side: l.side,
        edge: l.edge,
        coveragePct: l.coveragePct,
      }))
    : null;

  return {
    centeringFrontLr: fields.centeringFrontLr,
    centeringFrontTb: fields.centeringFrontTb,
    centeringBackLr: fields.centeringBackLr,
    centeringBackTb: fields.centeringBackTb,
    defects: fields.defects,
    darkBorderFront: fields.darkBorderFront,
    darkBorderBack: fields.darkBorderBack,
    eyeAppealModifier: fields.eyeAppealModifier,
    whiteningEdges,
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
