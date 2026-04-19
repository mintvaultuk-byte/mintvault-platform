/**
 * server/vault-club-tiers.ts
 *
 * Central definition of every Vault Club tier and its perks.
 *
 * Bronze and Gold deprecated 2026-04-19 — Silver-only launch. Stripe price IDs
 * retained in vault-club-config.ts but archive those prices manually via the
 * Stripe dashboard.
 *
 * The active perk model for Silver is perks-and-credits (free shipping, free
 * monthly authentication credits, queue-jump, AI credits) — NOT a percentage
 * grading discount. Percentage discounts removed 2026-04-19. Per-perk
 * evaluation (applying free shipping / free auth at checkout) is deferred to
 * Phase 1B. For now the config carries the flags; consumers are no-ops.
 */

export interface VaultClubTierConfig {
  label: string;
  monthly_price_pence: number;
  annual_price_pence: number;
  is_active: boolean;
  deprecated_at: string | null;
  ai_credits_monthly: number;
  queue_jump_within_tier: boolean;
  free_authentication_monthly: number;
  free_return_shipping: boolean;
  early_pop_report_access: boolean;
  showroom_themes: readonly string[];
  custom_banner: boolean;
  members_only_vault_design: boolean;
  featured_collector_rotation: boolean;
  badge: string;
}

export const VAULT_CLUB_TIERS: Record<string, VaultClubTierConfig> = {
  bronze: {
    label: "Bronze Vault",
    monthly_price_pence: 499,
    annual_price_pence: 4900,
    is_active: false,
    deprecated_at: "2026-04-19",
    ai_credits_monthly: 0,
    queue_jump_within_tier: false,
    free_authentication_monthly: 0,
    free_return_shipping: false,
    early_pop_report_access: false,
    showroom_themes: ["cream", "dark", "charcoal"],
    custom_banner: false,
    members_only_vault_design: false,
    featured_collector_rotation: false,
    badge: "bronze",
  },
  silver: {
    label: "Silver Vault",
    monthly_price_pence: 999,
    annual_price_pence: 9900,
    is_active: true,
    deprecated_at: null,
    ai_credits_monthly: 100,
    queue_jump_within_tier: true,
    free_authentication_monthly: 2,
    free_return_shipping: true,
    early_pop_report_access: true,
    showroom_themes: ["cream", "dark", "charcoal", "midnight", "ivory", "slate", "warm-grey", "pure-white"],
    custom_banner: true,
    members_only_vault_design: true,
    featured_collector_rotation: false,
    badge: "silver",
  },
  gold: {
    label: "Gold Vault",
    monthly_price_pence: 1999,
    annual_price_pence: 19900,
    is_active: false,
    deprecated_at: "2026-04-19",
    ai_credits_monthly: 0,
    queue_jump_within_tier: false,
    free_authentication_monthly: 0,
    free_return_shipping: false,
    early_pop_report_access: false,
    showroom_themes: ["cream", "dark", "charcoal", "midnight", "ivory", "slate", "warm-grey", "pure-white"],
    custom_banner: true,
    members_only_vault_design: true,
    featured_collector_rotation: true,
    badge: "gold",
  },
};

export type VaultClubTier = keyof typeof VAULT_CLUB_TIERS;

export const TIER_ORDER: Record<VaultClubTier, number> = { bronze: 1, silver: 2, gold: 3 };

/** True when a subscription status counts as "active" for gating purposes */
export function isActiveStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "trialing";
}

/** True when the tier is currently sold (is_active=true). Bronze/Gold return false. */
export function isActiveTier(tier: string | null | undefined): boolean {
  if (!tier || !(tier in VAULT_CLUB_TIERS)) return false;
  return VAULT_CLUB_TIERS[tier].is_active;
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
