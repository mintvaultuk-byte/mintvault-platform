import Stripe from "stripe";
import { getStripeSecretKey } from "./stripeClient";
import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { VAULT_CLUB_TIERS, type VaultClubTier, isActiveStatus, quarterKey } from "./vault-club-tiers";
import { findUserByStripeCustomerId, insertVaultClubEvent, grantMemberCredits } from "./vault-club";
import { writeAuthAudit } from "./account-auth";
import { auditLog } from "@shared/schema";
import { fulfilPaidSubmission } from "./routes/submissions";
import { sendVaultClubWelcomeEmail, sendVaultClubCancelledEmail, sendVaultClubPaymentFailedEmail } from "./email";

/**
 * Boot migration for payment idempotency. Idempotent + additive — safe to run
 * on every boot.
 *  - stripe_webhook_events: a generic processed-event ledger so a replayed
 *    Stripe event id becomes a no-op (belt-and-suspenders behind the atomic
 *    paid-transition gate inside fulfilPaidSubmission).
 *  - uq_member_credits_used_for_submission: a partial UNIQUE index guaranteeing
 *    a single submission can never consume more than one Vault Club credit. It
 *    is wrapped in its own try/catch with a LOUD log: if a legacy duplicate
 *    already exists the index build fails HERE (never silently) without
 *    blocking boot, so the data issue is surfaced rather than swallowed.
 */
export async function migratePaymentIdempotencySchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      event_type TEXT,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_member_credits_used_for_submission
        ON member_credits (used_for_submission_id)
        WHERE used_for_submission_id IS NOT NULL
    `);
    console.log("[payment-idempotency-migrate] stripe_webhook_events + uq_member_credits_used_for_submission ensured");
  } catch (e: any) {
    console.error(
      "[payment-idempotency-migrate] ⚠️ uq_member_credits_used_for_submission FAILED — " +
        "likely a pre-existing duplicate used_for_submission_id. Resolve manually; boot continues.",
      e?.message || e
    );
  }
}

/**
 * Atomically claim a Stripe event id for processing. Returns true the FIRST time
 * an id is seen (caller should process), false if it was already recorded
 * (caller should skip). The INSERT ... ON CONFLICT DO NOTHING makes the claim
 * race-safe across concurrent webhook deliveries.
 */
async function claimStripeEvent(eventId: string, eventType: string): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
    VALUES (${eventId}, ${eventType})
    ON CONFLICT (stripe_event_id) DO NOTHING
    RETURNING stripe_event_id
  `);
  return res.rows.length > 0;
}

/** Transaction-capable executor. Production passes the real `db`; tests inject a
 *  drizzle instance over a disposable PostgreSQL cluster so the atomic claim+grant
 *  is exercised against real Postgres, not simulated. Changes NO runtime behaviour. */
type TxRunner = Pick<typeof db, "transaction">;

