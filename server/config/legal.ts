/**
 * Legal document configuration.
 * Update TERMS_VERSION when swapping to solicitor-reviewed documents.
 */
export const TERMS_VERSION = "v1.0-draft-pre-solicitor";

export const LEGAL_SLUGS = [
  "website-terms",
  "submission-agreement",
  "guarantee",
  "privacy-policy",
  "shipping-requirements",
] as const;

export type LegalSlug = typeof LEGAL_SLUGS[number];
