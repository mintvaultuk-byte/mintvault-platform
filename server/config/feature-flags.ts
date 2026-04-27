/**
 * Central feature flags — server is source of truth.
 * Client reads via GET /api/config/public-flags.
 */
export const FEATURE_FLAGS = {
  LEGAL_PAGES_LIVE: process.env.LEGAL_PAGES_LIVE === "true",

  // v435 — gates the entire public-facing transfer flow (seller-initiated +
  // buyer-initiated). Admin endpoints (/api/admin/transfers/*) are NOT
  // gated — admins can always inspect/resolve. Default false until
  // solicitor sign-off on dispute policy + transfer T&Cs (see PR #v435).
  TRANSFER_FLOW_LIVE: process.env.TRANSFER_FLOW_LIVE === "true",
} as const;
