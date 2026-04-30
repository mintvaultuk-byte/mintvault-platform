import Stripe from 'stripe';
import { getStripeSecretKey, getStripeWebhookSecrets } from './stripeClient';
import { storage } from './storage';
import { sendSubmissionConfirmation } from './email';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { VAULT_CLUB_TIERS, type VaultClubTier, isActiveStatus, quarterKey } from './vault-club-tiers';
import { findUserByStripeCustomerId, insertVaultClubEvent, grantMemberCredits } from './vault-club';
import { writeAuthAudit } from './account-auth';
import { auditLog } from '@shared/schema';
import {
  writeVaultClubSubscriptionAudit,
  type VaultClubAuditAction,
} from './vault-club-audit';
import {
  sendVaultClubWelcomeEmail,
  sendVaultClubCancelledEmail,
  sendVaultClubPaymentFailedEmail,
} from './email';

// ── Step 3 helpers ────────────────────────────────────────────────────────────
// Shape of vault_club_subscriptions rows we care about for transition detection.
interface VaultClubSubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: string | null;
}

async function getSubscriptionRow(
  stripeSubscriptionId: string,
): Promise<VaultClubSubscriptionRow | null> {
  const rows = await db.execute(sql`
    SELECT id, user_id, status, cancel_at_period_end, trial_end
    FROM vault_club_subscriptions
    WHERE stripe_subscription_id = ${stripeSubscriptionId}
    LIMIT 1
  `);
  return (rows.rows[0] as unknown as VaultClubSubscriptionRow | undefined) ?? null;
}

interface UpsertParams {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: string;
  trialEnd: number | null;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
}

/**
 * Upsert a row in vault_club_subscriptions keyed on stripe_subscription_id.
 * Returns the internal row id (subscription_row_id used as audit_log entity_id).
 */
