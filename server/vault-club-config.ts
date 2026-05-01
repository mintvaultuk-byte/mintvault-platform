/**
 * server/vault-club-config.ts
 *
 * Stripe Price IDs for Vault Club subscriptions.
 *
 * ⚠️ TEST MODE — Mintvault sandbox account `acct_1T3vbuRN7H2pRqKE`.
 * Live-mode Price IDs land at the Phase 4 launch boundary alongside the
 * STRIPE_SECRET_KEY (live) + webhook secret rotation. Do NOT replace
 * these with live IDs until that step.
 *
 * Silver-only launch — Bronze and Gold tiers were deprecated 2026-04-19.
 * Old test IDs from the prior sandbox (`acct_1T3qghPFVe8DwVlR`) have been
 * retired; that account is no longer connected.
 *
 * Pricing:
 *   silver_monthly  £9.99/mo   price_1TRu3ZRN7H2pRqKEdizTS400
 *   silver_annual   £99/year   price_1TRuBoRN7H2pRqKETrqFwK1M
 */

export const VAULT_CLUB_PRICE_IDS = {
  silver: {
    month: "price_1TRu3ZRN7H2pRqKEdizTS400",
    year: "price_1TRuBoRN7H2pRqKETrqFwK1M",
  },
} as const;

export type VaultClubTier = keyof typeof VAULT_CLUB_PRICE_IDS;
export type VaultClubInterval = "month" | "year";

export function getPriceId(tier: VaultClubTier, interval: VaultClubInterval): string {
  return VAULT_CLUB_PRICE_IDS[tier][interval];
}

/**
 * Reverse-lookup: given a Stripe Price ID, return its billing interval, or
 * null if the ID isn't one we recognise (e.g. a legacy/archived price).
 *
 * Used by GET /api/vault-club/me to derive the human-readable interval for
 * the account dashboard. Iterating over the small fixed PRICE_IDS map is
 * fine; if this grows, switch to a reverse map built once at module load.
 */
export function intervalForPriceId(priceId: string): VaultClubInterval | null {
  for (const tier of Object.keys(VAULT_CLUB_PRICE_IDS) as VaultClubTier[]) {
    for (const interval of ["month", "year"] as const) {
      if (VAULT_CLUB_PRICE_IDS[tier][interval] === priceId) return interval;
    }
  }
  return null;
}
