/**
 * server/vault-club-tiers.ts
 *
 * Central definition of every Vault Club tier and its perks.
 * Single source of truth for all tier-gated logic on both server and client
 * (imported directly by server; client has a copy in shared data).
 */

export const VAULT_CLUB_TIERS = {
  bronze: {
    label: "Bronze Vault",
    monthly_price_pence: 499,
    annual_price_pence: 4900,
    grading_discount_percent: 5,
    ai_credits_monthly: 30,
    showroom_themes: ["cream", "dark", "charcoal"],
    custom_banner: false,
    skip_queue_tiers: ["standard"],
    quarterly_reholders: 0,
    members_only_vault_design: false,
    featured_collector_rotation: false,
    free_express_upgrade: false,
    badge: "bronze",
  },
  silver: {
    label: "Silver Vault",
    monthly_price_pence: 999,
    annual_price_pence: 9900,
    grading_discount_percent: 10,
    ai_credits_monthly: 100,
    showroom_themes: ["cream", "dark", "charcoal", "midnight", "ivory", "slate", "warm-grey", "pure-white"],
    custom_banner: true,
    skip_queue_tiers: ["standard", "priority", "express"],
    quarterly_reholders: 1,
    members_only_vault_design: true,
    featured_collector_rotation: false,
    free_express_upgrade: false,
    badge: "silver",
  },
  gold: {
    label: "Gold Vault",
    monthly_price_pence: 1999,
    annual_price_pence: 19900,
    grading_discount_percent: 20,
    ai_credits_monthly: 400,
    showroom_themes: ["cream", "dark", "charcoal", "midnight", "ivory", "slate", "warm-grey", "pure-white"],
    custom_banner: true,
    skip_queue_tiers: ["standard", "priority", "express"],
    quarterly_reholders: 4,
    members_only_vault_design: true,
    featured_collector_rotation: true,
    free_express_upgrade: true,
    badge: "gold",
  },
} as const;

export type VaultClubTier = keyof typeof VAULT_CLUB_TIERS;

export const TIER_ORDER: Record<VaultClubTier, number> = { bronze: 1, silver: 2, gold: 3 };

export function getActiveTierDiscount(tier: string | null | undefined): number {
  if (!tier || !(tier in VAULT_CLUB_TIERS)) return 0;
  return VAULT_CLUB_TIERS[tier as VaultClubTier].grading_discount_percent;
}

/** True when a subscription status counts as "active" for gating purposes */
export function isActiveStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "trialing";
}

/** Returns the end of the current calendar quarter (UTC) */
export function endOfCurrentQuarter(now = new Date()): Date {
  const month = now.getUTCMonth(); // 0-11
  const quarter = Math.floor(month / 3); // 0-3
  const quarterEndMonth = (quarter + 1) * 3; // month index after quarter end
  return new Date(Date.UTC(now.getUTCFullYear(), quarterEndMonth, 1, 0, 0, 0, 0));
}

/** Returns the UTC year+quarter key "YYYY-Q{n}" for any date */
export function quarterKey(d: Date): string {
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}
