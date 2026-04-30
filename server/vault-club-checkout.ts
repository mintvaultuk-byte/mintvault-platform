/**
 * server/vault-club-checkout.ts
 *
 * Phase 1 Step 2 of the Vault Club Stripe Subscriptions build.
 *
 * Creates a Stripe Checkout Session for Silver Vault Club (monthly or annual),
 * with a 14-day trial and card-required-up-front. Returns the hosted URL the
 * frontend redirects to.
 *
 * State this handler creates:
 *   - Stripe Customer (idempotent — re-uses users.stripe_customer_id if set)
 *   - Stripe Checkout Session (mode: "subscription")
 *   - audit_log row (action: "checkout_session_created", entity_id: userId)
 *
 * State this handler does NOT create:
 *   - vault_club_subscriptions row — the Step 3 webhook handler creates that
 *     when `customer.subscription.created` fires after the customer pays / is
 *     placed on trial. This handler only kicks off the Checkout flow.
 *
 * Authorization: assumes requireAuth has run (req.session.userId set).
 *
 * Stripe key selection: routes through stripeClient.ts, which switches
 * between STRIPE_SECRET_KEY (prod) and STRIPE_SECRET_KEY_TEST (dev) based
 * on NODE_ENV.
 */

import type { Request, Response } from "express";
import Stripe from "stripe";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { getStripeSecretKey } from "./stripeClient";
import { getPriceId, type VaultClubInterval } from "./vault-club-config";
import { writeVaultClubSubscriptionAudit } from "./vault-club-audit";
import { APP_BASE_URL } from "./app-url";

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  stripe_customer_id: string | null;
}

async function getUser(userId: string): Promise<UserRow | null> {
  const rows = await db.execute(sql`
    SELECT id, email, display_name, stripe_customer_id
    FROM users
    WHERE id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `);
  return (rows.rows[0] as unknown as UserRow) || null;
}

async function setStripeCustomerId(userId: string, customerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${userId}
  `);
}

async function getOrCreateCustomer(stripe: Stripe, user: UserRow): Promise<string> {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.display_name || undefined,
    metadata: { mintvault_user_id: user.id },
  });
  await setStripeCustomerId(user.id, customer.id);
  return customer.id;
}

function isValidInterval(v: unknown): v is VaultClubInterval {
  return v === "month" || v === "year";
}

export async function handleVaultClubCheckout(req: Request, res: Response): Promise<Response> {
  try {
    const userId = req.session?.userId as string | undefined;
    if (!userId) {
      return res.status(401).json({ error: "auth_required" });
    }

    const interval = req.body?.interval;
    if (!isValidInterval(interval)) {
      return res.status(400).json({
        error: "invalid_interval",
        message: "interval must be 'month' or 'year'",
      });
    }

    const user = await getUser(userId);
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }

    const priceId = getPriceId("silver", interval);
    const secretKey = await getStripeSecretKey();
    const stripe = new Stripe(secretKey, { apiVersion: "2025-08-27.basil" as any });

    const customerId = await getOrCreateCustomer(stripe, user);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: {
          mintvault_user_id: user.id,
          mintvault_tier: "silver",
          mintvault_interval: interval,
        },
      },
      payment_method_collection: "always",
      billing_address_collection: "required",
      allow_promotion_codes: true,
      success_url: `${APP_BASE_URL}/account/vault-club?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/vault-club?checkout=cancel`,
      metadata: {
        mintvault_user_id: user.id,
        mintvault_tier: "silver",
        mintvault_interval: interval,
      },
    });

    await writeVaultClubSubscriptionAudit(
      user.id,
      "checkout_session_created",
      "system",
      {
        stripe_checkout_session_id: session.id,
        stripe_customer_id: customerId,
        stripe_price_id: priceId,
        interval,
        mode: process.env.NODE_ENV === "production" ? "live" : "test",
      }
    );

    if (!session.url) {
      console.error("[vault-club-checkout] Stripe returned a session with no URL", {
        userId,
        sessionId: session.id,
      });
      return res.status(502).json({ error: "stripe_no_url" });
    }

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error("[vault-club-checkout] error:", err?.message, err?.type);
    return res.status(500).json({
      error: "checkout_failed",
      message: "Could not start checkout. Please try again or contact support@mintvaultuk.com.",
    });
  }
}
