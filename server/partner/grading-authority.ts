/**
 * Server-authoritative partner MVGS adapter.
 *
 * WHAT THIS IS
 * ------------
 * A partner-shop operator's browser is not a trusted grader. It may submit grading
 * EVIDENCE (centering measurements, MVGS-classified defect pins, per-zone corner/edge
 * steppers, whitening/crease measurements, dark-border flags, eye-appeal modifier, the
 * authentication verdict, card identity). It may NOT author the authoritative outcome:
 * the overall grade, the four sub-grades, the grade kind, Pristine/Black-Label status,
 * printability, or any HQ-private state.
 *
 * THE INVARIANT
 * -------------
 *     the stored grade is always what the shared grading maths says about the STORED ROW
 *
 * Version 1 tried to hold that by scoring a simulation of the post-write row. Hostile
 * review broke it twice, and both breaks were the same shape — an input that was SCORED
 * but did not end up on the row:
 *
 *   F1  `crease_span_pct` was whitelisted and fed to the engine, but server/grader.ts
 *       never writes that column. A body of {crease_lines: [], crease_span_pct: 0,
 *       surface:{hasCrease:true}} suppressed the crease ceiling at scoring time while the
 *       row that landed still read "crease present, no span" — a 4.5 cap. Stored 10,
 *       engine-over-row 4.5.
 *   F7  the simulation read the row once, and server/grader.ts read it again. Anything
 *       writing in between (a second tab, or the proxied manual-centering action, which
 *       rewrites the centering columns and does not recompute authority) desynchronised
 *       the two.
 *
 * So the authority is no longer a function of the request at all. It is computed from the
 * PERSISTED ROW, after the write, and re-asserted against the columns that actually
 * landed. `computeAuthorityFromRow` is the only function that decides a grade;
 * `computePartnerGradeAuthority(certId, body)` exists solely to give the unmodified engine
 * writer an `overall_grade` on its first pass, and its answer is discarded if the row
 * disagrees. An input that is scored but not persisted can no longer change the outcome,
 * because the outcome is read back from the row either way.
 *
 * ONE ENGINE / ONE FALLBACK — NOTHING HERE SCORES
 * -----------------------------------------------
 * No threshold, deduction, weight, centering table, calibration value, Pristine rule or
 * bracket is defined, copied or adjusted here. Every number comes from shared code:
 *
 *   • MVGS overall        ← `gradeFromMvgsScore(scoreMvgsV2(...).score)`  (shared/mvgs-scoring)
 *   • centering sub-grade ← `centeringSubgrade` / `centeringSubgradeStrict` (shared/centering)
 *   • corners/edges/surf  ← `remainingToGrade(25 - |deduction|)`          (shared/mvgs-scoring)
 *   • no-pin fallback     ← `calcCornerSubgrade` / `calcEdgeSubgrade` /
 *                           `calculateOverallGrade`            (shared/legacy-grade-fallback)
 *   • non-numeric outcome ← the authentication verdict, and the engine's own
 *                           `tearForceNotGraded`
 *   • calibration         ← `loadMvgsCalibration()`            (server/lib/mvgs-calibration)
 *
 * PRECEDENCE IS THE WORKSTATION'S, NOT A NEW ONE
 * ----------------------------------------------
 * F2: the MVGS engine scores from CLASSIFIED PINS. The grading workstation only uses the
 * engine's headline grade when at least one pin is classified
 * (client/src/components/grading/grading-panel.tsx: `mvgsGrade = hasMvgsPins ? … : null;
 * overall = mvgsGrade ?? calculateOverallGrade(sub, hasCrease, hasTear)`). Applying the
 * engine unconditionally inflated every zone-stepper-graded card to 10 — an ordinary
 * workflow, no attacker required. This module now mirrors that precedence exactly, using
 * the very same functions, which is why they were moved into shared/ rather than copied.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { scoreMvgsV2 } from "@shared/mvgs-input-builder";
import { gradeFromMvgsScore, remainingToGrade, mvgsTierName, mvgsGradeLabel } from "@shared/mvgs-scoring";
import { centeringSubgrade, centeringSubgradeStrict } from "@shared/centering";
import {
  calcCornerSubgrade,
  calcEdgeSubgrade,
  calculateOverallGrade,
  type CornerValues,
  type EdgeValues,
} from "@shared/legacy-grade-fallback";
import { loadMvgsCalibration } from "../lib/mvgs-calibration";

/**
 * Bumped whenever the authority contract changes — which fields the server derives, or
 * which evidence it derives them from. Persisted on every partner grade write so a stored
 * grade can be traced to the adapter that produced it. NOT an MVGS standard version.
 *
 *   v1 — engine applied unconditionally; authority simulated from the request.
 *   v2 — authority derived from the PERSISTED ROW; workstation pin/no-pin precedence
 *        honoured; authentication verdict accepted as evidence.
 */