/** Minimal shape of the Stripe Checkout Session fields fulfilment reads. */
interface EstimateCheckoutSession {
  id?: string;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * PKG-2 — idempotent, atomic fulfilment of an estimate-credits Checkout purchase.
 *
 * The prior inline handler granted credits with NO event-idempotency guard, so a
 * Stripe redelivery (at-least-once; also dual-endpoint during a DNS cutover)
 * re-ran `credits_remaining + credits` and granted the SAME purchase repeatedly.
 * It also swallowed errors and returned 200, so a transient DB failure silently
 * lost a paying customer's credits (Stripe never retried).
 *
 * This performs the event-id CLAIM and the credit GRANT inside ONE transaction,
 * reusing the SAME `stripe_webhook_events` ledger the grading flow uses:
 *  - replayed / redelivered event  → the claim conflicts (0 rows) → grant skipped
 *    (exactly-once credit, even under concurrent deliveries of the same event).
 *  - transient failure mid-grant   → the whole transaction rolls back, releasing
 *    the claim, so a later Stripe retry safely re-fulfils. No claim-then-crash
 *    credit loss.
 *
 * Amount and owner are NOT taken from raw browser input: `credits` is fixed
 * server-side at checkout from ESTIMATE_PACKAGES and carried in Stripe metadata
 * (which only our server can set); the browser only ever chose a validated
 * package key and its own email.
 *
 * Returns { granted, reason } and NEVER throws for a permanent condition
 * (not-paid / malformed metadata / duplicate) — the caller returns 200 and Stripe
 * stops. It DOES throw for a transient DB error so the caller returns non-2xx and
 * Stripe retries onto the now-safe (rolled-back) state.
 */
export async function fulfilEstimateCreditsPurchase(
  eventId: string,
  eventType: string,
  session: EstimateCheckoutSession,
  deps: { exec?: TxRunner } = {}
): Promise<{ granted: boolean; reason?: string }> {
  const runner = deps.exec ?? db;
  const meta = session.metadata || {};

  // Only fulfil a genuinely paid session. checkout.session.completed can fire for
  // delayed/async payment methods before funds settle — fail closed on anything
  // that is not explicitly "paid".
  if (session.payment_status && session.payment_status !== "paid") {
    console.log(
      `[webhook] estimate_credits session ${session.id} payment_status=${session.payment_status} — not fulfilling`
    );
    return { granted: false, reason: "not_paid" };
  }

  const email = (meta.email || "").trim().toLowerCase();
  const userId = (meta.user_id || "").trim();
  const credits = parseInt(meta.credits || "0", 10);

  // Malformed / incomplete metadata → nothing safe to fulfil. Permanent condition,
  // so do NOT throw (a retry can't help); surface loudly for reconciliation.
  if ((!email && !userId) || !Number.isInteger(credits) || credits <= 0) {
    console.error(
      `[webhook] estimate_credits malformed metadata (email/user_id/credits) event=${eventId} session=${session.id} — skipping`
    );
    return { granted: false, reason: "malformed_metadata" };
  }

  return runner.transaction(async (tx) => {
    const claim = await tx.execute(sql`
      INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
      VALUES (${eventId}, ${eventType})
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id
    `);
    if (claim.rows.length === 0) {
      console.log(`[webhook] estimate_credits event ${eventId} already processed — skipping`);
      return { granted: false, reason: "duplicate_event" };
    }

    if (userId) {
      // Logged-in purchase — credit the account balance directly.
      await tx.execute(sql`
        UPDATE users SET ai_credits_user_balance = ai_credits_user_balance + ${credits} WHERE id = ${userId}
      `);
    } else {
      // Anonymous / email purchase.
      await tx.execute(sql`
        INSERT INTO estimate_credits (email, credits_remaining, credits_purchased, credits_used)
        VALUES (${email}, ${credits}, ${credits}, 0)
        ON CONFLICT (email) DO UPDATE SET
          credits_remaining = estimate_credits.credits_remaining + ${credits},
          credits_purchased = estimate_credits.credits_purchased + ${credits},
          updated_at = NOW()
      `);
    }
    console.log(`[webhook] estimate_credits: +${credits} for ${userId || email} (event ${eventId})`);
    return { granted: true };
  });
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Ensure webhook route is registered BEFORE app.use(express.json())."
      );
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const webhookSecret2 = process.env.STRIPE_WEBHOOK_SECRET_2;
    if (!webhookSecret) {
      throw new Error("STRIPE_WEBHOOK_SECRET env var is not set");
    }

    const secretKey = await getStripeSecretKey();
    const stripe = new Stripe(secretKey, { apiVersion: "2025-08-27.basil" as any });

    // Try primary secret first, then secondary (used when two Stripe webhook
    // endpoints are active simultaneously — e.g. during DNS cutover when both
    // mintvault.fly.dev and mintvaultuk.com endpoints are registered).
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (primaryErr: any) {
      if (webhookSecret2) {
        event = stripe.webhooks.constructEvent(payload, signature, webhookSecret2);
      } else {
        throw primaryErr;
      }
    }

    // ── Existing grading payment flow ──────────────────────────────────────────

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      console.log(`[webhook] payment_intent.succeeded for PI ${pi.id}`);

      const submission = await storage.getSubmissionByPaymentIntentId(pi.id);
      if (!submission) {
        console.log(`[webhook] No submission found for PI ${pi.id} — ignoring`);
        return;
      }

      // Belt-and-suspenders event dedup. The atomic paid-transition gate inside
      // fulfilPaidSubmission is the real guard; this just avoids reprocessing a
      // replayed Stripe event id at all (e.g. Stripe re-delivering on timeout).
      const fresh = await claimStripeEvent(event.id, event.type);
      if (!fresh) {
        console.log(`[webhook] event ${event.id} (${event.type}) already processed — skipping`);
        return;
      }

