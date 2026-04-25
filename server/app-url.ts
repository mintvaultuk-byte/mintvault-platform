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