export const PARTNER_GRADE_AUTHORITY_VERSION = 2;

/**
 * EVIDENCE + INPUT WHITELIST — default-deny.
 *
 * Derived by reading what the partner grading UI actually sends, not by guessing:
 * `client/src/pages/partner/grading.tsx` mounts `GradingWorkstation` with
 * `apiBase="/api/partner/grading"` and `graderMode`, and every partner write posts exactly
 * `buildPayload()` from `client/src/components/grading/grading-panel.tsx`.
 *
 * TWO RULES govern membership, and both exist because of a real defect:
 *   1. If it is SCORED, it must be PERSISTED by server/grader.ts. Otherwise the stored row
 *      and the scored evidence can disagree — that was F1.
 *   2. If the shared panel lets a partner operator set it, it must either be accepted or
 *      be visibly refused. Silently dropping operator input was F3.
 *
 * Every `buildPayload()` key deliberately EXCLUDED, with the reason:
 *   overall_grade        — authoritative grade. Server derives it.
 *   grade_centering      ┐
 *   grade_corners        │ authoritative sub-grades. Server derives them.
 *   grade_edges          │
 *   grade_surface        ┘
 *   auth_notes           — HQ-private commentary on the authentication verdict. The
 *                          VERDICT is accepted (below); the private notes are not.
 *   private_notes        — HQ-private operator notes, never partner-visible or writable.
 *   crease_span_pct      — F1. server/grader.ts does not write this column
 *                          (`grep -c crease_span_pct server/grader.ts` → 0), so anything
 *                          scored from it is unrecoverable from the row. The UI sends it
 *                          only as a derived mirror of `crease_lines` (max spanPct), and
 *                          `crease_lines` IS persisted and takes precedence over it inside
 *                          shared/mvgs-input-builder. Dropping it loses no operator input.
 *   ai_defect_candidates — same class as F1: accepted but never written by
 *                          applyCertGradeDraft. It is not scored, so it was harmless, but
 *                          "whitelisted yet unpersisted" is the exact shape of the bug and
 *                          is not worth keeping for a no-op.
 *
 * And, by default-deny, everything a partner client might invent that is NOT in the list:
 * `grade_type`, `label_type`, `grade_strength_score`, `verified_defects`,
 * `grade_approved_at|by`, `grader_status`, `review_required`, `operator_grade`,
 * `operator_subgrades`, `print_state`, `origin_*`, settlement columns, `deleted_at`,
 * `privateNotes`. None of them can cross this boundary because they are absent, not
 * because they were individually blacklisted.
 */
