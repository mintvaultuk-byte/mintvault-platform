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
 * The base URL for CREDENTIAL links, which must never be guessed.
 *
 * WHY THIS IS SEPARATE FROM `APP_BASE_URL`. The fallback above is a reasonable default for a
 * verify URL or a QR code: pointing a public certificate link at the brand domain is harmless
 * even from the wrong box. A PASSWORD RESET LINK is not that. If staging's `APP_URL` secret is
 * ever unset, the fallback would send a partner a link to PRODUCTION carrying a token that only
 * staging can redeem — the link fails, and worse, we have emailed a credential-bearing URL for a
 * system the recipient was not being asked to authenticate against.
 *
 * Both Fly apps currently set `APP_URL` (verified 2026-08-17, distinct digests on `mintvault` and
 * `mintvault-v2`), so this changes nothing today. It exists so that removing the secret produces
 * an undelivered email and a loud failure, rather than a silently cross-environment one.
 *
 * Throws rather than returning a default, because there is no safe default for this.
 */
export function requireCredentialLinkBaseUrl(): string {
  const configured = process.env.APP_URL;
  if (!configured || !configured.trim()) {
    throw new Error(
      "APP_URL is not set, so no credential link can be addressed. Refusing to fall back to the " +
        "brand domain: a reset link must point at the deployment that minted the token."
    );
  }
  return configured.replace(/\/$/, "");
}
