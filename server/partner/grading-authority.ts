/**
 * Server-authoritative partner MVGS adapter.
 *
 * WHAT THIS IS
 * ------------
 * A partner-shop operator's browser is not a trusted grader. It may submit grading
 * EVIDENCE (centering measurements, MVGS-classified defect pins, whitening/crease
 * measurements, dark-border flags, eye-appeal modifier, card identity). It may NOT
 * author the authoritative outcome: the overall grade, the four sub-grades, the grade
 * kind, Pristine/Black-Label status, printability, or any HQ-private state.
 *
 * This module closes that gap in TWO parts:
 *
 *   1. `partnerGradeBody()` — an explicit WHITELIST (default-deny) over the request
 *      body. It replaces the previous two-key blacklist, which deleted only
 *      `private_notes`/`privateNotes` and passed everything else straight through to
 *      the grading engine's draft writer.
 *
 *   2. `computePartnerGradeAuthority()` — runs the ONE existing MVGS engine
 *      (`shared/mvgs-input-builder.ts::scoreMvgsV2`, which routes through
 *      `shared/mvgs-scoring.ts::computeMvgsScore`) over the evidence that WILL be
 *      persisted, and returns the authoritative outcome. The caller then writes that
 *      outcome instead of whatever the client claimed.
 *
 * ONE ENGINE — NOTHING HERE SCORES
 * --------------------------------
 * There is no scoring in this file. No threshold, deduction, centering table,
 * calibration value, Pristine rule or bracket is defined, copied or adjusted here.
 * Every number comes out of the shared engine:
 *
 *   • overall grade        ← `gradeFromMvgsScore(result.score)`   (shared/mvgs-scoring.ts)
 *   • centering sub-grade  ← `centeringSubgrade(...).subgrade`    (shared/centering.ts)
 *   • corners/edges/surface← `remainingToGrade(25 - |deduction|)` (shared/mvgs-scoring.ts)
 *   • non-numeric outcome  ← `result.tearForceNotGraded`          (engine output field)
 *   • calibration          ← `loadMvgsCalibration()`              (server/lib/mvgs-calibration.ts)
 *
 * Those are exactly the derivations the HQ surfaces already use — the same engine call
 * shape as the admin approve route (server/routes.ts, "MVGS scoring on approve"), and
 * the same sub-grade derivations the grading workstation displays
 * (client/src/components/grading/grading-panel.tsx: `mvgsCenteringGrade`,
 * `mvgsCornersGrade`, `mvgsEdgesGrade`, `mvgsSurfaceGrade`, `mvgsGrade`). So the partner
 * path and the HQ path cannot diverge: they are the same function of the same evidence.
 *
 * EFFECTIVE EVIDENCE
 * ------------------
 * `applyCertGradeDraft` MERGES an incoming draft over the stored row (an omitted field
 * preserves the stored value). Authority must therefore be computed over the POST-WRITE
 * evidence, not over the request alone — otherwise a request that omits centering would
 * be scored as if the card had no centering measurement at all. `effectiveEvidence()`
 * below reproduces the engine writer's own preservation semantics field-by-field
 * (`pick`/`jb`/`num` in server/grader.ts) so the evidence scored here is byte-for-byte
 * the evidence that lands in the row.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { scoreMvgsV2 } from "@shared/mvgs-input-builder";
import { gradeFromMvgsScore, remainingToGrade, mvgsTierName, mvgsGradeLabel } from "@shared/mvgs-scoring";
import { centeringSubgrade } from "@shared/centering";
import { loadMvgsCalibration } from "../lib/mvgs-calibration";

/**
 * Bumped whenever the shape of the authority contract changes (which fields the server
 * derives, or which evidence it derives them from). Persisted on every partner grade
 * write so a stored grade can be traced to the adapter that produced it. This is NOT an
 * MVGS standard version — the standard's version lives with the engine and calibration.
 */
export const PARTNER_GRADE_AUTHORITY_VERSION = 1;

/**
 * EVIDENCE + INPUT WHITELIST — default-deny.
 *
 * Derived by reading what the partner grading UI actually sends, not by guessing:
 * `client/src/pages/partner/grading.tsx` mounts `GradingWorkstation` with
 * `apiBase="/api/partner/grading"` and `graderMode`, and every partner write
 * (`saveDraft`, `autoSaveNow`, `/submit`, `/edit-submission`) posts exactly
 * `buildPayload()` from `client/src/components/grading/grading-panel.tsx`. Each key
 * below is a key that function emits AND that is legitimately operator input.
 *
 * Every `buildPayload()` key deliberately EXCLUDED, with the reason:
 *   overall_grade      — authoritative grade. Server derives it.
 *   grade_centering    ┐
 *   grade_corners      │ authoritative sub-grades. Server derives them.
 *   grade_edges        │
 *   grade_surface      ┘
 *   auth_status        — HQ authentication verdict (genuine / authentic_altered /
 *   auth_notes           not_original) and its private notes. Drives the non-numeric
 *                        AA/NO outcome; a partner may not author it.
 *   private_notes      — HQ-private operator notes, never partner-visible or writable.
 *
 * And, by default-deny, everything a partner client might invent that is NOT in the
 * list: `grade_type` (authoritative kind), `label_type` (Black Label / Pristine),
 * `grade_strength_score`, `verified_defects`, `grade_approved_at|by`, `grader_status`,
 * `review_required`, `operator_grade`, `operator_subgrades`, `print_state`,
 * `origin_*` (provenance), settlement/credit columns, `deleted_at`, `privateNotes`.
 * None of them can cross this boundary because they are absent, not because they were
 * individually blacklisted.
 */
