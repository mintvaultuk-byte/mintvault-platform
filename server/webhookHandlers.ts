import Stripe from 'stripe';
import { getStripeSecretKey } from './stripeClient';
import { storage } from './storage';
import { sendSubmissionConfirmation } from './email';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { VAULT_CLUB_TIERS, type VaultClubTier, isActiveStatus, quarterKey } from './vault-club-tiers';
import { findUserByStripeCustomerId, insertVaultClubEvent, grantMemberCredits } from './vault-club';
import { writeAuthAudit } from './account-auth';
import { auditLog } from '@shared/schema';
import {
  sendVaultClubWelcomeEmail,
  sendVaultClubCancelledEmail,
  sendVaultClubPaymentFailedEmail,
} from './email';

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'Ensure webhook route is registered BEFORE app.use(express.json()).'
      );
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const webhookSecret2 = process.env.STRIPE_WEBHOOK_SECRET_2;
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET env var is not set');
    }

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

    await insertVaultClubEvent({
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
      userId, stripeEventId: eventId,
      eventType: 'subscription.updated', tier, status: status,
    });

    await writeAuthAudit('vault_club.updated', userId, 'webhook', { tier, status });
    console.log(`[webhook] Vault Club updated: user=${userId} tier=${tier} status=${status}`);
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

    await insertVaultClubEvent({
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

    await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'invoice.payment_succeeded', tier,
      status: 'active',
      amountPence: invoice.amount_paid || null,
    });

    await writeAuthAudit('vault_club.renewed', userId, 'webhook', { tier });
    console.log(`[webhook] Vault Club invoice paid: user=${userId} tier=${tier} renewal=${isRenewal}`);
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

    await insertVaultClubEvent({
      userId, stripeEventId: eventId,
      eventType: 'invoice.payment_failed', status: isGrace ? 'grace' : 'past_due',
    });

    const userRows = await db.execute(sql`SELECT email, display_name FROM users WHERE id = ${userId} LIMIT 1`);
    const userRow = userRows.rows[0] as any;
    if (userRow?.email) {
      sendVaultClubPaymentFailedEmail({ email: userRow.email, displayName: userRow.display_name || null }).catch(() => {});
    }

    console.log(`[webhook] Vault Club payment failed: user=${userId} attempt=${attemptCount} grace=${isGrace}`);
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
