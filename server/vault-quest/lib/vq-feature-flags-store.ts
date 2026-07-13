/**
 * DB adapter for the already-built, already-unit-tested VQ emergency feature-flag
 * evaluator (Phase 7E, lib/vq-feature-state.ts). Phase 10A-4 wires it live.
 *
 * Reads `vq_feature_flags` (migration 0011, already applied) and degrades to `{}`
 * on a missing table/column (isUndefinedTableOrColumn) — an absent flag is ALWAYS
 * default-on by the pure module's own design, so a not-yet-migrated DB never
 * disables Vault Quest; it just means the DB-toggle layer is inert until the table
 * exists (the env hard-off vars still work with zero DB dependency either way).
 */
import { db } from "../../db";
import { vqFeatureFlags } from "@shared/vq-feature-flags-schema";
import { isUndefinedTableOrColumn } from "../production-storage";
import { vqFeatureState, vqDisabledResponse, type VqFeature, type VqDbFlags, type VqFlagEnv } from "./vq-feature-state";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUndefinedTableOrColumn(err)) return fallback;
    throw err;
  }
}

/** Load all DB-toggle rows as a plain feature→enabled map (degrades to {} safely). */
export async function loadVqDbFlags(): Promise<VqDbFlags> {
  const rows = await safe(async () => db.select({ feature: vqFeatureFlags.feature, enabled: vqFeatureFlags.enabled }).from(vqFeatureFlags), []);
  const out: VqDbFlags = {};
  for (const r of rows) out[r.feature as VqFeature] = r.enabled;
  return out;
}

function envSnapshot(): VqFlagEnv {
  return {
    VQ_GENERATION_DISABLED: process.env.VQ_GENERATION_DISABLED,
    VQ_EXPORTS_DISABLED: process.env.VQ_EXPORTS_DISABLED,
    VQ_READONLY: process.env.VQ_READONLY,
    VQ_PROVIDER_OUTAGE: process.env.VQ_PROVIDER_OUTAGE,
  };
}

/**
 * The single check every gated route/middleware calls: resolves live env + DB state
 * and returns either `{ok:true}` (proceed) or `{ok:false, response}` (the caller must
 * respond with `response` and go no further — never call a provider, never spend,
 * never write).
 */
export async function checkVqFeature(feature: VqFeature): Promise<
  { ok: true } | { ok: false; response: ReturnType<typeof vqDisabledResponse> }
> {
  const dbFlags = await loadVqDbFlags();
  const state = vqFeatureState(feature, envSnapshot(), dbFlags);
  if (state.enabled) return { ok: true };
  return { ok: false, response: vqDisabledResponse(feature, state) };
}

/**
 * The owner's toggle (Phase 10A-5, R4-F4): upsert a DB flag row with an audit
 * trail (who, when, why). This is the ONLY write allowed to bypass the global
 * `vqWritesGate` — an emergency writes-freeze must never trap the owner unable
 * to un-freeze it. Cannot set an env hard-off (those are Fly secrets, deliberately
 * out of DB/API reach) — this only ever affects the DB-toggle layer.
 *
 * Deliberately NOT wrapped in the read-side `safe()` degrade: a write must fail
 * LOUDLY if the table is missing (the owner needs to know their toggle did
 * nothing), whereas a read safely defaulting to "enabled" is the correct fail-open
 * behaviour for every other caller.
 */
export async function setVqFeatureFlag(feature: VqFeature, enabled: boolean, updatedBy: string, reason?: string): Promise<void> {
  await db
    .insert(vqFeatureFlags)
    .values({ feature, enabled, reason: reason ?? null, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({ target: vqFeatureFlags.feature, set: { enabled, reason: reason ?? null, updatedBy, updatedAt: new Date() } });
}
