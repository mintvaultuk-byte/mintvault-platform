/**
 * Legal document configuration.
 * Update TERMS_VERSION when swapping to solicitor-reviewed documents.
 */
export const TERMS_VERSION = "v1.0-draft-pre-solicitor";

export const LEGAL_SLUGS = [
  "website-terms",
  "submission-agreement",
  "guarantee",                          // legacy slug — kept for backwards compat, aliased below
  "guarantee-and-correction-policy",    // canonical slug; resolves to content/legal/guarantee.md via LEGAL_ALIASES
  "privacy-policy",
  "shipping-requirements",
  "cookies",
  "grading-standards",
  "cancel",
  "adr",
] as const;

export type LegalSlug = typeof LEGAL_SLUGS[number];

/**
 * Slug → filename map for slugs that don't match their on-disk markdown file.
 * The legal API handler reads content/legal/${LEGAL_ALIASES[slug] ?? slug}.md.
 */
export const LEGAL_ALIASES: Record<string, string> = {
  "guarantee-and-correction-policy": "guarantee",
};
