/**
 * shared/addons.ts
 *
 * Static ADDON_PRICES config for marketing display surfaces (pricing pages,
 * SEO pages, guides). This is the display source of truth.
 *
 * Server-side pricing for addons continues to read from the `service_tiers` DB
 * table via storage.getServiceTiers() — values there are kept in sync with
 * this config. Verified 2026-04-19: DB values match these constants exactly.
 * If they ever diverge, prefer the DB for charging logic and update this file.
 */

export const ADDON_PRICES = {
  reholder: {
    id: "reholder",
    name: "Reholder",
    price: 1500,
    display: "£15",
    description: "Transfer your card into a new MintVault slab with updated NFC and certificate.",
  },
  crossover: {
    id: "crossover",
    name: "Crossover",
    price: 3500,
    display: "£35",
    description: "Re-grade a card from PSA, BGS, CGC, or another grading company.",
  },
  authentication: {
    id: "authentication",
    name: "Authentication",
    price: 1500,
    display: "£15",
    description: "Verify authenticity and check for alterations — no grade assigned.",
  },
} as const;

export type AddonId = keyof typeof ADDON_PRICES;

export const ADDON_ORDER: readonly AddonId[] = ["reholder", "crossover", "authentication"];