export const PARTNER_GRADE_EVIDENCE_FIELDS = [
  // ── Centering measurement (four axes, "L/R" ratio strings) ──────────────────
  "centering_front_lr",
  "centering_front_tb",
  "centering_back_lr",
  "centering_back_tb",
  // ── Per-zone raw observations ───────────────────────────────────────────────
  "corners",
  "edges",
  "surface",
  // ── Defect pins (MVGS-classified) + unconfirmed AI candidates ───────────────
  "defects",
  "ai_defect_candidates",
  // ── MVGS v2 measurement inputs ──────────────────────────────────────────────
  "dark_border_front",
  "dark_border_back",
  "eye_appeal_modifier",
  "whitening_lines",
  "crease_lines",
  "crease_span_pct",
  "wrinkle_severity",
  "tear_severity",
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
 * Replaces the former two-key blacklist. Anything not explicitly allowed is dropped
 * silently (the UI never sends it, so a 400 would only ever fire on an attack or a
 * stale client, and failing closed-but-quiet keeps honest clients working).
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

/** The authoritative outcome, as computed by the one engine over stored evidence. */
export interface PartnerGradeAuthority {
  /** Engine score (already floor-rule- and ceiling-capped by the engine itself). */
  score: number;
  /** Engine tier label for that score, e.g. "Gem Mint". */
  scoreLabel: string;
  /** Authoritative overall, as the string `applyCertGradeDraft` expects. */
  overallGrade: string;
  /** Authoritative numeric overall, or null when the engine forced a non-numeric outcome. */
  overallNumeric: number | null;
  /** Tier name for the numeric overall, or null for a non-numeric outcome. */
  tier: string | null;
  /** Authoritative sub-grades. Null for a non-numeric outcome. */
  subgrades: { centering: number; corners: number; edges: number; surface: number } | null;
  /** Raw engine deduction breakdown — what Pristine/Black-Label is decided from. */
  deductions: Record<string, number>;
  /** True when the engine's own `tearForceNotGraded` fired (major tear ⇒ NO). */
  forcedNotGraded: boolean;
  version: number;
}

type CertRow = Record<string, unknown>;

/** `pick` semantics from server/grader.ts: an OMITTED key preserves the stored value. */
function keep<T>(incoming: unknown, stored: T): unknown {
  return incoming === undefined ? (stored ?? null) : incoming;
}

/** `num` semantics from server/grader.ts: undefined/null/"" preserves the stored value. */
function keepNum(incoming: unknown, stored: unknown): unknown {
  return incoming === undefined || incoming === null || incoming === "" ? (stored ?? null) : incoming;
}

/**
 * The evidence the row WILL hold after `applyCertGradeDraft` merges this body, expressed
 * in the engine's input shape. Mirrors the admin approve route's engine call
 * (server/routes.ts) field-for-field, so the two paths score identically.
 */
function effectiveEvidence(cert: CertRow, body: Record<string, unknown>) {
  const c = cert as any;
  const defectsRaw = keep(body.defects, c.defects);
  const surfaceFlagsRaw = keep(body.surface, c.surfaceValues) as any;
  const surfaceFlags = surfaceFlagsRaw && typeof surfaceFlagsRaw === "object" ? surfaceFlagsRaw : {};
  const whitening = keep(body.whitening_lines, c.whiteningLines);
  const creases = keep(body.crease_lines, c.creaseLines);
  const creaseSpan = keepNum(body.crease_span_pct, c.creaseSpanPct);
  const darkFront = keep(body.dark_border_front, c.darkBorderFront ?? !!c.darkBorder);
  const darkBack = keep(body.dark_border_back, c.darkBorderBack ?? !!c.darkBorder);

  return {
    centeringFrontLr: (keep(body.centering_front_lr, c.centeringFrontLr) as string | null) ?? null,
    centeringFrontTb: (keep(body.centering_front_tb, c.centeringFrontTb) as string | null) ?? null,
    centeringBackLr: (keep(body.centering_back_lr, c.centeringBackLr) as string | null) ?? null,
    centeringBackTb: (keep(body.centering_back_tb, c.centeringBackTb) as string | null) ?? null,
    // Only MVGS-CLASSIFIED pins reach the engine — identical filter to the admin
    // approve route and the workstation panel.
    defects: (Array.isArray(defectsRaw) ? defectsRaw : [])
      .filter((d: any) => d?.mvgsCode && d?.tier && d?.zone)
      .map((d: any) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) })),
    darkBorderFront: !!darkFront,
    darkBorderBack: !!darkBack,
    eyeAppealModifier: Number(keepNum(body.eye_appeal_modifier, c.eyeAppealModifier) ?? 0) || 0,
    whiteningLines: Array.isArray(whitening) ? (whitening as any) : null,
    creaseLines: Array.isArray(creases) ? (creases as any) : null,
    creaseSpanPct: creaseSpan != null ? Number(creaseSpan) : null,
    wrinkleSeverity: (keep(body.wrinkle_severity, c.wrinkleSeverity) as any) ?? null,
    tearSeverity: (keep(body.tear_severity, c.tearSeverity) as any) ?? null,
    hasCrease: !!(surfaceFlags as any).hasCrease,
    hasTear: !!(surfaceFlags as any).hasTear,
  };
}

