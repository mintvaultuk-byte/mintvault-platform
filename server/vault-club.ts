/**
 * server/vault-club.ts
 *
 * All Vault Club subscription endpoints.
 * Registered via registerVaultClubRoutes() in server/routes.ts.
 */

import type { Express, Request, Response } from "express";
import Stripe from "stripe";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "./middleware/auth";
import { getStripeSecretKey } from "./stripeClient";
import { writeAuthAudit } from "./account-auth";
import { VAULT_CLUB_TIERS, type VaultClubTier, isActiveStatus, endOfCurrentQuarter, quarterKey } from "./vault-club-tiers";
import { VAULT_CLUB_PRICE_IDS, getPriceId } from "./vault-club-config";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getStripe(): Promise<Stripe> {
  const key = await getStripeSecretKey();
  return new Stripe(key, { apiVersion: "2025-08-27.basil" as any });
}

async function getUserVaultClub(userId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(sql`
    SELECT id, email, display_name,
           vault_club_tier, vault_club_status, vault_club_started_at,
           vault_club_renews_at, vault_club_cancels_at, vault_club_billing_interval,
           vault_club_grace_until,
           stripe_customer_id, stripe_subscription_id,
           ai_credits_user_balance, ai_credits_last_refilled_at,
           username
    FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) || null;
}

async function countMemberCreditsRemaining(userId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM member_credits
    WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > NOW()
  `);
  return parseInt((rows.rows[0] as any)?.cnt ?? "0", 10);
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerVaultClubRoutes(app: Express): void {

  // ── GET /api/vault-club/me ─────────────────────────────────────────────────
  app.get("/api/vault-club/me", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any).userId as string;
      const user = await getUserVaultClub(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const tier = user.vault_club_tier as VaultClubTier | null;
      const status = user.vault_club_status as string | null;
      const perks = tier ? VAULT_CLUB_TIERS[tier] : null;
      const memberCredits = tier ? await countMemberCreditsRemaining(userId) : 0;

      return res.json({
        tier,
        label: tier ? VAULT_CLUB_TIERS[tier].label : null,
        status,
        billing_interval: user.vault_club_billing_interval || null,
        renews_at: user.vault_club_renews_at || null,
        cancels_at: user.vault_club_cancels_at || null,
        started_at: user.vault_club_started_at || null,
        perks,
        ai_credits_balance: user.ai_credits_user_balance ?? 0,
        ai_credits_monthly: tier ? VAULT_CLUB_TIERS[tier].ai_credits_monthly : 0,
        next_refill_at: user.vault_club_renews_at || null,
        member_credits_remaining: memberCredits,
        stripe_customer_id: user.stripe_customer_id || null,
        username: user.username || null,
      });
    } catch (err: any) {
      console.error("[vault-club] me error:", err.message);
      return res.status(500).json({ error: "Failed to load Vault Club data." });
    }
  });

  // ── POST /api/vault-club/checkout ──────────────────────────────────────────
  app.post("/api/vault-club/checkout", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any).userId as string;
      const { tier, interval } = req.body;

      if (!tier || !["bronze", "silver", "gold"].includes(tier)) {
        return res.status(400).json({ error: "Invalid tier. Must be bronze, silver, or gold." });
      }
      if (!interval || !["month", "year"].includes(interval)) {
        return res.status(400).json({ error: "Invalid interval. Must be month or year." });
      }

      const priceId = getPriceId(tier, interval);
      if (!priceId) {
        return res.status(503).json({ error: "Stripe products not yet configured. Run POST /api/admin/vault-club/setup-stripe-products first." });
      }

      const user = await getUserVaultClub(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const stripe = await getStripe();
      const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";

      // Get or create Stripe customer
      let customerId = user.stripe_customer_id as string | null;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email as string,
          name: (user.display_name as string) || undefined,
          metadata: { user_id: userId },
        });
        customerId = customer.id;
        await db.execute(sql`
          UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${userId}
        `);
      }

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appUrl}/club?welcome=1`,
        cancel_url: `${appUrl}/club`,
        allow_promotion_codes: true,
        metadata: { user_id: userId, tier, interval },
      };

      // Annual plans get a 14-day trial; monthly plans do not
      if (interval === "year") {
        sessionParams.subscription_data = {
          trial_period_days: 14,
          metadata: { user_id: userId, tier, interval },
        };
      } else {
        sessionParams.subscription_data = {
          metadata: { user_id: userId, tier, interval },
        };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("[vault-club] checkout error:", err.message);
      return res.status(500).json({ error: "Failed to create checkout session." });
    }
  });

  // ── POST /api/vault-club/portal ────────────────────────────────────────────
  app.post("/api/vault-club/portal", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any).userId as string;
      const user = await getUserVaultClub(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const customerId = user.stripe_customer_id as string | null;
      if (!customerId) {
        return res.status(400).json({ error: "No Stripe subscription found. Join Vault Club first." });
      }

      const stripe = await getStripe();
      const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${appUrl}/club`,
      });
      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("[vault-club] portal error:", err.message);
      return res.status(500).json({ error: "Failed to open billing portal." });
    }
  });

  // ── GET /api/vault-club/check-discount ────────────────────────────────────
  app.get("/api/vault-club/check-discount", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any).userId as string;
      const rows = await db.execute(sql`
        SELECT vault_club_tier, vault_club_status
        FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
      `);
      if (rows.rows.length === 0) return res.json({ discount_percent: 0, tier: null });

      const user = rows.rows[0] as any;
      const tier = user.vault_club_tier as VaultClubTier | null;
      const status = user.vault_club_status as string | null;

      if (!tier || !isActiveStatus(status)) {
        return res.json({ discount_percent: 0, tier: null });
      }
      return res.json({
        discount_percent: VAULT_CLUB_TIERS[tier].grading_discount_percent,
        tier,
      });
    } catch (err: any) {
      console.error("[vault-club] check-discount error:", err.message);
      return res.status(500).json({ error: "Failed to check discount." });
    }
  });

  // ── POST /api/admin/vault-club/setup-stripe-products ──────────────────────
  // Run once after deploy to create Stripe products. Safe to run multiple times.
  app.post("/api/admin/vault-club/setup-stripe-products", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const stripe = await getStripe();
      const results: Record<string, { product_id: string; month_price_id: string; year_price_id: string }> = {};

      const tierEntries: Array<[VaultClubTier, typeof VAULT_CLUB_TIERS[VaultClubTier]]> = [
        ["bronze", VAULT_CLUB_TIERS.bronze],
        ["silver", VAULT_CLUB_TIERS.silver],
        ["gold", VAULT_CLUB_TIERS.gold],
      ];

      for (const [tierKey, tierDef] of tierEntries) {
        // Check for existing product with this tier metadata
        const existingProducts = await stripe.products.list({ limit: 100 });
        let product = existingProducts.data.find(
          (p) => p.metadata?.mintvault_tier === tierKey
        );

        if (!product) {
          product = await stripe.products.create({
            name: tierDef.label,
            metadata: { mintvault_tier: tierKey },
          });
          console.log(`[vault-club] Created Stripe product: ${product.id} (${tierDef.label})`);
        } else {
          console.log(`[vault-club] Found existing Stripe product: ${product.id} (${tierDef.label})`);
        }

        // Monthly price
        const existingPrices = await stripe.prices.list({ product: product.id, limit: 100 });
        let monthPrice = existingPrices.data.find(
          (p) => p.metadata?.mintvault_interval === "month" && p.active
        );
        if (!monthPrice) {
          monthPrice = await stripe.prices.create({
            product: product.id,
            unit_amount: tierDef.monthly_price_pence,
            currency: "gbp",
            recurring: { interval: "month" },
            metadata: { mintvault_tier: tierKey, mintvault_interval: "month" },
          });
          console.log(`[vault-club]   Monthly price: ${monthPrice.id} (£${tierDef.monthly_price_pence / 100}/mo)`);
        } else {
          console.log(`[vault-club]   Monthly price (existing): ${monthPrice.id}`);
        }

        // Annual price
        let yearPrice = existingPrices.data.find(
          (p) => p.metadata?.mintvault_interval === "year" && p.active
        );
        if (!yearPrice) {
          yearPrice = await stripe.prices.create({
            product: product.id,
            unit_amount: tierDef.annual_price_pence,
            currency: "gbp",
            recurring: { interval: "year" },
            metadata: { mintvault_tier: tierKey, mintvault_interval: "year" },
          });
          console.log(`[vault-club]   Annual price: ${yearPrice.id} (£${tierDef.annual_price_pence / 100}/yr)`);
        } else {
          console.log(`[vault-club]   Annual price (existing): ${yearPrice.id}`);
        }

        results[tierKey] = {
          product_id: product.id,
          month_price_id: monthPrice.id,
          year_price_id: yearPrice.id,
        };
      }

      // Print to console in copy-paste format for vault-club-config.ts
      console.log("\n[vault-club] ===== COPY THESE PRICE IDs INTO server/vault-club-config.ts =====");
      console.log("export const VAULT_CLUB_PRICE_IDS = {");
      for (const [k, v] of Object.entries(results)) {
        console.log(`  ${k}: { month: "${v.month_price_id}", year: "${v.year_price_id}" },`);
      }
      console.log("};");
      console.log("[vault-club] =============================================================\n");

      return res.json({ success: true, products: results });
    } catch (err: any) {
      console.error("[vault-club] setup-stripe-products error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}

// ── Exported helpers used by webhookHandlers.ts ────────────────────────────────

/** Find a user row by their stripe_customer_id */
export async function findUserByStripeCustomerId(customerId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(sql`
    SELECT id, email, display_name, vault_club_tier, vault_club_status,
           ai_credits_user_balance, username, showroom_active,
           vault_club_billing_interval, ai_credits_last_refilled_at,
           member_credits_last_granted_at
    FROM users WHERE stripe_customer_id = ${customerId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) || null;
}

/** Grant quarterly member credits for the given tier at signup/renewal */
export async function grantMemberCredits(userId: string, tier: VaultClubTier, source: string): Promise<void> {
  const qty = VAULT_CLUB_TIERS[tier].quarterly_reholders;
  if (qty <= 0) return;
  const expiresAt = endOfCurrentQuarter();
  // Check if we already granted credits for this quarter+source
  const existing = await db.execute(sql`
    SELECT id FROM member_credits
    WHERE user_id = ${userId} AND source = ${source}
      AND granted_at >= (NOW() - INTERVAL '92 days')
    LIMIT 1
  `);
  if (existing.rows.length > 0) return; // already granted
  for (let i = 0; i < qty; i++) {
    await db.execute(sql`
      INSERT INTO member_credits (user_id, expires_at, source)
      VALUES (${userId}, ${expiresAt.toISOString()}, ${source})
    `);
  }
}

/** Insert a vault_club_events audit row (idempotent via stripe_event_id UNIQUE) */
export async function insertVaultClubEvent(params: {
  userId: string;
  stripeEventId: string;
  eventType: string;
  tier?: string | null;
  status?: string | null;
  amountPence?: number | null;
  rawPayload?: unknown;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO vault_club_events
        (user_id, stripe_event_id, event_type, tier, status, amount_pence, raw_payload)
      VALUES
        (${params.userId}, ${params.stripeEventId}, ${params.eventType},
         ${params.tier ?? null}, ${params.status ?? null},
         ${params.amountPence ?? null},
         ${params.rawPayload ? JSON.stringify(params.rawPayload) : null}::jsonb)
      ON CONFLICT (stripe_event_id) DO NOTHING
    `);
  } catch { /* non-critical */ }
}
