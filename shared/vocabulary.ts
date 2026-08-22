/**
 * Small closed vocabularies the browser needs — catalogue categories and the
 * Instagram post types.
 *
 * Split out of shared/schema.ts for the same bundling reason as
 * shared/commerce.ts and shared/grade-presentation.ts: the barrel's
 * `pgTable(...)` calls cannot be tree-shaken, so importing ONE value from it
 * ships the entire database schema. These are plain string unions with no
 * Drizzle, no database and no scoring engine. Re-exported from the barrel so
 * server call sites are unchanged.
 */

export const CATALOGUE_CATEGORIES = [
  "rarity",
  "finish",
  "promo",
  "designation",
  "language",
  "era",
  "subset",
  "attribute",
] as const;
export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];

export const IG_POST_TYPES = [
  "card_reveal",
  "grade_breakdown",
  "service_explainer",
  "vault_club",
  "market_insight",
] as const;
export type IgPostType = (typeof IG_POST_TYPES)[number];
