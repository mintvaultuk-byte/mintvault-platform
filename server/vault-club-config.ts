/**
 * server/vault-club-config.ts
 *
 * Stripe price IDs for Vault Club subscriptions.
 *
 * HOW TO POPULATE:
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