export const PARTNER_GRADE_EVIDENCE_FIELDS = [
  // ── Centering measurement (four axes, "L/R" ratio strings) ──────────────────
  "centering_front_lr",
  "centering_front_tb",
  "centering_back_lr",
  "centering_back_tb",
  // ── Per-zone operator steppers. These DRIVE the grade on the no-pin path. ───
  "corners",
  "edges",
  "surface",
  // ── Defect pins (MVGS-classified) ───────────────────────────────────────────
  "defects",
  // ── MVGS v2 measurement inputs ──────────────────────────────────────────────
  "dark_border_front",
  "dark_border_back",
  "eye_appeal_modifier",
  "whitening_lines",
  "crease_lines",
  "wrinkle_severity",
  "tear_severity",
  // ── Authentication VERDICT (F3). An observation about the physical card, and the
  //    shared panel renders the control to partner operators unconditionally. Accepted
  //    as evidence; the server, not the client, turns it into an AA/NO grade. ────
  "auth_status",
  // ── Card identity the partner operator legitimately types ───────────────────
  "card_name",
  "set_name",
  "card_number_display",
  "year_text",
  "language",
  "variant",
  // ── Structured rarity / finish / promo picker ───────────────────────────────
  "rarity_code",
  "finish_variant",
  "promo_type",
  "rarity_override_confirmed",
  "rarity_override_from",
  "rarity_override_to",
  // ── Customer-facing narrative (not authority: no grade is derived from it) ──
  "grade_explanation",
] as const;

const EVIDENCE_ALLOWED = new Set<string>(PARTNER_GRADE_EVIDENCE_FIELDS);

/** Fields the server owns absolutely; a client that sends them is ignored, never obeyed. */
export const PARTNER_GRADE_SERVER_AUTHORED_FIELDS = [
  "overall_grade",
  "grade_type",
  "grade_centering",
  "grade_corners",
  "grade_edges",
  "grade_surface",
] as const;

/**
 * WHITELIST the partner request body down to evidence/input only.
 *
 * Anything not explicitly allowed is dropped silently (the UI never sends it, so a 400
 * would only ever fire on an attack or a stale client). The rejected claim IS recorded in
 * the audit trail by the caller — see `rejectedClientClaim` (F8).
 */
export function partnerGradeBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const src = body as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (EVIDENCE_ALLOWED.has(key)) clean[key] = src[key];
  }
  return clean;
}

/**
 * F8 — what the client TRIED to author, if anything. Recorded alongside the server's
 * decision so a tampered save is distinguishable from an honest one in the audit trail.
 * Returns null for an honest request, so honest saves stay quiet.
 */
export function rejectedClientClaim(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const src = body as Record<string, unknown>;
  const claim: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (!EVIDENCE_ALLOWED.has(key)) claim[key] = src[key];
  }
  return Object.keys(claim).length ? claim : null;
}

/** How the authoritative grade was reached. Recorded for review and audit. */
export type PartnerGradeBasis = "mvgs-engine" | "legacy-zone-fallback" | "authentication" | "engine-tear-rule";

/** The authoritative outcome, as computed by the shared maths over the persisted row. */
export interface PartnerGradeAuthority {
  /** Engine score (already floor-rule- and ceiling-capped by the engine itself). */
  score: number;
  /** Engine tier label for that score, e.g. "Gem Mint". */
  scoreLabel: string;
  /** Authoritative overall, as the string `applyCertGradeDraft` expects. */
  overallGrade: string;
  /** Authoritative numeric overall, or null for a non-numeric outcome. */
  overallNumeric: number | null;
  /** Tier name for the numeric overall, or null for a non-numeric outcome. */
  tier: string | null;
  /** Authoritative sub-grades. Null for a non-numeric outcome. */
  subgrades: { centering: number; corners: number; edges: number; surface: number } | null;
  /** Raw engine deduction breakdown — what Pristine/Black-Label is decided from. */
  deductions: Record<string, number>;
  /** True when the outcome is non-numeric (AA / NO). */
  nonNumeric: boolean;
  /** Which shared decision produced it. */
  basis: PartnerGradeBasis;
  version: number;
}

// ── The row ────────────────────────────────────────────────────────────────────────────

/**
 * Everything the authority depends on, read in ONE statement straight from the row.
 *
 * Deliberately raw SQL rather than `storage.getCertificate()`: `auth_status` is a real
 * column that shared/schema.ts does not declare, so the Drizzle model returns `undefined`
 * for it (the same gap the D-1 repair closed on the write side). Reading the columns by
 * name means the authority can never be computed from a silently-absent field.
 */
