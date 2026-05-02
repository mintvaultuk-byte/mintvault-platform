/**
 * server/vault-club-reminders.ts
 *
 * Phase 1 Step 5a — DMCC subscription reminder notice helpers (write half).
 *
 * Three operations, all auditable:
 *
 *   - scheduleReminder(...) — INSERT a reminder row with ON CONFLICT DO
 *     NOTHING. Idempotent on (subscription_id, reminder_type,
 *     scheduled_for). Returns the row id (existing or new) and a flag
 *     indicating whether this call was the one that wrote it.
 *
 *   - markReminderSent(id, messageId) — flip sent_at to NOW(), record the
 *     Resend message id, clear any prior send_error.
 *
 *   - markReminderFailed(id, error) — record the error string, leave
 *     sent_at NULL so the dispatcher will retry on the next tick.
 *
 * Every write writes an audit_log row (entity_type 'subscription_reminder',
 * actions 'reminder_scheduled' / 'reminder_sent' / 'reminder_failed').
 * Regulator may ask for evidence — the skill calls this out at line 76.
 *
 * What this file is NOT:
 *   - The dispatcher cron — separate file in the next step.
 *   - The Resend templates — server/email.ts in the next step.
 *   - The webhook integration that decides WHICH reminders to schedule —
 *     server/webhookHandlers.ts edits in the next step.
 *
 * Soft-delete posture: we never DELETE reminder rows. Failed reminders
 * keep their send_error history for audit. Cancelled subscriptions can
 * have un-sent future reminders left in place (the dispatcher's WHERE
 * clause should filter by current vault_club_subscriptions.status when
 * the dispatcher lands — out of scope here).
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import type { SubscriptionReminderType } from "@shared/schema";

// ── Audit helper — pinned to the subscription_reminder entity_type ────────

type ReminderAuditAction =
  | "reminder_scheduled"
  | "reminder_sent"
  | "reminder_failed";

async function writeReminderAudit(
  reminderId: string,
  action: ReminderAuditAction,
  details: Record<string, unknown> = {},
): Promise<void> {
  await storage.writeAuditLog(
    "subscription_reminder",
    reminderId,
    action,
    "system",
    details,
  );
}

// ── Public helpers ────────────────────────────────────────────────────────

export interface ScheduleReminderInput {
  /** Stripe subscription id (e.g. "sub_..."). Not a FK. */
  subscriptionId: string;
  /** Internal users.id — varchar (not integer; users.id is a string PK). */
  userId: string;
  reminderType: SubscriptionReminderType;
  /** When the dispatcher should send this. Pass a Date in UTC. */
  scheduledFor: Date;
}

export interface ScheduleReminderResult {
  id: string;
  /** True iff this call was the one that wrote the row (false → already scheduled). */
  newlyScheduled: boolean;
}

/**
 * INSERT … ON CONFLICT DO NOTHING on (subscription_id, reminder_type,
 * scheduled_for). Returns the row id and whether we wrote it.
 *
 * On conflict, we still SELECT the existing row's id so callers can
 * link audit entries either way.
 */
export async function scheduleReminder(
  input: ScheduleReminderInput,
): Promise<ScheduleReminderResult> {
  const result = await db.execute(sql`
    INSERT INTO subscription_reminders
      (subscription_id, user_id, reminder_type, scheduled_for)
    VALUES
      (${input.subscriptionId}, ${input.userId}, ${input.reminderType},
       ${input.scheduledFor.toISOString()})
    ON CONFLICT (subscription_id, reminder_type, scheduled_for) DO NOTHING
    RETURNING id
  `);

  const newlyScheduled = result.rows.length > 0;
  const newId = newlyScheduled ? (result.rows[0] as { id: string }).id : null;

  // On conflict the INSERT returned no rows; look up the existing row.
  let id: string;
  if (newId) {
    id = newId;
  } else {
    const existing = await db.execute(sql`
      SELECT id FROM subscription_reminders
      WHERE subscription_id = ${input.subscriptionId}
        AND reminder_type = ${input.reminderType}
        AND scheduled_for = ${input.scheduledFor.toISOString()}
      LIMIT 1
    `);
    id = (existing.rows[0] as { id: string }).id;
  }

  if (newlyScheduled) {
    await writeReminderAudit(id, "reminder_scheduled", {
      stripe_subscription_id: input.subscriptionId,
      user_id: input.userId,
      reminder_type: input.reminderType,
      scheduled_for: input.scheduledFor.toISOString(),
    });
  }

  return { id, newlyScheduled };
}

/**
 * Flip a reminder row to "sent". Records the Resend message id, clears
 * any previous send_error so retries leave a clean trail.
 *
 * Idempotency: setting sent_at on a row whose sent_at is already not
 * null is a no-op at the audit level — we skip the write so the audit
 * trail doesn't get noisy with duplicate "reminder_sent" rows. The
 * UPDATE itself is harmless.
 */
export async function markReminderSent(
  reminderId: string,
  emailMessageId: string,
): Promise<void> {
  const result = await db.execute(sql`
    UPDATE subscription_reminders
    SET sent_at = NOW(),
        email_message_id = ${emailMessageId},
        send_error = NULL
    WHERE id = ${reminderId} AND sent_at IS NULL
    RETURNING id
  `);

  if (result.rows.length === 0) {
    // Already sent — don't write a duplicate audit row.
    return;
  }

  await writeReminderAudit(reminderId, "reminder_sent", {
    email_message_id: emailMessageId,
  });
}

/**
 * Record a send error and leave the row un-sent so the dispatcher will
 * retry on its next tick. Each failure is audited so we can spot
 * stuck reminders in production.
 */
export async function markReminderFailed(
  reminderId: string,
  error: string,
): Promise<void> {
  // Truncate so a Stripe / Resend stack trace doesn't bloat the row.
  const truncated = error.length > 1000 ? error.slice(0, 1000) + "…" : error;

  await db.execute(sql`
    UPDATE subscription_reminders
    SET send_error = ${truncated}
    WHERE id = ${reminderId} AND sent_at IS NULL
  `);

  await writeReminderAudit(reminderId, "reminder_failed", {
    error: truncated,
  });
}
