/**
 * Central feature flags — server is source of truth.
 * Client reads via GET /api/config/public-flags.
 *
 * Two systems live here:
 *
 * 1. FEATURE_FLAGS (sync env-var const) — for non-AI flags (LEGAL_PAGES_LIVE,
 *    TRANSFER_FLOW_LIVE) and for the env-var DEFAULTS of the 10 AI flags.
 *    Computed once at boot. Never changes at runtime.
 *
 * 2. getFeatureFlag(name) (async, DB-aware) — for the 10 AI_* flags only.
 *    Reads feature_overrides table first, falls back to FEATURE_FLAGS[name].
 *    In-memory cached for 30s to avoid hammering the DB on every AI call.
 *    Override writes call invalidateFeatureFlagCache() to clear immediately.
 */

import { db } from "../db";
import { featureOverrides } from "@shared/schema";
import { sql } from "drizzle-orm";

export const FEATURE_FLAGS = {
  LEGAL_PAGES_LIVE: process.env.LEGAL_PAGES_LIVE === "true",

  // v435 — gates the entire public-facing transfer flow (seller-initiated +
  // buyer-initiated). Admin endpoints (/api/admin/transfers/*) are NOT
  // gated — admins can always inspect/resolve. Default false until
  // solicitor sign-off on dispute policy + transfer T&Cs (see PR #v435).
  TRANSFER_FLOW_LIVE: process.env.TRANSFER_FLOW_LIVE === "true",

  // Per-user public-name toggle. When true, /api/v1/verify/:certId may
  // surface owner displayName (only if the owner has opted in via the
  // toggle in account settings AND has a non-empty displayName). When
  // false, the feature is invisible end-to-end: settings row hidden,
  // /api/auth/me omits public_name, verify endpoint never includes
  // ownerDisplayName regardless of column value. Default false.
  PUBLIC_NAME_TOGGLE_LIVE: process.env.PUBLIC_NAME_TOGGLE_LIVE === "true",

  // ── AI feature toggles (per docs/ai-audit.md, 2026-05-07) ─────────────────
  // Per-feature kill-switches so we can disable individual AI calls without
  // unsetting ANTHROPIC_API_KEY (which would 503 every AI route at once).
  // Default-ON flags use !== "false" (require explicit opt-out).
  // Default-OFF flags use === "true" (require explicit opt-in).
  // These are now ENV DEFAULTS — runtime overrides live in feature_overrides
  // and are read via getFeatureFlag() below.
  AI_IDENTIFY_ENABLED: process.env.AI_IDENTIFY_ENABLED !== "false", // default ON
  AI_DEFECT_SUGGEST_ENABLED: process.env.AI_DEFECT_SUGGEST_ENABLED === "true", // default OFF
  AI_HAIKU_QUICK_GRADE_ENABLED: process.env.AI_HAIKU_QUICK_GRADE_ENABLED === "true", // default OFF
  AI_FULL_GRADE_ENABLED: process.env.AI_FULL_GRADE_ENABLED === "true", // default OFF
  AI_CENTERING_ENABLED: process.env.AI_CENTERING_ENABLED === "true", // default OFF
  AI_STANDALONE_DETECT_ENABLED: process.env.AI_STANDALONE_DETECT_ENABLED === "true", // default OFF
  AI_STANDALONE_GRADE_ENABLED: process.env.AI_STANDALONE_GRADE_ENABLED === "true", // default OFF
  AI_DESCRIPTION_GEN_ENABLED: process.env.AI_DESCRIPTION_GEN_ENABLED !== "false", // default ON
  AI_GPT_SECOND_OPINION_ENABLED: process.env.AI_GPT_SECOND_OPINION_ENABLED === "true", // default OFF
  AI_PUBLIC_ESTIMATE_ENABLED: process.env.AI_PUBLIC_ESTIMATE_ENABLED !== "false", // default ON

  // ── TCGdex card-lookup flags ──────────────────────────────────────────────
  AI_CARD_LOOKUP_PREFILL_ENABLED: process.env.AI_CARD_LOOKUP_PREFILL_ENABLED !== "false", // default ON
  AI_AUTO_ADD_MISSING_SETS_ENABLED: process.env.AI_AUTO_ADD_MISSING_SETS_ENABLED === "true", // default OFF

  // ── AI Card Identification Assistant (structured Quick-Identify) ───────────
  // Gates the whole structured identify pipeline. Default OFF — the founder
  // enables it explicitly via /api/admin/ai-feature-flags. Manual grading works
  // regardless; when off the route returns 503 and the UI shows manual entry.
  AI_CARD_IDENTIFICATION_ENABLED: process.env.AI_CARD_IDENTIFICATION_ENABLED === "true", // default OFF
} as const;

