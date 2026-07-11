/**
 * Pure VQ config resolution (Phase 10A D4). Maps raw key/value rows (from vq_config,
 * or {} when the table/row is absent) to typed spend ceilings + operational values,
 * with CONSERVATIVE code defaults. No DB import here — the caller supplies the rows
 * (safe()/42P01-degraded to {} on a missing table), so this stays unit-testable and
 * a missing table can never 500 or block a paid route.
 *
 * Production values remain owner-gated: they are set as vq_config rows on staging/prod
 * later; until then these conservative defaults apply.
 */

export interface VqSpendCeilings {
  maxImagesPerRequest: number;
  maxCreditsPerRequest: number;
  maxCreditsPerBatch: number;
  maxRequestsPerHour: number;
  maxCreditsPerDay: number;
  providerPollMaxAttempts: number;
}

/** Conservative defaults used when a vq_config row is absent or unparseable. */
export const VQ_CONFIG_DEFAULTS: VqSpendCeilings = {
  maxImagesPerRequest: 3,
  maxCreditsPerRequest: 5,
  maxCreditsPerBatch: 12,
  maxRequestsPerHour: 30,
  maxCreditsPerDay: 50,
  providerPollMaxAttempts: 40,
};

const KEY: Record<keyof VqSpendCeilings, string> = {
  maxImagesPerRequest: "spend.max_images_per_request",
  maxCreditsPerRequest: "spend.max_credits_per_request",
  maxCreditsPerBatch: "spend.max_credits_per_batch",
  maxRequestsPerHour: "spend.max_requests_per_hour",
  maxCreditsPerDay: "spend.max_credits_per_day",
  providerPollMaxAttempts: "provider.poll_max_attempts",
};

/** Parse a raw string to a non-negative finite number, else the default (safe parse). */
function num(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve spend ceilings from a raw key→value map (as loaded from vq_config, or {} when
 * the table is absent). Every field falls back to its conservative default independently,
 * so a partial/empty/missing config is always safe.
 */
export function resolveVqCeilings(rows: Record<string, string> | null | undefined): VqSpendCeilings {
  const r = rows ?? {};
  const out = { ...VQ_CONFIG_DEFAULTS };
  (Object.keys(KEY) as (keyof VqSpendCeilings)[]).forEach((field) => {
    out[field] = num(r[KEY[field]], VQ_CONFIG_DEFAULTS[field]);
  });
  return out;
}

/** The config keys, for seeding/admin display. */
export const VQ_CONFIG_KEYS = KEY;
