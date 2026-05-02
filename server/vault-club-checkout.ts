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
import { getRedirectBaseUrl } from "./app-url";
import { TERMS_VERSION } from "./config/legal";
import { VAULT_CLUB_CONSENT_TEXT_HASH } from "./config/consents";
import {
  attachConsentToStripeRefs,
  recordConsent,
} from "./vault-club-consents";

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

    // ── DMCC explicit-consent gate (Step 5d) ──────────────────────────────
    // The frontend must send consent_accepted: true AND the hash of the
    // consent text it actually rendered. The hash check catches the deploy
    // race where /vault-club was rendered just before a TERMS_VERSION bump:
    // the user is shown stale text, ticks the box, server has new text,
    // request rejects. User has to refresh and re-read.
    const consentAccepted = req.body?.consent_accepted;
    const consentTextHash = req.body?.consent_text_hash;
    if (consentAccepted !== true) {
      return res.status(400).json({
        error: "consent_required",
        message:
          "You must agree to the Vault Club Terms and Privacy Notice before subscribing.",
      });
    }
    if (typeof consentTextHash !== "string" || consentTextHash !== VAULT_CLUB_CONSENT_TEXT_HASH) {
      return res.status(400).json({
        error: "consent_text_stale",
        message:
          "Our terms have been updated. Please refresh the page and review before subscribing.",
      });
    }

    const user = await getUser(userId);
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }

    // ── Layer 1 — DB-side duplicate-subscription guard ─────────────────────
    // Reading from vault_club_subscriptions (the canonical Step 3 store).
    // Statuses considered "live" mirror the set the Step 3 webhook handlers
    // upsert as. cancel_at_period_end=true is treated as "winding down" —
    // we let the user re-checkout to start a new sub before the old lapses.
    const existing = await db.execute(sql`
      SELECT status, cancel_at_period_end, stripe_subscription_id
      FROM vault_club_subscriptions
      WHERE user_id = ${user.id}
        AND status IN ('trialing', 'active', 'past_due', 'incomplete')
      LIMIT 1
    `);
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as {
        status: string;
        cancel_at_period_end: boolean;
        stripe_subscription_id: string;
      };
      if (!row.cancel_at_period_end) {
        await writeVaultClubSubscriptionAudit(
          user.id,
          "checkout_blocked_already_active",
          "system",
          {
            layer: 1,
            existing_subscription_id: row.stripe_subscription_id,
            existing_status: row.status,
            attempted_interval: interval,
          },
        );
        return res.status(409).json({
          error: "already_subscribed",
          message: "You already have an active Vault Club membership.",
          account_url: "/account/vault-club",
        });
      }
    }

    const priceId = getPriceId("silver", interval);
    const secretKey = await getStripeSecretKey();
    const stripe = new Stripe(secretKey, { apiVersion: "2025-08-27.basil" as any });

    const customerId = await getOrCreateCustomer(stripe, user);

    // ── Layer 2 — Stripe-side belt-and-braces guard ────────────────────────
    // Catches the case where Stripe has a live sub our DB missed (most
    // commonly: a customer.subscription.created webhook the dual-write
    // handler never successfully processed). Layer 1 → Layer 2 catch is
    // logged at warn level — that's a real signal worth noticing in prod.
    const stripeSubs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });
    const activeStripeSubs = stripeSubs.data.filter((s) =>
      ["trialing", "active", "past_due", "incomplete"].includes(s.status) &&
      !s.cancel_at_period_end
    );
    if (activeStripeSubs.length > 0) {
      const blockingSub = activeStripeSubs[0];
      console.warn(
        `[vault-club-checkout] Layer 2 caught a sub Layer 1 missed — webhook drop? user=${user.id} stripe_sub=${blockingSub.id} status=${blockingSub.status}`
      );
      await writeVaultClubSubscriptionAudit(
        user.id,
        "checkout_blocked_already_active",
        "system",
        {
          layer: 2,
          existing_subscription_id: blockingSub.id,
          existing_status: blockingSub.status,
          attempted_interval: interval,
          stripe_customer_id: customerId,
          note: "Stripe-side guard caught a sub our DB did not have — likely a missed customer.subscription.created webhook delivery",
        },
      );
      return res.status(409).json({
        error: "already_subscribed",
        message: "You already have an active Vault Club membership.",
        account_url: "/account/vault-club",
      });
    }

    // ── DMCC consent recorded BEFORE the Checkout Session is created ──────
    // Order matters: by the time we hit Stripe's API, the consent record
    // exists with a captured_at timestamp. If Stripe fails after this
    // INSERT, we have a consent row with no Stripe refs — that's fine,
    // attachConsentToStripeRefs is a separate UPDATE call that runs only
    // on the success path. A consent without Stripe refs is a "user agreed
    // but Stripe error" record, which is actually the regulator-friendly
    // shape (we can show the user agreed even though the charge never
    // started).
    const ipAddress =
      (req.ip ?? req.socket.remoteAddress ?? null) || null;
    const userAgentHeader = req.get("user-agent");
    const userAgent =
      typeof userAgentHeader === "string" ? userAgentHeader.slice(0, 500) : null;
    const consent = await recordConsent({
      userId: user.id,
      termsVersion: TERMS_VERSION,
      consentTextHash: VAULT_CLUB_CONSENT_TEXT_HASH,
      interval,
      ipAddress,
      userAgent,
    });

    // Metadata keys (user_id / tier / interval) match what the existing
    // WebhookHandlers dispatcher reads — see server/webhookHandlers.ts.
    // Both Checkout Session metadata AND subscription_data.metadata are set;
    // checkout.session.completed reads from session.metadata, but
    // customer.subscription.* events only see subscription.metadata, so the
    // tier+interval need to live on both.
    //
    // Stripe Customer metadata also gets vault_club_consent_id +
    // vault_club_terms_version — these give the Stripe dashboard a
    // back-reference to the consent ledger row for any audit / dispute.
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: {
          user_id: user.id,
          tier: "silver",
          interval,
          vault_club_consent_id: consent.id,
          vault_club_terms_version: TERMS_VERSION,
        },
      },
      payment_method_collection: "always",
      billing_address_collection: "required",
      allow_promotion_codes: true,
      success_url: `${getRedirectBaseUrl()}/account/vault-club?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getRedirectBaseUrl()}/vault-club?checkout=cancel`,
      metadata: {
        user_id: user.id,
        tier: "silver",
        interval,
        vault_club_consent_id: consent.id,
        vault_club_terms_version: TERMS_VERSION,
      },
    });

    // Attach the Stripe ids to the consent ledger row. Idempotent via
    // COALESCE — if this fails for any reason, the consent row stays
    // intact and the bridge is best-effort.
    await attachConsentToStripeRefs(consent.id, {
      stripeCustomerId: customerId,
      stripeSessionId: session.id,
    }).catch((e: any) =>
      console.error(
        `[vault-club-checkout] failed to attach Stripe refs to consent ${consent.id}:`,
        e?.message,
      ),
    );

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
        vault_club_consent_id: consent.id,
        vault_club_terms_version: TERMS_VERSION,
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