/** All AI flag names that participate in the runtime-toggle system. */
export const AI_FLAG_NAMES = [
  "AI_IDENTIFY_ENABLED",
  "AI_DEFECT_SUGGEST_ENABLED",
  "AI_HAIKU_QUICK_GRADE_ENABLED",
  "AI_FULL_GRADE_ENABLED",
  "AI_CENTERING_ENABLED",
  "AI_STANDALONE_DETECT_ENABLED",
  "AI_STANDALONE_GRADE_ENABLED",
  "AI_DESCRIPTION_GEN_ENABLED",
  "AI_GPT_SECOND_OPINION_ENABLED",
  "AI_PUBLIC_ESTIMATE_ENABLED",
  "AI_CARD_LOOKUP_PREFILL_ENABLED",
  "AI_AUTO_ADD_MISSING_SETS_ENABLED",
  "AI_CARD_IDENTIFICATION_ENABLED",
] as const;

export type AiFlagName = (typeof AI_FLAG_NAMES)[number];

// ── Override cache ────────────────────────────────────────────────────────
// Snapshot of every override row in feature_overrides, refreshed at most
// every 30s. A null value means "no override exists" (use env default).
type OverrideSnapshot = Map<string, boolean>;
let cache: { snapshot: OverrideSnapshot; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

async function loadOverridesFromDb(): Promise<OverrideSnapshot> {
  const map: OverrideSnapshot = new Map();
  try {
    const rows = await db.execute(sql`SELECT name, enabled FROM feature_overrides`);
    for (const r of rows.rows as { name: string; enabled: boolean }[]) {
      map.set(r.name, r.enabled);
    }
  } catch (err: any) {
    // Table may not exist yet (pre-migration) — treat as no overrides.
    // Logged once per cache miss so we don't spam.
    console.warn("[feature-flags] could not read feature_overrides (assuming env defaults):", err?.message || err);
  }
  return map;
}

async function getCachedSnapshot(): Promise<OverrideSnapshot> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.snapshot;
  const snapshot = await loadOverridesFromDb();
  cache = { snapshot, expiresAt: now + CACHE_TTL_MS };
  return snapshot;
}

/** Clear the in-memory override cache. Called by toggle write endpoints
 *  so the next read picks up the change immediately instead of waiting
 *  out the 30s TTL. */
export function invalidateFeatureFlagCache(): void {
  cache = null;
}

/**
 * Resolve a feature flag — DB override first, env default second.
 *
 * Use for the 10 AI_* flags. For LEGAL_PAGES_LIVE / TRANSFER_FLOW_LIVE,
 * keep using the sync FEATURE_FLAGS const directly — those don't have
 * runtime toggles.
 */
export async function getFeatureFlag(name: AiFlagName): Promise<boolean> {
  const snapshot = await getCachedSnapshot();
  if (snapshot.has(name)) {
    return snapshot.get(name) as boolean;
  }
  return FEATURE_FLAGS[name];
}

/** Snapshot of ALL AI flags' resolved state. Used by the dashboard endpoint. */
export async function getAllAiFlags(): Promise<
  {
    name: AiFlagName;
    enabled: boolean;
    envDefault: boolean;
    overrideSet: boolean;
  }[]
> {
  const snapshot = await getCachedSnapshot();
  return AI_FLAG_NAMES.map((name) => ({
    name,
    enabled: snapshot.has(name) ? (snapshot.get(name) as boolean) : FEATURE_FLAGS[name],
    envDefault: FEATURE_FLAGS[name],
    overrideSet: snapshot.has(name),
  }));
}
