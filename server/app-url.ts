/**
 * Centralised app base URL accessor.
 *
 * Returns process.env.APP_URL when set, otherwise the legacy hardcoded
 * brand URL. Used everywhere we need to construct customer-facing links
 * (verify URLs, claim URLs, transfer flow URLs, email <a href> templates,
 * PDF QR/click-through links, etc).
 *
 * Why this exists: prior to this refactor, the brand URL was hardcoded in
 * ~22 places across 7 files. Some sites already used `process.env.APP_URL
 * || "..."` inline, others didn't. Migration to the live brand domain
 * post-domain-transfer needs to be a single Fly secret flip, not a code
 * change. This helper makes that possible.
 *
 * Setting APP_URL on Fly:
 *   fly secrets set APP_URL=https://mintvaultuk.com --app mintvault
 *   fly secrets set APP_URL=https://mintvault-v2.fly.dev --app mintvault-v2
 *
 * Trailing slashes are NEVER appended by this helper. Callers append paths
 * directly: `${APP_BASE_URL}/cert/${certId}`.
 */
export const APP_BASE_URL: string =
  process.env.APP_URL || "https://mintvaultuk.com";

/**
 * Base URL for third-party services that redirect the user's browser back
 * to us — Stripe Checkout success/cancel, Stripe Billing Portal return,
 * OAuth callbacks, etc.
 *
 * Production: same as APP_BASE_URL.
 * Dev (NODE_ENV !== "production"): hardcoded `http://localhost:5000` so
 * the post-flow landing happens on the developer's machine instead of
 * being yeeted to mintvaultuk.com (which is what APP_BASE_URL resolves
 * to when APP_URL is set in dev .env files).
 *
 * Do NOT use this for URLs sent in emails, NFC tags, QR codes, or PDFs —
 * those need to resolve to the real domain regardless of NODE_ENV
 * because the user clicks them from outside the browser session that
 * issued them. Use APP_BASE_URL for those.
 */
export function getRedirectBaseUrl(): string {
  return process.env.NODE_ENV === "production"
    ? APP_BASE_URL
    : "http://localhost:5000";
}
