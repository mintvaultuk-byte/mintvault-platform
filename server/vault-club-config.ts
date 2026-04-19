/**
 * server/vault-club-config.ts
 *
 * Stripe price IDs for Vault Club subscriptions.
 *
 * Bronze and Gold deprecated 2026-04-19 — Silver-only launch. Price IDs
 * retained below so historical webhook events still route; archive the Bronze
 * and Gold prices via the Stripe dashboard manually. Do not delete the entries
 * — deprecation is config-level (is_active=false in vault-club-tiers.ts).
 *
 * HOW TO POPULATE (Silver only, post-1A):
 *   After deploying, call:
 *     POST /api/admin/vault-club/setup-stripe-products
 *   It will print the price IDs to the console. Paste them here, then redeploy.
 *
 * Price IDs are empty strings until the setup endpoint has been run.
 */
export const VAULT_CLUB_PRICE_IDS: Record<string, Record<string, string>> = {
  bronze: { month: "price_1TJv4SRN7H2pRqKEgusCS999", year: "price_1TJv4SRN7H2pRqKEMBq3Tp2S" },
  silver: { month: "price_1TJv4TRN7H2pRqKEISdUbktX", year: "price_1TJv4TRN7H2pRqKERZbeCyhI" },
  gold:   { month: "price_1TJv4URN7H2pRqKE6VgB2ftm", year: "price_1TJv4VRN7H2pRqKEUqTHbgHq" },
};

export function getPriceId(tier: string, interval: string): string | null {
  const id = VAULT_CLUB_PRICE_IDS[tier]?.[interval];
  return id || null;
}
