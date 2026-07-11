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

export type VqFeature = "generation" | "exports" | "writes";

export interface VqFlagEnv {
  VQ_GENERATION_DISABLED?: string;
  VQ_EXPORTS_DISABLED?: string;
  VQ_READONLY?: string; // compound: writes + generation
  VQ_PROVIDER_OUTAGE?: string; // forces generation off (provider-outage mode)
}

/** DB runtime toggles. true=enabled, false=disabled, absent=no opinion (→ default-on). */
export type VqDbFlags = Partial<Record<VqFeature, boolean>>;

export type VqDisableReason = "env_hard_off" | "env_readonly" | "env_provider_outage" | "db_flag_off";
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

  // 3) default-ON (a missing flag never disables VQ)
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
