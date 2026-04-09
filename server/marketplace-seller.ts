/**
 * server/marketplace-seller.ts
 *
 * Stripe Connect Express seller onboarding routes.
 * Registered via registerSellerRoutes() in server/routes.ts.
 */

import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { auditLog } from "@shared/schema";
import { requireAuth } from "./middleware/auth";
import { getUncachableStripeClient } from "./stripeClient";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getSellerUser(userId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(sql`
    SELECT id, email, display_name,
           stripe_connect_account_id, seller_status,
           seller_payouts_enabled, seller_charges_enabled,
           seller_kyc_completed_at, seller_kyc_requirements_json
    FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) || null;
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerSellerRoutes(app: Express): void {

  // ── POST /api/seller/onboard ──────────────────────────────────────────────
  app.post("/api/seller/onboard", requireAuth, async (req: Request, res: Response) => {
    const sessionUserId = (req.session as any).userId as string;

    try {
      const user = await getSellerUser(sessionUserId);
      if (!user) return res.status(404).json({ error: "User not found." });

      // Already fully onboarded
      if (user.seller_status === "active" && user.stripe_connect_account_id) {
        return res.json({ alreadyOnboarded: true });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";
      let accountId = user.stripe_connect_account_id as string | null;

      // Create Connect Express account if not yet created
      if (!accountId) {
        // Try to acquire the onboarding lock. Only one request can win.
        // Lock auto-expires after 60 seconds to handle crashes mid-Stripe-call.
        const lockResult = await db.execute(sql`
          UPDATE users
             SET seller_onboarding_lock_at = NOW(),
                 updated_at = NOW()
           WHERE id = ${sessionUserId}
             AND stripe_connect_account_id IS NULL
             AND (seller_onboarding_lock_at IS NULL OR seller_onboarding_lock_at < NOW() - INTERVAL '60 seconds')
          RETURNING id
        `);

        if (lockResult.rows.length === 0) {
          // Another request is already creating an account, OR an account already exists
          const refreshed = await getSellerUser(sessionUserId);
          if (refreshed?.stripe_connect_account_id) {
            // Account was created by concurrent request — fall through to link generation
            accountId = refreshed.stripe_connect_account_id as string;
          } else {
            return res.status(409).json({
              error: "onboarding_in_progress",
              message: "Seller onboarding is already in progress. Please wait a moment and try again.",
            });
          }
        }

        // Only create the Stripe account if we won the lock and no account exists yet
        if (!accountId) {
          let account;
          try {
            account = await stripe.accounts.create({
              type: "express",
              country: "GB",
              email: user.email as string,
              default_currency: "gbp",
              capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
              },
              business_type: "individual",
              business_profile: {
                mcc: "5945",
                product_description: "Graded trading cards authenticated by MintVault",
                url: appUrl,
              },
              settings: {
                payouts: {
                  schedule: { interval: "daily", delay_days: 7 },
                },
              },
              metadata: {
                mintvault_user_id: sessionUserId,
                mintvault_purpose: "marketplace_seller",
              },
            });
          } catch (stripeErr) {
            // Clear lock so user can retry
            await db.execute(sql`
              UPDATE users SET seller_onboarding_lock_at = NULL WHERE id = ${sessionUserId}
            `);
            throw stripeErr;
          }

          accountId = account.id;

          await db.execute(sql`
            UPDATE users
            SET stripe_connect_account_id = ${accountId},
                seller_status = 'pending',
                seller_onboarded_at = COALESCE(seller_onboarded_at, NOW()),
                seller_onboarding_lock_at = NULL,
                updated_at = NOW()
            WHERE id = ${sessionUserId}
          `);
        }
      }

      // Generate a fresh onboarding link (always single-use)
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${appUrl}/seller/onboard?refresh=1`,
        return_url: `${appUrl}/seller?onboarded=1`,
        type: "account_onboarding",
      });

      // Audit trail
      await db.insert(auditLog).values({
        entityType: "user",
        entityId: sessionUserId,
        action: "marketplace.seller_onboarding_started",
        adminUser: null,
        details: { stripe_connect_account_id: accountId },
      });

      return res.json({ url: accountLink.url, accountId });
    } catch (err: any) {
      console.error("[marketplace-seller] onboard error:", err.message);
      if (err.type === "StripeError" || err.raw) {
        return res.status(500).json({ error: "stripe_error", message: err.message });
      }
      return res.status(500).json({ error: "database_error", message: "Failed to start seller onboarding." });
    }
  });

  // ── GET /api/seller/status ────────────────────────────────────────────────
  app.get("/api/seller/status", requireAuth, async (req: Request, res: Response) => {
    const sessionUserId = (req.session as any).userId as string;

    try {
      const user = await getSellerUser(sessionUserId);
      if (!user) return res.status(404).json({ error: "User not found." });

      const accountId = user.stripe_connect_account_id as string | null;
      if (!accountId) {
        return res.json({ hasAccount: false, status: "none" });
      }

      return res.json({
        hasAccount: true,
        accountId,
        status: user.seller_status || "pending",
        payoutsEnabled: user.seller_payouts_enabled ?? false,
        chargesEnabled: user.seller_charges_enabled ?? false,
        kycCompletedAt: user.seller_kyc_completed_at || null,
        requirements: user.seller_kyc_requirements_json || null,
      });
    } catch (err: any) {
      console.error("[marketplace-seller] status error:", err.message);
      return res.status(500).json({ error: "Failed to load seller status." });
    }
  });

  // ── POST /api/seller/refresh-onboarding-link ──────────────────────────────
  app.post("/api/seller/refresh-onboarding-link", requireAuth, async (req: Request, res: Response) => {
    const sessionUserId = (req.session as any).userId as string;

    try {
      const user = await getSellerUser(sessionUserId);
      if (!user) return res.status(404).json({ error: "User not found." });

      const accountId = user.stripe_connect_account_id as string | null;
      if (!accountId) {
        return res.status(400).json({ error: "no_account", message: "Start onboarding first." });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";

      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${appUrl}/seller/onboard?refresh=1`,
        return_url: `${appUrl}/seller?onboarded=1`,
        type: "account_onboarding",
      });

      return res.json({ url: accountLink.url });
    } catch (err: any) {
      console.error("[marketplace-seller] refresh-link error:", err.message);
      return res.status(500).json({ error: "stripe_error", message: err.message });
    }
  });
}