interface AuthorityRow {
  centering_front_lr: string | null;
  centering_front_tb: string | null;
  centering_back_lr: string | null;
  centering_back_tb: string | null;
  defects: unknown;
  corner_values: unknown;
  edge_values: unknown;
  surface_values: unknown;
  dark_border_front: boolean | null;
  dark_border_back: boolean | null;
  dark_border: boolean | null;
  eye_appeal_modifier: number | string | null;
  whitening_lines: unknown;
  crease_lines: unknown;
  crease_span_pct: number | string | null;
  wrinkle_severity: string | null;
  tear_severity: string | null;
  auth_status: string | null;
  grade_type: string | null;
}

async function loadAuthorityRow(certId: number): Promise<AuthorityRow> {
  const r = await db.execute(sql`
    SELECT centering_front_lr, centering_front_tb, centering_back_lr, centering_back_tb,
           defects, corner_values, edge_values, surface_values,
           dark_border_front, dark_border_back, dark_border, eye_appeal_modifier,
           whitening_lines, crease_lines, crease_span_pct, wrinkle_severity, tear_severity,
           auth_status, grade_type
      FROM certificates
     WHERE id = ${certId}
  `);
  const row = r.rows[0] as unknown as AuthorityRow | undefined;
  if (!row) throw new Error("Certificate not found");
  return row;
}

/** `pick` semantics from server/grader.ts: an OMITTED key preserves the stored value. */
function keep(incoming: unknown, stored: unknown): unknown {
  return incoming === undefined ? (stored ?? null) : incoming;
}

/** `num` semantics from server/grader.ts: undefined/null/"" preserves the stored value. */
function keepNum(incoming: unknown, stored: unknown): unknown {
  return incoming === undefined || incoming === null || incoming === "" ? (stored ?? null) : incoming;
}

const ZERO_CORNERS: CornerValues = {
  frontTL: 0,
  frontTR: 0,
  frontBL: 0,
  frontBR: 0,
  backTL: 0,
  backTR: 0,
  backBL: 0,
  backBR: 0,
};
const ZERO_EDGES: EdgeValues = {
  frontTop: 0,
  frontBottom: 0,
  frontLeft: 0,
  frontRight: 0,
  backTop: 0,
  backBottom: 0,
  backLeft: 0,
  backRight: 0,
};

/**
 * The evidence the authority is computed from.
 *
 * With `body = {}` (the normal case, post-write) this is purely the row. The body overlay
 * exists only for the pre-write pass that hands `applyCertGradeDraft` an `overall_grade`,
 * and mirrors that writer's own preservation semantics field-for-field.
 */
function effectiveEvidence(row: AuthorityRow, body: Record<string, unknown>) {
  const defectsRaw = keep(body.defects, row.defects);
  const surfaceRaw = keep(body.surface, row.surface_values);
  const surfaceFlags = (surfaceRaw && typeof surfaceRaw === "object" ? surfaceRaw : {}) as Record<string, unknown>;
  const cornersRaw = keep(body.corners, row.corner_values);
  const edgesRaw = keep(body.edges, row.edge_values);
  const whitening = keep(body.whitening_lines, row.whitening_lines);
  const creases = keep(body.crease_lines, row.crease_lines);
  // NOT overlaid from the body: crease_span_pct is not whitelisted and is not written by
  // the engine writer, so only the row's own value may influence the outcome (F1).
  const creaseSpan = row.crease_span_pct;
  const legacyDark = !!row.dark_border;
  const authStatus = String(keep(body.auth_status, row.auth_status) ?? "genuine") || "genuine";

  return {
    centeringFrontLr: (keep(body.centering_front_lr, row.centering_front_lr) as string | null) ?? null,
    centeringFrontTb: (keep(body.centering_front_tb, row.centering_front_tb) as string | null) ?? null,
    centeringBackLr: (keep(body.centering_back_lr, row.centering_back_lr) as string | null) ?? null,
    centeringBackTb: (keep(body.centering_back_tb, row.centering_back_tb) as string | null) ?? null,
    // Only MVGS-CLASSIFIED pins reach the engine — identical filter to the admin approve
    // route and the workstation panel.
    defects: (Array.isArray(defectsRaw) ? defectsRaw : [])
      .filter((d: any) => d?.mvgsCode && d?.tier && d?.zone)
      .map((d: any) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) })),
    darkBorderFront: !!keep(body.dark_border_front, row.dark_border_front ?? legacyDark),
    darkBorderBack: !!keep(body.dark_border_back, row.dark_border_back ?? legacyDark),
    eyeAppealModifier: Number(keepNum(body.eye_appeal_modifier, row.eye_appeal_modifier) ?? 0) || 0,
    whiteningLines: Array.isArray(whitening) ? (whitening as any) : null,
    creaseLines: Array.isArray(creases) ? (creases as any) : null,
    creaseSpanPct: creaseSpan != null ? Number(creaseSpan) : null,
    wrinkleSeverity: (keep(body.wrinkle_severity, row.wrinkle_severity) as any) ?? null,
    tearSeverity: (keep(body.tear_severity, row.tear_severity) as any) ?? null,
    hasCrease: !!surfaceFlags.hasCrease,
    hasTear: !!surfaceFlags.hasTear,
    // Non-engine inputs — the zone steppers and the authentication verdict.
    cornerValues: { ...ZERO_CORNERS, ...(cornersRaw && typeof cornersRaw === "object" ? cornersRaw : {}) },
    edgeValues: { ...ZERO_EDGES, ...(edgesRaw && typeof edgesRaw === "object" ? edgesRaw : {}) },
    authStatus,
    storedGradeType: row.grade_type,
  };
}

