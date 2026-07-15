/**
 * Pure, dependency-free VQ emergency feature-flag evaluation (Phase 7E). No DB,
 * no I/O. VQ-only kill switches that NEVER disable grading / certificates /
 * payments / labels / submissions / users / auth.
 *
 * Precedence (the core rule): env HARD-OFF  >  DB flag  >  default-ON.
 *  - A truthy env `VQ_*_DISABLED` / `VQ_READONLY` / `VQ_PROVIDER_OUTAGE` forces the
 *    feature OFF and cannot be re-enabled by any DB state — the always-available,
 *    DB-independent emergency hard-off (a Fly secret, identical on both machines).
 *  - Env unset/false falls through to the DB flag (the runtime toggle that
 *    propagates to both machines without a restart).
 *  - DB flag absent → default-ON. A missing flag never disables VQ (safe default).
 *  - There is deliberately NO env hard-ON (env only ever disables).
 *
 * This inverts the grading `feature-flags.ts` precedence ON PURPOSE: there a DB
 * override can turn a feature *on*; here a bad/empty DB row can never re-enable a
 * killed VQ feature. Keep the two systems separate.
 */

export type VqFeature = "generation" | "exports" | "writes" | VqGenerationTypeFeature | "auto_paid_retry";

/** Per-generation-type toggles (spend-guard hardening). Each is a separate row in
 *  the SAME `vq_feature_flags` table (a free-text primary key — no migration
 *  needed to add these) and follows the IDENTICAL default-on precedent as
 *  "generation": a missing row never blocks a generation type, only an explicit
 *  DB-flag-off (or the "generation" master switch) does. This lets an owner pause
 *  JUST Action Reference generation, say, without touching Master/Card/etc. */
export type VqGenerationTypeFeature =
  | "gen_master_portrait"
  | "gen_action_pose"
  | "gen_face_closeup"
  | "gen_turnaround_sheet"
  | "gen_colour_sheet"
  | "gen_card_artwork"
  | "gen_replacement";

export const VQ_GENERATION_TYPE_FEATURES: readonly VqGenerationTypeFeature[] = [
  "gen_master_portrait",
  "gen_action_pose",
  "gen_face_closeup",
  "gen_turnaround_sheet",
  "gen_colour_sheet",
  "gen_card_artwork",
  "gen_replacement",
];

/** Maps a VqReferenceType (shared/vq-schema.ts) to its individual toggle. Falls
 *  back to gen_replacement for anything unrecognised (fail-safe: an unmapped type
 *  is still gated by SOME toggle rather than silently skipping the check). */
export function generationTypeFeatureFor(referenceType: string): VqGenerationTypeFeature {
  switch (referenceType) {
    case "master_portrait":
      return "gen_master_portrait";
    case "action_pose":
      return "gen_action_pose";
    case "face_closeup":
      return "gen_face_closeup";
    case "turnaround_sheet":
      return "gen_turnaround_sheet";
    case "colour_sheet":
      return "gen_colour_sheet";
    default:
      return "gen_replacement";
  }
}

export interface VqFlagEnv {
  VQ_GENERATION_DISABLED?: string;
  VQ_EXPORTS_DISABLED?: string;
  VQ_READONLY?: string; // compound: writes + generation
  VQ_PROVIDER_OUTAGE?: string; // forces generation off (provider-outage mode)
}

/** DB runtime toggles. true=enabled, false=disabled, absent=no opinion (→ default-on). */
export type VqDbFlags = Partial<Record<VqFeature, boolean>>;

export type VqDisableReason = "env_hard_off" | "env_readonly" | "env_provider_outage" | "db_flag_off" | "not_yet_enabled";
export interface VqFeatureState {
  enabled: boolean;
  source: "env" | "db" | "default";
  reason: VqDisableReason | "default_on" | "db_flag_on";
}

const truthy = (v?: string): boolean => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

