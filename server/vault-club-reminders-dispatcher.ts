/**
 * server/vault-club-reminders-dispatcher.ts
 *
 * Phase 1 Step 5b — pulls due reminders out of subscription_reminders
 * and sends them via Resend. Idempotent across runs (rows are flipped to
 * sent_at IS NOT NULL once handled). Fails open: a single row's failure
 * leaves the row in retry state but does not block the rest of the batch.
 *
 * Wired in server/index.ts as a daily-but-far-more-often setInterval +
 * a one-shot call on startup so a deploy doesn't delay reminders.
 *
 * Selection invariants:
 *   WHERE sent_at IS NULL AND scheduled_for <= NOW()
 *   ORDER BY scheduled_for ASC
 *   LIMIT 100
 *
 * Pipeline per row:
 *   1. Look up vault_club_subscriptions for the sub. If missing, mark
 *      skipped (likely a webhook drop — we don't have the sub state).
 *   2. If sub.status is NOT in {trialing, active}, OR cancel_at_period_end
 *      is true, mark skipped — don't pester ex-members or members who
 *      have already chosen to leave (skill anti-pattern: emailing a
 *      cancelling user with "your subscription will renew").
 *   3. Look up user. If deleted_at, mark skipped.
 *   4. Pick template by reminder_type, build args from sub + user state,
 *      send. On success → markReminderSent with the Resend message id.
 *      On throw → markReminderFailed with the error message.
 *
 * Notes on freshness: by the time the dispatcher runs, the sub state may
 * differ from when the reminder was scheduled (e.g. user cancelled
 * yesterday, reminder due today). The status guard above catches that.
 *
 * Out of scope (intentionally):
 *   - Sending the cancellation confirmation email (that's webhook-driven,
 *     not scheduler-driven; lives in webhookHandlers.ts).
 *   - Scheduling logic (lives in webhookHandlers.ts on subscription events).
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import { APP_BASE_URL } from "./app-url";
import { intervalForPriceId } from "./vault-club-config";
import {
  markReminderFailed,
  markReminderSent,
  markReminderSkipped,
} from "./vault-club-reminders";
import {
  sendVaultClubAnnualRenewalEmail,
  sendVaultClubMonthlyReminderEmail,
  sendVaultClubPriceChangeEmail,
  sendVaultClubTrialEndingEmail,
} from "./email";

const BATCH_SIZE = 100;

interface DueReminderRow {
  id: string;
  subscription_id: string;
  user_id: string;
  reminder_type:
    | "trial_ending"
    | "annual_renewal"
    | "monthly_6mo"
    | "monthly_12mo"
    | "price_change";
  scheduled_for: string;
}

interface SubRow {
  status: string;
  stripe_price_id: string;
  trial_end: string | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  created_at: string;
}

interface UserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  deleted_at: string | null;
  ai_credits_user_balance: number | null;
}

const ACTIVE_STATUSES = new Set(["trialing", "active"]);
const MANAGE_URL = () => `${APP_BASE_URL}/account/vault-club`;

function priceForInterval(priceId: string): number {
  // Hardcoded against vault-club-config.ts — Silver only as of launch.
  // Add cases here when more tiers ship.
  const interval = intervalForPriceId(priceId);
  if (interval === "year") return 9900;
  return 999; // fallback to monthly
}

async function loadSub(subId: string): Promise<SubRow | null> {
  const r = await db.execute(sql`
    SELECT status, stripe_price_id, trial_end, current_period_start,
           current_period_end, cancel_at_period_end, created_at
    FROM vault_club_subscriptions
    WHERE stripe_subscription_id = ${subId}
    LIMIT 1
  `);
  return (r.rows[0] as unknown as SubRow | undefined) ?? null;
}

async function loadUser(userId: string): Promise<UserRow | null> {
  const r = await db.execute(sql`
    SELECT id, email, display_name, deleted_at, ai_credits_user_balance
    FROM users WHERE id = ${userId} LIMIT 1
  `);
  return (r.rows[0] as unknown as UserRow | undefined) ?? null;
}

async function processOne(row: DueReminderRow): Promise<void> {
  const sub = await loadSub(row.subscription_id);
  if (!sub) {
    await markReminderSkipped(row.id, "sub-not-in-db");
    return;
  }
  if (!ACTIVE_STATUSES.has(sub.status) || sub.cancel_at_period_end) {
    await markReminderSkipped(row.id, "sub-not-active");
    return;
  }
  const user = await loadUser(row.user_id);
  if (!user || user.deleted_at) {
    await markReminderSkipped(row.id, "user-not-active");
    return;
  }
  if (!user.email) {
    await markReminderSkipped(row.id, "no-email");
    return;
  }

  const interval = intervalForPriceId(sub.stripe_price_id);
  const priceCents = priceForInterval(sub.stripe_price_id);
  const periodEnd = new Date(sub.current_period_end);

  let messageId: string;
  switch (row.reminder_type) {
    case "trial_ending": {
      const trialEnd = sub.trial_end ? new Date(sub.trial_end) : periodEnd;
      messageId = await sendVaultClubTrialEndingEmail({
        email: user.email,
        displayName: user.display_name,
        trialEndDate: trialEnd,
        firstChargeDate: trialEnd,
        firstChargeAmountPence: priceCents,
        interval: interval === "year" ? "year" : "month",
        manageUrl: MANAGE_URL(),
      });
      break;
    }
    case "annual_renewal": {
      messageId = await sendVaultClubAnnualRenewalEmail({
        email: user.email,
        displayName: user.display_name,
        renewalDate: periodEnd,
        renewalAmountPence: priceCents,
        manageUrl: MANAGE_URL(),
      });
      break;
    }
    case "monthly_6mo":
    case "monthly_12mo": {
      const monthsActive = row.reminder_type === "monthly_12mo" ? 12 : 6;
      messageId = await sendVaultClubMonthlyReminderEmail({
        email: user.email,
        displayName: user.display_name,
        monthsActive,
        nextRenewalDate: periodEnd,
        renewalAmountPence: priceCents,
        manageUrl: MANAGE_URL(),
      });
      break;
    }
    case "price_change": {
      // Price-change scheduling is not in this PR's webhook integration
      // (waiting on solicitor sign-off + the actual price change moment).
      // Keep the dispatcher branch in place so a manually-scheduled row
      // still sends. effectiveDate = scheduled_for (the row tells us when).
      // old/new prices unknown at dispatch time — placeholder values that
      // will be replaced when the price-change runner is built.
      messageId = await sendVaultClubPriceChangeEmail({
        email: user.email,
        displayName: user.display_name,
        oldPricePence: priceCents,
        newPricePence: priceCents, // overridden when scheduler ships
        effectiveDate: new Date(row.scheduled_for),
        manageUrl: MANAGE_URL(),
      });
      break;
    }
    default: {
      // Exhaustiveness check — TypeScript would fail at compile time if a
      // new reminder_type was added without updating this switch.
      const _exhaustive: never = row.reminder_type;
      void _exhaustive;
      throw new Error(`unknown reminder_type: ${row.reminder_type}`);
    }
  }
  await markReminderSent(row.id, messageId);
}

/**
 * Public entrypoint — runs once per call. Wired both via setInterval and
 * a single startup invocation in server/index.ts.
 */