type Evidence = ReturnType<typeof effectiveEvidence>;

function nonNumericOutcome(
  overallGrade: "AA" | "NO",
  basis: PartnerGradeBasis,
  score: number,
  deductions: Record<string, number>
): PartnerGradeAuthority {
  return {
    score,
    scoreLabel: mvgsGradeLabel(score),
    overallGrade,
    overallNumeric: null,
    tier: null,
    subgrades: null,
    deductions,
    nonNumeric: true,
    basis,
    version: PARTNER_GRADE_AUTHORITY_VERSION,
  };
}

/**
 * THE decision. Pure: same evidence in, same authority out.
 *
 * Order of precedence mirrors the shared grading workstation exactly:
 *   1. authentication verdict (panel's `finalGradeOverall`) — AA / NO short-circuit
 *   2. the engine's own major-tear rule
 *   3. MVGS engine, but ONLY when a pin is classified (panel's `hasMvgsPins`)
 *   4. otherwise the legacy zone-stepper fallback (panel's `calculateOverallGrade`)
 */
function deriveAuthority(ev: Evidence, engine: ReturnType<typeof scoreMvgsV2>): PartnerGradeAuthority {
  // 1. The operator's authentication verdict. Mirrors grading-panel.tsx:
  //    `isNonNumeric = authStatus === "authentic_altered" || authStatus === "not_original"`
  //    `finalGradeOverall = isNonNumeric ? (authStatus === "authentic_altered" ? "AA" : "NO") : …`
  if (ev.authStatus === "authentic_altered") return nonNumericOutcome("AA", "authentication", engine.score, engine.deductions);
  if (ev.authStatus === "not_original") return nonNumericOutcome("NO", "authentication", engine.score, engine.deductions);

  // A row already classified non-numeric stays non-numeric on the partner surface even if
  // its auth_status column disagrees (a legacy inconsistency). Fail closed: a partner may
  // never quietly convert a Not-Graded card into a numeric grade. HQ Correction Mode owns
  // that transition. Long-form and short-form aliases both handled.
  const storedKind = String(ev.storedGradeType ?? "numeric").trim().toLowerCase();
  if (storedKind === "authentic_altered" || storedKind === "aa") {
    return nonNumericOutcome("AA", "authentication", engine.score, engine.deductions);
  }
  if (storedKind === "not_original" || storedKind === "no" || storedKind === "non_numeric") {
    return nonNumericOutcome("NO", "authentication", engine.score, engine.deductions);
  }

  // 2. The engine's own major-tear rule.
  if (engine.tearForceNotGraded) return nonNumericOutcome("NO", "engine-tear-rule", engine.score, engine.deductions);

  const hasMvgsPins = ev.defects.length > 0;

  if (hasMvgsPins) {
    // 3. MVGS path. Identical derivations to grading-panel.tsx's mvgsCenteringGrade /
    //    mvgsCornersGrade / mvgsEdgesGrade / mvgsSurfaceGrade / mvgsGrade.
    const overall = gradeFromMvgsScore(engine.score);
    return {
      score: engine.score,
      scoreLabel: mvgsGradeLabel(engine.score),
      overallGrade: String(overall),
      overallNumeric: overall,
      tier: mvgsTierName(overall),
      subgrades: {
        centering: centeringSubgrade(
          ev.centeringFrontLr,
          ev.centeringFrontTb,
          ev.centeringBackLr,
          ev.centeringBackTb
        ).subgrade,
        corners: remainingToGrade(25 - Math.abs(engine.deductions.corners ?? 0)),
        edges: remainingToGrade(25 - Math.abs(engine.deductions.edges ?? 0)),
        surface: remainingToGrade(25 - Math.abs(engine.deductions.surface ?? 0)),
      },
      deductions: engine.deductions,
      nonNumeric: false,
      basis: "mvgs-engine",
      version: PARTNER_GRADE_AUTHORITY_VERSION,
    };
  }

  // 4. No classified pin → the legacy zone-stepper fallback, exactly as the workstation
  //    does it. `centering` uses the STRICT variant (null until all four axes are present)
  //    defaulting to 10, matching the panel's `centeringOverride ?? centeringCalc ?? 10`;
  //    `surface` is the engine's own no-pin surface bucket, matching `mvgsSurfaceGrade`.
  const subgrades = {
    centering:
      centeringSubgradeStrict(ev.centeringFrontLr, ev.centeringFrontTb, ev.centeringBackLr, ev.centeringBackTb)
        ?.subgrade ?? 10,
    corners: calcCornerSubgrade(ev.cornerValues as CornerValues).grade,
    edges: calcEdgeSubgrade(ev.edgeValues as EdgeValues).grade,
    surface: remainingToGrade(25 - Math.abs(engine.deductions.surface ?? 0)),
  };
  const overall = calculateOverallGrade(subgrades, ev.hasCrease, ev.hasTear);
  return {
    score: engine.score,
    scoreLabel: mvgsGradeLabel(engine.score),
    overallGrade: String(overall),
    overallNumeric: overall,
    tier: mvgsTierName(overall),
    subgrades,
    deductions: engine.deductions,
    nonNumeric: false,
    basis: "legacy-zone-fallback",
    version: PARTNER_GRADE_AUTHORITY_VERSION,
  };
}