/**
 * Run the ONE engine over the evidence this write will leave on the certificate and
 * return the authoritative outcome. Throws only if the certificate does not exist —
 * every route below has already authorised the id by the time this is called.
 */
export async function computePartnerGradeAuthority(
  certId: number,
  evidenceBody: Record<string, unknown>
): Promise<PartnerGradeAuthority> {
  const cert = (await storage.getCertificate(certId)) as CertRow | undefined;
  if (!cert) throw new Error("Certificate not found");

  const calibration = await loadMvgsCalibration();
  const result = scoreMvgsV2(effectiveEvidence(cert, evidenceBody), calibration);

  // Non-numeric outcome is the ENGINE's call (major tear ⇒ Not Graded), never the
  // client's. `NO` is the short form `applyCertGradeDraft` already understands.
  if (result.tearForceNotGraded) {
    return {
      score: result.score,
      scoreLabel: mvgsGradeLabel(result.score),
      overallGrade: "NO",
      overallNumeric: null,
      tier: null,
      subgrades: null,
      deductions: result.deductions,
      forcedNotGraded: true,
      version: PARTNER_GRADE_AUTHORITY_VERSION,
    };
  }

  const overall = gradeFromMvgsScore(result.score);
  const evidence = effectiveEvidence(cert, evidenceBody);
  const subgrades = {
    // Centering comes straight from the shared PSA chart (worst of four axes) — the
    // same number that scores the card and that the workstation chip displays.
    centering: centeringSubgrade(
      evidence.centeringFrontLr,
      evidence.centeringFrontTb,
      evidence.centeringBackLr,
      evidence.centeringBackTb
    ).subgrade,
    corners: remainingToGrade(25 - Math.abs(result.deductions.corners ?? 0)),
    edges: remainingToGrade(25 - Math.abs(result.deductions.edges ?? 0)),
    surface: remainingToGrade(25 - Math.abs(result.deductions.surface ?? 0)),
  };

  return {
    score: result.score,
    scoreLabel: mvgsGradeLabel(result.score),
    overallGrade: String(overall),
    overallNumeric: overall,
    tier: mvgsTierName(overall),
    subgrades,
    deductions: result.deductions,
    forcedNotGraded: false,
    version: PARTNER_GRADE_AUTHORITY_VERSION,
  };
}

/**
 * Overlay the server's authoritative outcome onto the whitelisted evidence body, so the
 * unmodified engine writer (`applyCertGradeDraft`) persists the SERVER's numbers.
 *
 * The client's own values were already dropped by `partnerGradeBody()`; this is what
 * puts the authoritative ones in their place. Assignment order matters only in the sense
 * that these keys can never be present beforehand — the whitelist excludes all six.
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
 * Persist the engine score alongside the grade, in the SAME column the HQ approve route
 * writes it to (`grade_strength_score`). Two reasons:
 *   • it is the auditable record of WHICH engine verdict produced the stored grade, and
 *   • it means a partner-graded row already carries the score HQ would otherwise only
 *     compute at approval time, so review sees the number rather than re-deriving it.
 *
 * Scoped `grade_approved_at IS NULL` so this can never touch a published certificate.
 * A non-numeric outcome leaves the column alone (mirrors the approve route, which skips
 * the score write entirely when the grade is non-numeric).
 */
export async function persistPartnerGradeAuthorityScore(
  certId: number,
  authority: PartnerGradeAuthority
): Promise<void> {
  if (authority.forcedNotGraded) return;
  await db.execute(sql`
    UPDATE certificates
       SET grade_strength_score = ${authority.score}::int,
           updated_at = NOW()
     WHERE id = ${certId}
       AND grade_approved_at IS NULL
  `);
}

/** Compact, log-safe record of the authority decision for the audit trail. */
export function gradeAuthorityAuditDetail(authority: PartnerGradeAuthority) {
  return {
    grade_authority: "server",
    grade_authority_version: authority.version,
    mvgs_score: authority.score,
    mvgs_score_label: authority.scoreLabel,
    overall_grade: authority.overallGrade,
    subgrades: authority.subgrades,
    deductions: authority.deductions,
    forced_not_graded: authority.forcedNotGraded,
  };
}
