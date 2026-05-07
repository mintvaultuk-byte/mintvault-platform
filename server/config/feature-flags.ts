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

  // ── AI feature toggles (per docs/ai-audit.md, 2026-05-07) ─────────────────
  // Per-feature kill-switches so we can disable individual AI calls without
  // unsetting ANTHROPIC_API_KEY (which would 503 every AI route at once).
  // Default-ON flags use !== "false" (require explicit opt-out).
  // Default-OFF flags use === "true" (require explicit opt-in).
  AI_IDENTIFY_ENABLED:           process.env.AI_IDENTIFY_ENABLED         !== "false", // default ON
  AI_DEFECT_SUGGEST_ENABLED:     process.env.AI_DEFECT_SUGGEST_ENABLED   === "true",  // default OFF
  AI_HAIKU_QUICK_GRADE_ENABLED:  process.env.AI_HAIKU_QUICK_GRADE_ENABLED === "true", // default OFF
  AI_FULL_GRADE_ENABLED:         process.env.AI_FULL_GRADE_ENABLED       === "true",  // default OFF
  AI_CENTERING_ENABLED:          process.env.AI_CENTERING_ENABLED        === "true",  // default OFF
  AI_STANDALONE_DETECT_ENABLED:  process.env.AI_STANDALONE_DETECT_ENABLED === "true", // default OFF
  AI_STANDALONE_GRADE_ENABLED:   process.env.AI_STANDALONE_GRADE_ENABLED === "true",  // default OFF
  AI_DESCRIPTION_GEN_ENABLED:    process.env.AI_DESCRIPTION_GEN_ENABLED  !== "false", // default ON
  AI_GPT_SECOND_OPINION_ENABLED: process.env.AI_GPT_SECOND_OPINION_ENABLED === "true",// default OFF
  AI_PUBLIC_ESTIMATE_ENABLED:    process.env.AI_PUBLIC_ESTIMATE_ENABLED  !== "false", // default ON
} as const;