/**
 * Compute the authority. With no body (the post-write case) this is a pure function of the
 * PERSISTED ROW — which is the property the whole design rests on.
 */
export async function computePartnerGradeAuthority(
  certId: number,
  evidenceBody: Record<string, unknown> = {}
): Promise<PartnerGradeAuthority> {
  const row = await loadAuthorityRow(certId);
  const calibration = await loadMvgsCalibration();
  const ev = effectiveEvidence(row, evidenceBody);
  return deriveAuthority(ev, scoreMvgsV2(ev, calibration));
}

/** Authority as read back from the row, with no request influence whatsoever. */
export function computePartnerGradeAuthorityFromRow(certId: number): Promise<PartnerGradeAuthority> {
  return computePartnerGradeAuthority(certId, {});
}

/** Do two authority computations agree on everything that gets persisted? */
export function sameAuthority(a: PartnerGradeAuthority, b: PartnerGradeAuthority): boolean {
  return (
    a.overallGrade === b.overallGrade &&
    a.nonNumeric === b.nonNumeric &&
    JSON.stringify(a.subgrades) === JSON.stringify(b.subgrades)
  );
}

/**
 * Overlay the server's authoritative outcome onto the whitelisted evidence body, so the
 * unmodified engine writer (`applyCertGradeDraft`) persists the SERVER's numbers. The
 * client's own values were already dropped by `partnerGradeBody()`.
 *
 * A non-numeric outcome sends no sub-grades: `applyCertGradeDraft` nulls `grade` for a
 * non-numeric kind but writes the sub-grade columns regardless, so omitting them preserves
 * whatever was there rather than stamping fabricated numbers onto a Not-Graded card.
 */
