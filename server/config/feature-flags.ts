/**
 * Central feature flags — server is source of truth.
 * Client reads via GET /api/config/public-flags.
 */
export const FEATURE_FLAGS = {
  LEGAL_PAGES_LIVE: process.env.LEGAL_PAGES_LIVE === "true",
} as const;