      // SHARED idempotent fulfilment — the SAME function /api/confirm-payment
      // calls. Whoever wins the atomic paid transition runs the once-only
      // side-effects (mark paid, consume credit, redeem promo, link user,
      // email); the other caller is a logged no-op. This closes the inverse gap
      // where a webhook-only completion previously never consumed the credit or
      // redeemed the promo code.
      await fulfilPaidSubmission(submission, pi.metadata || {}, pi.amount || 0);
      console.log(`[webhook] Submission ${submission.submissionId} fulfilment dispatched (paymentStatus=paid)`);
    }

    // ── Existing estimate credits checkout ─────────────────────────────────────

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata || {};

      // Vault Club subscription checkout
      if (session.mode === "subscription" && meta.user_id) {
        await WebhookHandlers.handleSubscriptionCheckoutCompleted(event.id, session, stripe);
        return;
      }

      // Estimate credits checkout — idempotent, atomic fulfilment (PKG-2).
      // A thrown (transient DB) error propagates to the route, which returns a
      // non-2xx so Stripe retries onto the safely rolled-back state; a permanent
      // condition (duplicate / not-paid / malformed) returns without throwing.
      if (meta.type === "estimate_credits") {
        await fulfilEstimateCreditsPurchase(event.id, event.type, session);
      }
    }

    // ── Vault Club subscription events ────────────────────────────────────────

    if (event.type === "customer.subscription.updated") {
      await WebhookHandlers.handleSubscriptionUpdated(event.id, event.data.object as Stripe.Subscription);
    }

    if (event.type === "customer.subscription.deleted") {
      await WebhookHandlers.handleSubscriptionDeleted(event.id, event.data.object as Stripe.Subscription);
    }

    if (event.type === "invoice.payment_succeeded") {
      await WebhookHandlers.handleInvoicePaymentSucceeded(event.id, event.data.object as Stripe.Invoice);
    }

    if (event.type === "invoice.payment_failed") {
      await WebhookHandlers.handleInvoicePaymentFailed(event.id, event.data.object as Stripe.Invoice);
    }

    // ── Stripe Connect marketplace events ────────────────────────────────────

    if (event.type === "account.updated") {
      // Connect account event — only handle if we recognise it as ours
      const account = event.data.object as Stripe.Account;
      if (account.metadata?.mintvault_purpose === "marketplace_seller") {
        await WebhookHandlers.handleConnectAccountUpdated(event, stripe);
      }
    }

    if (event.type === "account.application.deauthorized") {
      await WebhookHandlers.handleConnectAccountDeauthorized(event);
    }

    if (event.type === "capability.updated") {
      // Log only for now — the account.updated handler will capture the derived state
      console.log("[webhook] capability.updated for account:", event.account);
    }
  }

  // ── Subscription checkout completed ───────────────────────────────────────

  private static async handleSubscriptionCheckoutCompleted(
    eventId: string,
    session: Stripe.Checkout.Session,
    stripe: Stripe
  ): Promise<void> {
    const meta = session.metadata || {};
    const userId = meta.user_id;
    const tier = meta.tier as VaultClubTier;
    const interval = meta.interval;

    if (!userId || !tier || !(tier in VAULT_CLUB_TIERS)) {
      console.warn("[webhook] subscription checkout missing metadata:", meta);
      return;
    }

    const subscriptionId = session.subscription as string | null;
    let sub: Stripe.Subscription | null = null;
    if (subscriptionId) {
      sub = await stripe.subscriptions.retrieve(subscriptionId);
    }

    const isTrialing = sub?.status === "trialing";
    const status = isTrialing ? "trialing" : "active";
    const renewsAt = (sub as any)?.current_period_end
      ? new Date((sub as any).current_period_end * 1000).toISOString()
      : null;

    await db.execute(sql`
      UPDATE users SET
        stripe_customer_id   = ${session.customer as string},
        stripe_subscription_id = ${subscriptionId},
        vault_club_tier      = ${tier},
        vault_club_status    = ${status},
        vault_club_started_at = COALESCE(vault_club_started_at, NOW()),
        vault_club_renews_at = ${renewsAt},
        vault_club_billing_interval = ${interval},
        vault_club_cancels_at = NULL,
        vault_club_grace_until = NULL,
        showroom_active      = CASE WHEN username IS NOT NULL THEN true ELSE false END,
        ai_credits_user_balance = ${VAULT_CLUB_TIERS[tier].ai_credits_monthly},
        ai_credits_last_refilled_at = NOW(),
        updated_at           = NOW()
      WHERE id = ${userId}
    `);

    // Grant reholder credits for silver/gold
    const source = `${tier}_quarterly`;
    await grantMemberCredits(userId, tier, source).catch(() => {});
    await db.execute(sql`
      UPDATE users SET member_credits_last_granted_at = NOW() WHERE id = ${userId}
    `);

    await insertVaultClubEvent({
      userId,
      stripeEventId: eventId,
      eventType: "subscription.created",
      tier,
      status,
    });

    // Fetch user for email + username (username determines whether showroom_active flipped on)
    const userRows = await db.execute(
      sql`SELECT email, display_name, username FROM users WHERE id = ${userId} LIMIT 1`
    );
    const user = userRows.rows[0] as any;
    if (user?.email) {
      // Payment already succeeded (Stripe webhook) — a failed welcome email
      // must never fail this handler, but a bare catch left the operator with
      // zero visibility that a paying customer never got it. Audit it instead.
      sendVaultClubWelcomeEmail({
        email: user.email,
        displayName: user.display_name || null,
        tier,
      }).catch((e: any) =>
        writeAuthAudit("vault_club.welcome_email_failed", userId, "webhook", { tier, error: e?.message })
      );
    }

    await writeAuthAudit("vault_club.subscribed", userId, "webhook", { tier, status });
    if (user?.username) {
      await writeAuthAudit("showroom.activated", userId, "stripe-webhook", { tier, subscriptionId });
    }
    console.log(`[webhook] Vault Club subscribed: user=${userId} tier=${tier} status=${status}`);
  }

  // ── Subscription updated ───────────────────────────────────────────────────

  private static async handleSubscriptionUpdated(eventId: string, sub: Stripe.Subscription): Promise<void> {
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const user = await findUserByStripeCustomerId(customerId);
    if (!user) {
      console.warn(`[webhook] subscription.updated: no user for customer ${customerId}`);
      return;
    }
    const userId = user.id as string;

    // Extract tier from subscription price metadata
    const priceItem = sub.items?.data?.[0];
    const tierFromMeta = priceItem?.price?.metadata?.mintvault_tier as VaultClubTier | undefined;
    const tier =
      tierFromMeta && tierFromMeta in VAULT_CLUB_TIERS ? tierFromMeta : (user.vault_club_tier as VaultClubTier | null);

    const status = sub.status;
    const renewsAt = (sub as any).current_period_end
      ? new Date((sub as any).current_period_end * 1000).toISOString()
      : null;
    const cancelsAt = sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null;

    // If tier changed, refresh AI credits to new tier amount
    const previousTier = user.vault_club_tier as VaultClubTier | null;
    const tierChanged = tier && previousTier && tier !== previousTier;
    const newCredits = tier && tierChanged ? VAULT_CLUB_TIERS[tier].ai_credits_monthly : null;

    await db.execute(sql`
      UPDATE users SET
        vault_club_tier      = ${tier ?? null},
        vault_club_status    = ${status},
        vault_club_renews_at = ${renewsAt},
        vault_club_cancels_at = ${cancelsAt},
        vault_club_grace_until = NULL,
        ${newCredits !== null ? sql`ai_credits_user_balance = ${newCredits},` : sql``}
        updated_at           = NOW()
      WHERE id = ${userId}
    `);

    await insertVaultClubEvent({
      userId,
      stripeEventId: eventId,
      eventType: "subscription.updated",
      tier,
      status: status,
    });

    await writeAuthAudit("vault_club.updated", userId, "webhook", { tier, status });
    console.log(`[webhook] Vault Club updated: user=${userId} tier=${tier} status=${status}`);
  }

  // ── Subscription deleted ───────────────────────────────────────────────────

  private static async handleSubscriptionDeleted(eventId: string, sub: Stripe.Subscription): Promise<void> {
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const user = await findUserByStripeCustomerId(customerId);
    if (!user) return;
    const userId = user.id as string;

    await db.execute(sql`
      UPDATE users SET
        vault_club_status    = 'canceled',
        vault_club_tier      = NULL,
        vault_club_cancels_at = NULL,
        vault_club_grace_until = NULL,
        showroom_active      = false,
        updated_at           = NOW()
      WHERE id = ${userId}
    `);

    await insertVaultClubEvent({
      userId,
      stripeEventId: eventId,
      eventType: "subscription.deleted",
      status: "canceled",
    });

    const userRows = await db.execute(sql`SELECT email, display_name FROM users WHERE id = ${userId} LIMIT 1`);
    const userRow = userRows.rows[0] as any;
    if (userRow?.email) {
      // Same visibility fix as the welcome email above — a failed send must
      // not fail the webhook, but must not vanish silently either.
      sendVaultClubCancelledEmail({ email: userRow.email, displayName: userRow.display_name || null }).catch(
        (e: any) => writeAuthAudit("vault_club.cancelled_email_failed", userId, "webhook", { error: e?.message })
      );
    }

    await writeAuthAudit("vault_club.canceled", userId, "webhook", {});
    await writeAuthAudit("showroom.deactivated", userId, "stripe-webhook", {
      tier: "silver",
      subscriptionId: sub.id,
      reason: "subscription_cancelled",
    });
    console.log(`[webhook] Vault Club canceled: user=${userId}`);
  }

  // ── Invoice payment succeeded ──────────────────────────────────────────────

  private static async handleInvoicePaymentSucceeded(eventId: string, invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.customer) return;
    const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer.id;
    const user = await findUserByStripeCustomerId(customerId);
    if (!user) return;
    const userId = user.id as string;
    const tier = user.vault_club_tier as VaultClubTier | null;
    if (!tier) return;

    // Only refill credits on recurring invoices (billing_reason = 'subscription_cycle')
    const isRenewal = (invoice as any).billing_reason === "subscription_cycle";

    if (isRenewal) {
      // Refill AI credits (no rollover)
      await db.execute(sql`
        UPDATE users SET
          vault_club_status        = 'active',
          ai_credits_user_balance  = ${VAULT_CLUB_TIERS[tier].ai_credits_monthly},
          ai_credits_last_refilled_at = NOW(),
          updated_at               = NOW()
        WHERE id = ${userId}
      `);

      // Grant quarterly member credits if we've crossed a quarter boundary
      // Uses dedicated column (not ai_credits_last_refilled_at) — read BEFORE any update
      const now = new Date();
      const lastGranted = user.member_credits_last_granted_at as string | null;
      const prevQuarter = lastGranted ? quarterKey(new Date(lastGranted)) : null;
      const currentQuarter = quarterKey(now);
      if (!prevQuarter || prevQuarter !== currentQuarter) {
        const source = `${tier}_quarterly`;
        await grantMemberCredits(userId, tier, source).catch(() => {});
        await db.execute(sql`
          UPDATE users SET member_credits_last_granted_at = NOW() WHERE id = ${userId}
        `);
      }
    } else {
      // First invoice — just ensure status is active
      await db.execute(sql`
        UPDATE users SET vault_club_status = 'active', updated_at = NOW()
        WHERE id = ${userId} AND vault_club_status = 'past_due'
      `);
    }

    await insertVaultClubEvent({
      userId,
      stripeEventId: eventId,
      eventType: "invoice.payment_succeeded",
      tier,
      status: "active",
      amountPence: invoice.amount_paid || null,
    });

    await writeAuthAudit("vault_club.renewed", userId, "webhook", { tier });
    console.log(`[webhook] Vault Club invoice paid: user=${userId} tier=${tier} renewal=${isRenewal}`);
  }

  // ── Invoice payment failed ─────────────────────────────────────────────────

  private static async handleInvoicePaymentFailed(eventId: string, invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.customer) return;
    const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer.id;
    const user = await findUserByStripeCustomerId(customerId);
    if (!user) return;
    const userId = user.id as string;

    const attemptCount = (invoice as any).attempt_count || 1;
    const isGrace = attemptCount >= 4;

    if (isGrace) {
      const graceUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await db.execute(sql`
        UPDATE users SET
          vault_club_status  = 'grace',
          vault_club_grace_until = ${graceUntil},
          updated_at         = NOW()
        WHERE id = ${userId}
      `);
    } else {
      await db.execute(sql`
        UPDATE users SET vault_club_status = 'past_due', updated_at = NOW()
        WHERE id = ${userId}
      `);
    }

    await insertVaultClubEvent({
      userId,
      stripeEventId: eventId,
      eventType: "invoice.payment_failed",
      status: isGrace ? "grace" : "past_due",
    });

    const userRows = await db.execute(sql`SELECT email, display_name FROM users WHERE id = ${userId} LIMIT 1`);
    const userRow = userRows.rows[0] as any;
    if (userRow?.email) {
      sendVaultClubPaymentFailedEmail({ email: userRow.email, displayName: userRow.display_name || null }).catch(
        () => {}
      );
    }

    console.log(`[webhook] Vault Club payment failed: user=${userId} attempt=${attemptCount} grace=${isGrace}`);
  }

  // ── Stripe Connect: account.updated ──────────────────────────────────────

  private static async handleConnectAccountUpdated(event: Stripe.Event, _stripe: Stripe): Promise<void> {
    const account = event.data.object as Stripe.Account;
    const mintvaultUserId = account.metadata?.mintvault_user_id;
    const purpose = account.metadata?.mintvault_purpose;

    if (!mintvaultUserId || purpose !== "marketplace_seller") {
      console.warn("[webhook] account.updated: missing or non-marketplace metadata, skipping", account.id);
      return;
    }

    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const detailsSubmitted = account.details_submitted === true;
    const disabled = account.requirements?.disabled_reason != null;

    let newStatus: string;
    if (disabled) {
      newStatus = "suspended";
    } else if (chargesEnabled && payoutsEnabled && detailsSubmitted) {
      newStatus = "active";
    } else if (detailsSubmitted) {
      newStatus = "pending"; // submitted but still verifying
    } else {
      newStatus = "pending"; // still onboarding
    }

    // Read current status to detect activation transition
    const currentRows = await db.execute(sql`
      SELECT seller_status FROM users WHERE id = ${mintvaultUserId} LIMIT 1
    `);
    const previousStatus = (currentRows.rows[0] as any)?.seller_status;

    // Update all cached seller fields
    await db.execute(sql`
      UPDATE users
      SET seller_status = ${newStatus},
          seller_charges_enabled = ${chargesEnabled},
          seller_payouts_enabled = ${payoutsEnabled},
          seller_kyc_completed_at = CASE
            WHEN ${detailsSubmitted} AND seller_kyc_completed_at IS NULL THEN NOW()
            ELSE seller_kyc_completed_at
          END,
          seller_kyc_requirements_json = ${JSON.stringify(account.requirements ?? {})}::jsonb,
          updated_at = NOW()
      WHERE id = ${mintvaultUserId}
    `);

    await db.insert(auditLog).values({
      entityType: "user",
      entityId: mintvaultUserId,
      action: "marketplace.seller_account_updated",
      adminUser: null,
      details: {
        stripe_account_id: account.id,
        new_status: newStatus,
        previous_status: previousStatus,
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        details_submitted: detailsSubmitted,
        requirements: account.requirements ?? null,
      },
    });

    // Detect first-time activation
    if (newStatus === "active" && previousStatus !== "active") {
      // TODO: send "You're ready to sell on MintVault" email
      console.log("[marketplace] seller activated:", mintvaultUserId);
    }

    console.log(
      `[webhook] account.updated: user=${mintvaultUserId} status=${previousStatus}→${newStatus} charges=${chargesEnabled} payouts=${payoutsEnabled}`
    );
  }

  // ── Stripe Connect: account.application.deauthorized ─────────────────────

  private static async handleConnectAccountDeauthorized(event: Stripe.Event): Promise<void> {
    const accountId = event.account as string;
    if (!accountId) {
      console.warn("[webhook] account.application.deauthorized: no account ID on event");
      return;
    }

    const userRows = await db.execute(sql`
      SELECT id, seller_status FROM users
      WHERE stripe_connect_account_id = ${accountId} LIMIT 1
    `);
    if (userRows.rows.length === 0) {
      console.warn(`[webhook] account.application.deauthorized: no user found for account ${accountId}`);
      return;
    }

    const userId = (userRows.rows[0] as any).id as string;

    await db.execute(sql`
      UPDATE users
      SET seller_status = 'rejected',
          seller_charges_enabled = false,
          seller_payouts_enabled = false,
          updated_at = NOW()
      WHERE id = ${userId}
    `);

    await db.insert(auditLog).values({
      entityType: "user",
      entityId: userId,
      action: "marketplace.seller_deauthorized",
      adminUser: null,
      details: { stripe_connect_account_id: accountId },
    });

    // TODO: send "Your seller account was disconnected" email
    console.log(`[webhook] account.application.deauthorized: user=${userId} account=${accountId}`);
  }
}