export function vqFeatureState(feature: VqFeature, env: VqFlagEnv, db?: VqDbFlags): VqFeatureState {
  // 1) env HARD-OFF (highest precedence, one-way, no DB needed)
  if (feature === "writes" && truthy(env.VQ_READONLY)) {
    return { enabled: false, source: "env", reason: "env_readonly" };
  }
  if (feature === "generation") {
    if (truthy(env.VQ_READONLY)) return { enabled: false, source: "env", reason: "env_readonly" };
    if (truthy(env.VQ_PROVIDER_OUTAGE)) return { enabled: false, source: "env", reason: "env_provider_outage" };
    if (truthy(env.VQ_GENERATION_DISABLED)) return { enabled: false, source: "env", reason: "env_hard_off" };
  }
  if (feature === "exports" && truthy(env.VQ_EXPORTS_DISABLED)) {
    return { enabled: false, source: "env", reason: "env_hard_off" };
  }

  // 2) DB flag (runtime toggle) — env unset falls through to here
  const dbVal = db?.[feature];
  if (dbVal === false) return { enabled: false, source: "db", reason: "db_flag_off" };
  if (dbVal === true) return { enabled: true, source: "db", reason: "db_flag_on" };

  // 3) default — for the ORIGINAL three flags (generation/exports/writes), a
  // missing row never disables VQ (default-ON, unchanged, per the header above).
  //
  // Per-generation-type toggles (spend-guard hardening, Phase 2 correction A) are
  // the deliberate EXCEPTION: a newly deployed generation type must be UNAVAILABLE
  // until an owner explicitly turns it on — a missing gen_* row means the type
  // does not yet exist as a reviewed, owner-approved capability, so it defaults
  // OFF, not on. This does NOT touch "generation"/"exports"/"writes" (still
  // default-ON) and does NOT retroactively disable any type an owner has already
  // explicitly enabled (an explicit true row still wins at step 2 above).
  if ((VQ_GENERATION_TYPE_FEATURES as readonly string[]).includes(feature)) {
    return { enabled: false, source: "default", reason: "not_yet_enabled" };
  }
  return { enabled: true, source: "default", reason: "default_on" };
}

/** Pure route decision for a disabled feature — a temporary maintenance state, so
 *  503 + Retry-After (never 403, which reads as an authz denial and can be cached). */
export function vqDisabledResponse(feature: VqFeature, state: VqFeatureState): {
  status: 503;
  retryAfterSeconds: number;
  body: { error: string; feature: VqFeature; disabled: true; reason: string; source: string };
} {
  const msg: Record<string, string> = {
    env_hard_off: `Vault Quest ${feature} is disabled (emergency hard-off).`,
    env_readonly: `Vault Quest is in read-only maintenance — ${feature} is disabled.`,
    env_provider_outage: `Vault Quest generation is paused (provider-outage mode).`,
    db_flag_off: `Vault Quest ${feature} is temporarily disabled.`,
    not_yet_enabled: `This generation type is not yet enabled — an owner must turn it on first.`,
  };
  return {
    status: 503,
    retryAfterSeconds: 120,
    body: {
      error: msg[state.reason] ?? `Vault Quest ${feature} is disabled.`,
      feature,
      disabled: true,
      reason: state.reason,
      source: state.source,
    },
  };
}

// ── Automatic paid retry toggle (spend-guard hardening) ──────────────────────
//
// Deliberately NOT part of VqFeature/vqFeatureState above: every existing flag
// there defaults to ENABLED when its row is absent (the "a missing flag never
// disables VQ" invariant this file's own header documents). Automatic paid
// retry must default the OPPOSITE way — OFF until an owner explicitly turns it
// on — so a fresh/unmigrated DB is the SAFER state (fewer paid provider calls),
// not the more permissive one. Reusing vqFeatureState's polarity here would
// silently invert this requirement, so it gets its own tiny, explicit function
// instead of a new branch in the shared default-on evaluator.
export const AUTO_RETRY_FEATURE = "auto_paid_retry" as const;

/** true only when the owner has explicitly stored {feature:"auto_paid_retry",
 *  enabled:true} in vq_feature_flags. Absent row, false row, or a degraded (table
 *  missing) read via loadVqDbFlags()'s {} fallback all resolve to false — the
 *  conservative, spend-safe default. */
export function isAutomaticPaidRetryEnabled(dbFlags: VqDbFlags | Record<string, boolean>): boolean {
  return (dbFlags as Record<string, boolean | undefined>)[AUTO_RETRY_FEATURE] === true;
}
