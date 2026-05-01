/**
 * client/src/config/vault-club-perks.ts
 *
 * Single source of truth for the Silver Vault Club perks list shown on the
 * marketing page (/vault-club Section II) and the account page
 * (/account/vault-club). Extracted Step 4 — used to live inline in
 * pages/vault-club.tsx.
 *
 * Numeric values mirror the SILVER plan config; if the plan changes
 * (e.g. AI credits adjusted), update both this file and the SILVER constant
 * at the top of pages/vault-club.tsx.
 */

import { insuranceTiers } from "@shared/schema";
import { ADDON_PRICES } from "@shared/addons";

const SILVER = {
  monthly_price_pence: 999,
  annual_price_pence: 9900,
  ai_credits_monthly: 100,
  free_authentication_monthly: 2,
} as const;

const AUTH_PRICE_PENCE = ADDON_PRICES.authentication.price; // 1500
const MONTHLY_AUTH_VALUE_PENCE =
  AUTH_PRICE_PENCE * SILVER.free_authentication_monthly; // 3000
const SHIPPING_STANDARD = insuranceTiers[0].shippingPence; // 499
const SHIPPING_MAX = insuranceTiers[3].shippingPence; // 2499

const poundsFromPence = (p: number) =>
  `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;

export interface VaultClubPerk {
  number: string;
  title: string;
  body: string;
  value: string | null;
}

export const VAULT_CLUB_PERKS: ReadonlyArray<VaultClubPerk> = [
  {
    number: "01",
    title: "Priority queue within your grading tier",
    body: "Members jump ahead within their chosen tier. No turnaround SLA change, but first in, first out — every time.",
    value: null,
  },
  {
    number: "02",
    title: "Two free Authentication add-ons every month",
    body: "Worth £15 each. If you submit cards that need authentication, this alone covers the membership.",
    value: `${poundsFromPence(MONTHLY_AUTH_VALUE_PENCE)}/mo value`,
  },
  {
    number: "03",
    title: "Free return shipping on every declared-value tier",
    body: "High-value submitters save most. Standard tier saves £4.99 per submission; Max tier saves £24.99.",
    value: `${poundsFromPence(SHIPPING_STANDARD)}–${poundsFromPence(SHIPPING_MAX)} / submission`,
  },
  {
    number: "04",
    title: `${SILVER.ai_credits_monthly} AI Pre-Grade credits every month`,
    body: "Test cards before submitting. Credits reset monthly — no rollover — so use them or lose them.",
    value: "Unlimited practical use",
  },
  {
    number: "05",
    title: "Early access to Population Report features",
    body: "See new filters, exports, and analytics before they ship publicly. Shape the tool as it grows.",
    value: "Priority access",
  },
];

export const VAULT_CLUB_SILVER = SILVER;
export const VAULT_CLUB_PENCE_TO_POUNDS = poundsFromPence;