export function applyGradeAuthority(
  body: Record<string, unknown>,
  authority: PartnerGradeAuthority
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, overall_grade: authority.overallGrade };
  if (authority.subgrades) {
    out.grade_centering = authority.subgrades.centering;
    out.grade_corners = authority.subgrades.corners;
    out.grade_edges = authority.subgrades.edges;
    out.grade_surface = authority.subgrades.surface;
  }
  return out;
}

/**
 * Read back the columns the authority is supposed to have written, so the caller can prove
 * the row really carries the server's decision before reporting success (F4: never return
 * success-shaped output for a write that did not land).
 */
export async function readPersistedAuthorityColumns(certId: number): Promise<{
  grade: number | null;
  gradeType: string | null;
  subgrades: { centering: number | null; corners: number | null; edges: number | null; surface: number | null };
}> {
  const r = await db.execute(sql`
    SELECT grade::text AS grade, grade_type,
           centering_score::text AS centering, corners_score::text AS corners,
           edges_score::text AS edges, surface_score::text AS surface
      FROM certificates WHERE id = ${certId}
  `);
  const row = r.rows[0] as unknown as Record<string, string | null> | undefined;
  if (!row) throw new Error("Certificate not found");
  const n = (v: string | null) => (v == null ? null : Number(v));
  return {
    grade: n(row.grade),
    gradeType: row.grade_type,
    subgrades: {
      centering: n(row.centering),
      corners: n(row.corners),
      edges: n(row.edges),
      surface: n(row.surface),
    },
  };
}

/** Does the persisted row actually carry this authority? */
export function persistedMatchesAuthority(
  persisted: Awaited<ReturnType<typeof readPersistedAuthorityColumns>>,
  authority: PartnerGradeAuthority
): boolean {
  if (authority.nonNumeric) return persisted.grade == null;
  if (persisted.grade !== authority.overallNumeric) return false;
  const s = authority.subgrades;
  if (!s) return true;
  return (
    persisted.subgrades.centering === s.centering &&
    persisted.subgrades.corners === s.corners &&
    persisted.subgrades.edges === s.edges &&
    persisted.subgrades.surface === s.surface
  );
}

/**
 * Persist the engine score alongside the grade, in the SAME column the HQ approve route
 * writes it to (`grade_strength_score`).
 *
 * Skipped entirely for a non-numeric outcome — the HQ approve route deliberately leaves
 * that column alone when the grade is non-numeric (F4), and a strength score for a card
 * that is Not Graded is meaningless. Scoped `grade_approved_at IS NULL` so this can never
 * touch a published certificate.
 */
export async function persistPartnerGradeAuthorityScore(
  certId: number,
  authority: PartnerGradeAuthority
): Promise<void> {
  if (authority.nonNumeric) return;
  await db.execute(sql`
    UPDATE certificates
       SET grade_strength_score = ${authority.score}::int,
           updated_at = NOW()
     WHERE id = ${certId}
       AND grade_approved_at IS NULL
  `);
}

/** Compact, log-safe record of the authority decision for the audit trail. */
export function gradeAuthorityAuditDetail(
  authority: PartnerGradeAuthority,
  rejectedClaim: Record<string, unknown> | null
) {
  return {
    grade_authority: "server",
    grade_authority_version: authority.version,
    grade_authority_basis: authority.basis,
    mvgs_score: authority.score,
    mvgs_score_label: authority.scoreLabel,
    overall_grade: authority.overallGrade,
    subgrades: authority.subgrades,
    deductions: authority.deductions,
    non_numeric: authority.nonNumeric,
    // F8 — what the client tried to author, so a tampered save is distinguishable from an
    // honest one. Null on an honest request.
    rejected_client_claim: rejectedClaim,
  };
}