export async function runReminderDispatcher(): Promise<{
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}> {
  const due = await db.execute(sql`
    SELECT id, subscription_id, user_id, reminder_type, scheduled_for
    FROM subscription_reminders
    WHERE sent_at IS NULL AND scheduled_for <= NOW()
    ORDER BY scheduled_for ASC
    LIMIT ${BATCH_SIZE}
  `);
  const rows = due.rows as unknown as DueReminderRow[];

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const before = await db.execute(sql`
        SELECT email_message_id FROM subscription_reminders WHERE id = ${row.id}
      `);
      await processOne(row);
      const after = await db.execute(sql`
        SELECT email_message_id FROM subscription_reminders WHERE id = ${row.id}
      `);
      const beforeId = (before.rows[0] as any)?.email_message_id ?? null;
      const afterId = (after.rows[0] as any)?.email_message_id ?? null;
      if (afterId && typeof afterId === "string" && afterId.startsWith("skipped:")) {
        skipped++;
      } else if (afterId && afterId !== beforeId) {
        sent++;
      }
    } catch (err: any) {
      failed++;
      const message = err?.message ?? String(err);
      console.error(`[reminders] failed to process ${row.id} (${row.reminder_type}):`, message);
      try {
        await markReminderFailed(row.id, message);
      } catch (innerErr: any) {
        // If even the failure-marking write blows up (DB outage etc.),
        // the dispatcher's try/catch ensures the loop keeps moving.
        console.error(`[reminders] markReminderFailed itself threw for ${row.id}:`, innerErr?.message);
      }
    }
  }

  if (rows.length > 0) {
    console.log(
      `[reminders] dispatch tick: scanned=${rows.length} sent=${sent} skipped=${skipped} failed=${failed}`
    );
  }
  return { scanned: rows.length, sent, skipped, failed };
}