async function upsertSubscriptionRow(p: UpsertParams): Promise<string> {
  const trialEndIso = p.trialEnd ? new Date(p.trialEnd * 1000).toISOString() : null;
  const periodStartIso = new Date(p.currentPeriodStart * 1000).toISOString();
  const periodEndIso = new Date(p.currentPeriodEnd * 1000).toISOString();
  const canceledAtIso = p.canceledAt ? new Date(p.canceledAt * 1000).toISOString() : null;

  const result = await db.execute(sql`
    INSERT INTO vault_club_subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
      status, trial_end, current_period_start, current_period_end,
      cancel_at_period_end, canceled_at, updated_at
    ) VALUES (
      ${p.userId}, ${p.stripeCustomerId}, ${p.stripeSubscriptionId}, ${p.stripePriceId},
      ${p.status}, ${trialEndIso}, ${periodStartIso}, ${periodEndIso},
      ${p.cancelAtPeriodEnd}, ${canceledAtIso}, NOW()
    )
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET
      stripe_customer_id     = EXCLUDED.stripe_customer_id,
      stripe_price_id        = EXCLUDED.stripe_price_id,
      status                 = EXCLUDED.status,
      trial_end              = EXCLUDED.trial_end,
      current_period_start   = EXCLUDED.current_period_start,
      current_period_end     = EXCLUDED.current_period_end,
      cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
      canceled_at            = EXCLUDED.canceled_at,
      updated_at             = NOW()
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
}

/**
 * Pull a Stripe Subscription's price ID from its primary line item.
 * Returns empty string if the subscription has no items (shouldn't happen
 * in practice, but Stripe types make `items` optional).
 */
function priceIdFromSubscription(sub: Stripe.Subscription): string {
  return sub.items?.data?.[0]?.price?.id ?? '';
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'Ensure webhook route is registered BEFORE app.use(express.json()).'
      );
    }

    const { primary: webhookSecret, secondary: webhookSecret2 } = getStripeWebhookSecrets();

    const secretKey = await getStripeSecretKey();
    const stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' as any });

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

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      console.log(`[webhook] payment_intent.succeeded for PI ${pi.id}`);

      const submission = await storage.getSubmissionByPaymentIntentId(pi.id);
      if (!submission) {
        console.log(`[webhook] No submission found for PI ${pi.id} — ignoring`);
        return;
      }

      // Idempotency: skip if already marked paid
      if (submission.paymentStatus === 'paid') {
        console.log(`[webhook] Submission ${submission.submissionId} already paid — skipping duplicate`);
        return;
      }

      await storage.markSubmissionAsPaid(Number(submission.id));
      // Set estimated completion date based on service tier
      storage.setEstimatedCompletionDate(Number(submission.id)).catch(() => {});

      if (submission.email) {
        let user = await storage.getUserByEmail(submission.email);
        if (!user) {
          user = await storage.createUser({
            email: submission.email,
            firstName: submission.firstName || undefined,
            lastName: submission.lastName || undefined,
          });
        }
        await storage.updateSubmission(Number(submission.id), { userId: user.id });
      }

      sendSubmissionConfirmation({
        email: submission.email || '',
        firstName: submission.firstName || 'Customer',
        submissionId: submission.submissionId,
        cardCount: submission.cardCount || 0,
        tier: submission.serviceTier || 'standard',
        total: pi.amount || 0,
        serviceType: submission.serviceType || undefined,
        crossoverCompany: submission.crossoverCompany || undefined,
        crossoverOriginalGrade: submission.crossoverOriginalGrade || undefined,
        crossoverCertNumber: submission.crossoverCertNumber || undefined,
      }).catch((err: any) => console.error('[webhook] Email send error:', err.message));

      console.log(`[webhook] Submission ${submission.submissionId} → status=new paymentStatus=paid`);
    }

    // ── Existing estimate credits checkout ─────────────────────────────────────

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata || {};

      // Vault Club subscription checkout
      if (session.mode === 'subscription' && meta.user_id) {
        await WebhookHandlers.handleSubscriptionCheckoutCompleted(event.id, session, stripe);
        return;
      }

      // Legacy estimate credits checkout
      if (meta.type === 'estimate_credits') {
        const email = (meta.email || '').trim().toLowerCase();
        const credits = parseInt(meta.credits || '0', 10);
        if (!email || credits <= 0) return;

        console.log(`[webhook] estimate_credits: +${credits} for ${email}`);
        try {
          // If a user_id is in the metadata, credit their account balance directly
          if (meta.user_id) {
            await db.execute(sql`
              UPDATE users SET ai_credits_user_balance = ai_credits_user_balance + ${credits} WHERE id = ${meta.user_id}
            `);
          } else {
            // Email-based fallback for anonymous purchases
            await db.execute(sql`
              INSERT INTO estimate_credits (email, credits_remaining, credits_purchased, credits_used)
              VALUES (${email}, ${credits}, ${credits}, 0)
              ON CONFLICT (email) DO UPDATE SET
                credits_remaining = estimate_credits.credits_remaining + ${credits},
                credits_purchased = estimate_credits.credits_purchased + ${credits},
                updated_at = NOW()
            `);
          }
        } catch (err: any) {
          console.error('[webhook] estimate_credits upsert error:', err.message);
        }
      }
    }

    // ── Vault Club subscription events ────────────────────────────────────────

    if (event.type === 'customer.subscription.created') {
      await WebhookHandlers.handleSubscriptionCreated(event.id, event.data.object as Stripe.Subscription);
    }

    if (event.type === 'customer.subscription.updated') {
      await WebhookHandlers.handleSubscriptionUpdated(event.id, event.data.object as Stripe.Subscription);
    }

    if (event.type === 'customer.subscription.deleted') {
      await WebhookHandlers.handleSubscriptionDeleted(event.id, event.data.object as Stripe.Subscription);
    }

    if (event.type === 'invoice.payment_succeeded') {
      await WebhookHandlers.handleInvoicePaymentSucceeded(event.id, event.data.object as Stripe.Invoice);
    }

    if (event.type === 'invoice.payment_failed') {
      await WebhookHandlers.handleInvoicePaymentFailed(event.id, event.data.object as Stripe.Invoice);
    }

    // ── Stripe Connect marketplace events ────────────────────────────────────

    if (event.type === 'account.updated') {
      // Connect account event — only handle if we recognise it as ours
      const account = event.data.object as Stripe.Account;
      if (account.metadata?.mintvault_purpose === 'marketplace_seller') {
        await WebhookHandlers.handleConnectAccountUpdated(event, stripe);
      }
    }

    if (event.type === 'account.application.deauthorized') {
      await WebhookHandlers.handleConnectAccountDeauthorized(event);
    }

    if (event.type === 'capability.updated') {
      // Log only for now — the account.updated handler will capture the derived state
      console.log('[webhook] capability.updated for account:', event.account);
    }
  }

  // ── Subscription checkout completed ───────────────────────────────────────

  private static async handleSubscriptionCheckoutCompleted(
    eventId: string,
    session: Stripe.Checkout.Session,
    stripe: Stripe,
  ): Promise<void> {
    const meta = session.metadata || {};
    const userId = meta.user_id;
    const tier = meta.tier as VaultClubTier;
    const interval = meta.interval;

    if (!userId || !tier || !(tier in VAULT_CLUB_TIERS)) {
      console.warn('[webhook] subscription checkout missing metadata:', meta);
      return;
    }

    const subscriptionId = session.subscription as string | null;
    let sub: Stripe.Subscription | null = null;
    if (subscriptionId) {
      sub = await stripe.subscriptions.retrieve(subscriptionId);
    }

    const isTrialing = sub?.status === 'trialing';
    const status = isTrialing ? 'trialing' : 'active';
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

    const isNewEvent = await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'subscription.created', tier, status,
    });

    // Fetch user for email
    const userRows = await db.execute(sql`SELECT email, display_name FROM users WHERE id = ${userId} LIMIT 1`);
    const user = userRows.rows[0] as any;
    if (user?.email) {
      sendVaultClubWelcomeEmail({
        email: user.email,
        displayName: user.display_name || null,
        tier,
      }).catch(() => {});
    }

    await writeAuthAudit('vault_club.subscribed', userId, 'webhook', { tier, status });
    console.log(`[webhook] Vault Club subscribed: user=${userId} tier=${tier} status=${status}`);

    // ── Step 3 dual-write: vault_club_subscriptions + audit_log ──────────────
    // Gated on idempotency — if this event was already processed, skip.
    if (!isNewEvent || !sub || !subscriptionId) return;

    const subRowId = await upsertSubscriptionRow({
      userId,
      stripeCustomerId: session.customer as string,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceIdFromSubscription(sub),
      status: sub.status,
      trialEnd: sub.trial_end ?? null,
      currentPeriodStart: (sub as any).current_period_start,
      currentPeriodEnd: (sub as any).current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: sub.canceled_at ?? null,
    });

    await writeVaultClubSubscriptionAudit(
      subRowId,
      'checkout_session_created',
      'stripe-webhook',
      {
        stripe_event_id: eventId,
        stripe_subscription_id: subscriptionId,
        stripe_customer_id: session.customer as string,
        stripe_price_id: priceIdFromSubscription(sub),
        new_status: sub.status,
        tier,
        interval,
      },
    );
  }

  // ── Subscription created ──────────────────────────────────────────────────
  //
  // Step 3: deterministic vault_club_subscriptions row creation. Stripe fires
  // customer.subscription.created shortly after checkout.session.completed (or
  // when an admin creates a sub via the dashboard / API). The legacy flow
  // inferred creation from checkout.session.completed, which is racy when
  // events arrive out of order. This handler is the canonical source for
  // populating vault_club_subscriptions on first sight of a sub.
  //
  // No legacy users-column writes here — checkout.session.completed already
  // does those. This handler is Step 3 only.

  private static async handleSubscriptionCreated(
    eventId: string,
    sub: Stripe.Subscription,
  ): Promise<void> {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const user = await findUserByStripeCustomerId(customerId);
    if (!user) {
      console.warn(`[webhook] subscription.created: no user for customer ${customerId}`);
      return;
    }
    const userId = user.id as string;
    const tier = (sub.metadata?.tier ?? sub.items?.data?.[0]?.price?.metadata?.mintvault_tier ?? null) as VaultClubTier | null;

    const isNewEvent = await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'subscription.created.event', tier, status: sub.status,
    });
    if (!isNewEvent) return;

    const subRowId = await upsertSubscriptionRow({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceIdFromSubscription(sub),
      status: sub.status,
      trialEnd: sub.trial_end ?? null,
      currentPeriodStart: (sub as any).current_period_start,
      currentPeriodEnd: (sub as any).current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: sub.canceled_at ?? null,
    });

    // Status=trialing on .created → "trial_started"
    // Status=active on .created (no trial configured) → "created"
    // Anything else (incomplete, etc.) → still write a "created" audit so the
    // first-sighting is logged; subsequent .updated events will refine.
    const action: VaultClubAuditAction = sub.status === 'trialing' ? 'trial_started' : 'created';

    await writeVaultClubSubscriptionAudit(
      subRowId,
      action,
      'stripe-webhook',
      {
        stripe_event_id: eventId,
        stripe_subscription_id: sub.id,
        stripe_customer_id: customerId,
        new_status: sub.status,
        trial_end: sub.trial_end,
        tier,
      },
    );
    console.log(`[webhook] Vault Club subscription.created: user=${userId} status=${sub.status} action=${action}`);
  }

  // ── Subscription updated ───────────────────────────────────────────────────

  private static async handleSubscriptionUpdated(
    eventId: string,
    sub: Stripe.Subscription,
  ): Promise<void> {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const user = await findUserByStripeCustomerId(customerId);
    if (!user) {
      console.warn(`[webhook] subscription.updated: no user for customer ${customerId}`);
      return;
    }
    const userId = user.id as string;

    // Extract tier from subscription price metadata
    const priceItem = sub.items?.data?.[0];
    const tierFromMeta = priceItem?.price?.metadata?.mintvault_tier as VaultClubTier | undefined;
    const tier = (tierFromMeta && tierFromMeta in VAULT_CLUB_TIERS) ? tierFromMeta : (user.vault_club_tier as VaultClubTier | null);

    const status = sub.status;
    const renewsAt = (sub as any).current_period_end
      ? new Date((sub as any).current_period_end * 1000).toISOString()
      : null;
    const cancelsAt = sub.cancel_at
      ? new Date(sub.cancel_at * 1000).toISOString()
      : null;

    // If tier changed, refresh AI credits to new tier amount
    const previousTier = user.vault_club_tier as VaultClubTier | null;
    const tierChanged = tier && previousTier && tier !== previousTier;
    const newCredits = tier && tierChanged
      ? VAULT_CLUB_TIERS[tier].ai_credits_monthly
      : null;

    // ── Step 3 transition detection — read PREVIOUS state from
    //    vault_club_subscriptions before any write so we can compare.
    const prevRow = await getSubscriptionRow(sub.id);

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

    const isNewEvent = await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'subscription.updated', tier, status: status,
    });

    await writeAuthAudit('vault_club.updated', userId, 'webhook', { tier, status });
    console.log(`[webhook] Vault Club updated: user=${userId} tier=${tier} status=${status}`);

    // ── Step 3 dual-write: vault_club_subscriptions + audit_log ──────────────
    if (!isNewEvent) return;

    const subRowId = await upsertSubscriptionRow({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceIdFromSubscription(sub),
      status: sub.status,
      trialEnd: sub.trial_end ?? null,
      currentPeriodStart: (sub as any).current_period_start,
      currentPeriodEnd: (sub as any).current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: sub.canceled_at ?? null,
    });

    // Detect the meaningful transition. Brief priorities:
    //   1. trialing → active   ⇒ "trial_ended_paid"
    //   2. cancel_at_period_end newly true ⇒ "canceled" (scheduled)
    //   3. status → past_due   ⇒ "payment_failed"
    // No transition match → upsert only, no audit row (the .updated event
    // may be a benign change like a metadata edit).
    const prevStatus = prevRow?.status ?? null;
    const prevCancelAtPeriodEnd = prevRow?.cancel_at_period_end ?? false;
    const newCancelAtPeriodEnd = sub.cancel_at_period_end ?? false;

    let action: VaultClubAuditAction | null = null;
    if (prevStatus === 'trialing' && sub.status === 'active') {
      action = 'trial_ended_paid';
    } else if (!prevCancelAtPeriodEnd && newCancelAtPeriodEnd) {
      action = 'canceled';
    } else if (sub.status === 'past_due') {
      action = 'payment_failed';
    }

    if (action) {
      await writeVaultClubSubscriptionAudit(
        subRowId,
        action,
        'stripe-webhook',
        {
          stripe_event_id: eventId,
          stripe_subscription_id: sub.id,
          stripe_customer_id: customerId,
          previous_status: prevStatus,
          new_status: sub.status,
          previous_cancel_at_period_end: prevCancelAtPeriodEnd,
          new_cancel_at_period_end: newCancelAtPeriodEnd,
          tier,
        },
      );
      console.log(`[webhook] Vault Club transition: user=${userId} ${prevStatus}→${sub.status} action=${action}`);
    }
  }

  // ── Subscription deleted ───────────────────────────────────────────────────

  private static async handleSubscriptionDeleted(
    eventId: string,
    sub: Stripe.Subscription,
  ): Promise<void> {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
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

    const isNewEvent = await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'subscription.deleted', status: 'canceled',
    });

    const userRows = await db.execute(sql`SELECT email, display_name FROM users WHERE id = ${userId} LIMIT 1`);
    const userRow = userRows.rows[0] as any;
    if (userRow?.email) {
      sendVaultClubCancelledEmail({ email: userRow.email, displayName: userRow.display_name || null }).catch(() => {});
    }

    await writeAuthAudit('vault_club.canceled', userId, 'webhook', {});
    console.log(`[webhook] Vault Club canceled: user=${userId}`);

    // ── Step 3 dual-write ────────────────────────────────────────────────────
    if (!isNewEvent) return;

    const subRowId = await upsertSubscriptionRow({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceIdFromSubscription(sub),
      status: sub.status, // typically 'canceled' on .deleted
      trialEnd: sub.trial_end ?? null,
      currentPeriodStart: (sub as any).current_period_start,
      currentPeriodEnd: (sub as any).current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: sub.canceled_at ?? Math.floor(Date.now() / 1000),
    });

    await writeVaultClubSubscriptionAudit(
      subRowId,
      'canceled',
      'stripe-webhook',
      {
        stripe_event_id: eventId,
        stripe_subscription_id: sub.id,
        stripe_customer_id: customerId,
        new_status: sub.status,
        canceled_at: sub.canceled_at,
        final: true,
      },
    );
  }

  // ── Invoice payment succeeded ──────────────────────────────────────────────

  private static async handleInvoicePaymentSucceeded(
    eventId: string,
    invoice: Stripe.Invoice,
  ): Promise<void> {
    if (!invoice.customer) return;
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;
    const user = await findUserByStripeCustomerId(customerId);
    if (!user) return;
    const userId = user.id as string;
    const tier = user.vault_club_tier as VaultClubTier | null;
    if (!tier) return;

    // Only refill credits on recurring invoices (billing_reason = 'subscription_cycle')
    const isRenewal = (invoice as any).billing_reason === 'subscription_cycle';

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

    const isNewEvent = await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'invoice.payment_succeeded', tier,
      status: 'active',
      amountPence: invoice.amount_paid || null,
    });

    await writeAuthAudit('vault_club.renewed', userId, 'webhook', { tier });
    console.log(`[webhook] Vault Club invoice paid: user=${userId} tier=${tier} renewal=${isRenewal}`);

    // ── Step 3 dual-write: refresh vault_club_subscriptions from Stripe + audit
    if (!isNewEvent) return;
    const subscriptionId = (invoice as any).subscription as string | null;
    if (!subscriptionId) return;

    const stripe = new Stripe(await getStripeSecretKey(), { apiVersion: '2025-08-27.basil' as any });
    const sub = await stripe.subscriptions.retrieve(subscriptionId);

    const subRowId = await upsertSubscriptionRow({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceIdFromSubscription(sub),
      status: sub.status,
      trialEnd: sub.trial_end ?? null,
      currentPeriodStart: (sub as any).current_period_start,
      currentPeriodEnd: (sub as any).current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: sub.canceled_at ?? null,
    });

    // Audit row only on recurring renewal — first invoice is covered by
    // checkout.session.completed / customer.subscription.created.
    if (isRenewal) {
      await writeVaultClubSubscriptionAudit(
        subRowId,
        'renewed',
        'stripe-webhook',
        {
          stripe_event_id: eventId,
          stripe_invoice_id: invoice.id,
          stripe_subscription_id: sub.id,
          stripe_customer_id: customerId,
          new_status: sub.status,
          amount_pence: invoice.amount_paid,
          billing_reason: (invoice as any).billing_reason,
          tier,
        },
      );
    }
  }

  // ── Invoice payment failed ─────────────────────────────────────────────────

  private static async handleInvoicePaymentFailed(
    eventId: string,
    invoice: Stripe.Invoice,
  ): Promise<void> {
    if (!invoice.customer) return;
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;
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

    const isNewEvent = await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'invoice.payment_failed', status: isGrace ? 'grace' : 'past_due',
    });

    const userRows = await db.execute(sql`SELECT email, display_name FROM users WHERE id = ${userId} LIMIT 1`);
    const userRow = userRows.rows[0] as any;
    if (userRow?.email) {
      sendVaultClubPaymentFailedEmail({ email: userRow.email, displayName: userRow.display_name || null }).catch(() => {});
    }

    console.log(`[webhook] Vault Club payment failed: user=${userId} attempt=${attemptCount} grace=${isGrace}`);

    // ── Step 3 dual-write: refresh vault_club_subscriptions from Stripe + audit
    if (!isNewEvent) return;
    const subscriptionId = (invoice as any).subscription as string | null;
    if (!subscriptionId) return;

    const stripe = new Stripe(await getStripeSecretKey(), { apiVersion: '2025-08-27.basil' as any });
    const sub = await stripe.subscriptions.retrieve(subscriptionId);

    const subRowId = await upsertSubscriptionRow({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceIdFromSubscription(sub),
      status: sub.status,
      trialEnd: sub.trial_end ?? null,
      currentPeriodStart: (sub as any).current_period_start,
      currentPeriodEnd: (sub as any).current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: sub.canceled_at ?? null,
    });

    await writeVaultClubSubscriptionAudit(
      subRowId,
      'payment_failed',
      'stripe-webhook',
      {
        stripe_event_id: eventId,
        stripe_invoice_id: invoice.id,
        stripe_subscription_id: sub.id,
        stripe_customer_id: customerId,
        new_status: sub.status,
        attempt_count: attemptCount,
        is_grace: isGrace,
      },
    );
  }

  // ── Stripe Connect: account.updated ──────────────────────────────────────

  private static async handleConnectAccountUpdated(
    event: Stripe.Event,
    _stripe: Stripe,
  ): Promise<void> {
    const account = event.data.object as Stripe.Account;
    const mintvaultUserId = account.metadata?.mintvault_user_id;
    const purpose = account.metadata?.mintvault_purpose;

    if (!mintvaultUserId || purpose !== 'marketplace_seller') {
      console.warn('[webhook] account.updated: missing or non-marketplace metadata, skipping', account.id);
      return;
    }

    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const detailsSubmitted = account.details_submitted === true;
    const disabled = account.requirements?.disabled_reason != null;

    let newStatus: string;
    if (disabled) {
      newStatus = 'suspended';
    } else if (chargesEnabled && payoutsEnabled && detailsSubmitted) {
      newStatus = 'active';
    } else if (detailsSubmitted) {
      newStatus = 'pending'; // submitted but still verifying
    } else {
      newStatus = 'pending'; // still onboarding
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
      entityType: 'user',
      entityId: mintvaultUserId,
      action: 'marketplace.seller_account_updated',
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
    if (newStatus === 'active' && previousStatus !== 'active') {
      // TODO: send "You're ready to sell on MintVault" email
      console.log('[marketplace] seller activated:', mintvaultUserId);
    }

    console.log(`[webhook] account.updated: user=${mintvaultUserId} status=${previousStatus}→${newStatus} charges=${chargesEnabled} payouts=${payoutsEnabled}`);
  }

  // ── Stripe Connect: account.application.deauthorized ─────────────────────

  private static async handleConnectAccountDeauthorized(
    event: Stripe.Event,
  ): Promise<void> {
    const accountId = event.account as string;
    if (!accountId) {
      console.warn('[webhook] account.application.deauthorized: no account ID on event');
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
      entityType: 'user',
      entityId: userId,
      action: 'marketplace.seller_deauthorized',
      adminUser: null,
      details: { stripe_connect_account_id: accountId },
    });

    // TODO: send "Your seller account was disconnected" email
    console.log(`[webhook] account.application.deauthorized: user=${userId} account=${accountId}`);
  }
}
