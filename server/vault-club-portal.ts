/**
 * server/vault-club-portal.ts
 *
 * Phase 1 Step 4 of the Vault Club Stripe Subscriptions build.
 *
 * Creates a Stripe Billing Portal session for the current user and returns
 * its URL. The frontend then redirects window.location to it.
 *
 * The Customer Portal is where DMCC 2024 compliance lives — it gives users
 * one-click cancel, plan switching, payment method updates, and invoice
 * history without us building any of that ourselves. The Stripe-hosted page
 * is mandatory: we do NOT implement cancel-via-our-API.
 *
 * ⚠️  Stripe Customer Portal MUST be configured in the Stripe dashboard
 *     before redirects work — Settings → Billing → Customer Portal. Without
 *     it, billingPortal.sessions.create() throws "No configuration provided".
 *
 * Authorization: assumes requireAuth has run (req.session.userId set).
 *
 * Stripe key selection: routes through stripeClient.ts NODE_ENV switch.
 */

import type { Request, Response } from "express";
import Stripe from "stripe";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { getStripeSecretKey } from "./stripeClient";
import { getRedirectBaseUrl } from "./app-url";

interface UserRow {
  id: string;
  stripe_customer_id: string | null;
}

async function getUser(userId: string): Promise<UserRow | null> {
  const rows = await db.execute(sql`
    SELECT id, stripe_customer_id
    FROM users
    WHERE id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `);
  return (rows.rows[0] as unknown as UserRow) || null;
}

export async function handleVaultClubPortal(req: Request, res: Response): Promise<Response> {
  try {
    const userId = req.session?.userId as string | undefined;
    if (!userId) {
      return res.status(401).json({ error: "auth_required" });
    }

    const user = await getUser(userId);
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }
    if (!user.stripe_customer_id) {
      // No Stripe Customer means the user never started a subscription —
      // there's nothing for the portal to manage. 404 is the right shape;
      // the frontend can redirect them to /vault-club to subscribe instead.
      return res.status(404).json({
        error: "no_subscription",
        message: "No subscription found. Visit /vault-club to join.",
      });
    }

    const secretKey = await getStripeSecretKey();
    const stripe = new Stripe(secretKey, { apiVersion: "2025-08-27.basil" as any });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${getRedirectBaseUrl()}/account/vault-club`,
    });

    if (!session.url) {
      console.error("[vault-club-portal] Stripe returned a session with no URL", {
        userId,
        sessionId: session.id,
      });
      return res.status(502).json({ error: "stripe_no_url" });
    }

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error("[vault-club-portal] error:", err?.message, err?.type);
    // Stripe surfaces "No configuration provided" when the Customer Portal
    // isn't yet set up in the dashboard. Surface a helpful message.
    if (err?.message?.includes("configuration")) {
      return res.status(503).json({
        error: "portal_not_configured",
        message: "Billing portal is being configured. Please contact support@mintvaultuk.com.",
      });
    }
    return res.status(500).json({
      error: "portal_failed",
      message: "Could not open billing portal. Please try again or contact support@mintvaultuk.com.",
    });
  }
}
