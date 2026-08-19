/**
 * Pure publication gates shared by API and SSR code. This module deliberately
 * has no database imports, so server-rendered metadata cannot drift from the
 * application route that accepts personal information.
 */
export type PublicationFlags = {
  LEGAL_PAGES_LIVE: boolean;
  PRIVACY_NOTICE_LIVE: boolean;
  PARTNER_APPLICATIONS_LIVE: boolean;
};

export function isPrivacyNoticeLive(
  env: { PRIVACY_NOTICE_LIVE?: string } = { PRIVACY_NOTICE_LIVE: process.env.PRIVACY_NOTICE_LIVE }
): boolean {
  return env.PRIVACY_NOTICE_LIVE === "true";
}

export function arePartnerApplicationsLive(
  env: { PRIVACY_NOTICE_LIVE?: string; PARTNER_APPLICATIONS_LIVE?: string } = {
    PRIVACY_NOTICE_LIVE: process.env.PRIVACY_NOTICE_LIVE,
    PARTNER_APPLICATIONS_LIVE: process.env.PARTNER_APPLICATIONS_LIVE,
  }
): boolean {
  return isPrivacyNoticeLive(env) && env.PARTNER_APPLICATIONS_LIVE === "true";
}

export function isLegalDocumentPublic(slug: string, flags: PublicationFlags): boolean {
  return slug === "privacy-policy" ? flags.PRIVACY_NOTICE_LIVE : flags.LEGAL_PAGES_LIVE;
}
