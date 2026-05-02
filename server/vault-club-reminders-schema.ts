/**
 * server/vault-club-reminders-schema.ts
 *
 * Phase 1 Step 5a — DMCC subscription reminder notice system (schema half).
 *
 * Idempotent CREATE TABLE IF NOT EXISTS for subscription_reminders. Mirrors
 * the Drizzle definition in shared/schema.ts. Pattern matches
 * server/vault-club-subscriptions-schema.ts — runs at startup, additive,
 * safe to call repeatedly.
 *
 * Wired into the startup chain in server/routes.ts after
 * migrateVaultClubSubscriptionsSchema(). On first boot of a deploy that
 * includes this code, the table + indexes get created. Subsequent boots
 * are no-ops.
 *
 * What this file is for (per docs/dmcc-step5-audit.md and the
 * uk-subscription-compliance skill):
 *
 *   - Track every reminder we OWE a subscriber (DMCC requires reminder
 *     notices before each renewal — missing one is a breach).
 *   - Make the dispatcher idempotent: a row with sent_at IS NOT NULL is
 *     done; a row with sent_at IS NULL gets retried until it sends.
 *   - Provide a paper trail the regulator can subpoena.
 *
 * What this file is NOT (deferred to next step):
 *   - The dispatcher cron itself (no setInterval here)
 *   - The Resend templates
 *   - Webhook integration (scheduling rows on subscription create / renew)
 *
 * Schema reminder (full definition in shared/schema.ts):
 *
 *   id                 uuid PK, gen_random_uuid()
 *   subscription_id    text NOT NULL  (Stripe sub id, NO FK — see note)
 *   user_id            varchar NOT NULL, FK users.id ON DELETE CASCADE
 *   reminder_type      text NOT NULL  (CHECK: trial_ending, annual_renewal,
 *                                            monthly_6mo, monthly_12mo,
 *                                            price_change)
 *   scheduled_for      timestamptz NOT NULL
 *   sent_at            timestamptz nullable
 *   send_error         text nullable
 *   email_message_id   text nullable  (Resend message id, on success)
 *   created_at         timestamptz NOT NULL DEFAULT NOW()
 *
 * Indexes:
 *   subscription_reminders_subscription_idx — UNIQUE (subscription_id,
 *     reminder_type, scheduled_for) — idempotency: re-running the
 *     scheduler for the same renewal is a no-op
 *   subscription_reminders_due_idx — partial index on (sent_at,
 *     scheduled_for) WHERE sent_at IS NULL — dispatcher hot path
 *
 * Why subscription_id has no FK to vault_club_subscriptions:
 *   Reminder rows may be scheduled in webhook handlers BEFORE the
 *   vault_club_subscriptions row is upserted (race between Stripe
 *   delivering customer.subscription.created and our handler completing
 *   the dual-write). The Stripe sub id is canonical; tying with a FK
 *   would create write-order headaches for no real protection. Same
 *   reasoning audit_log + vault_club_events use.
 */

import { db } from "./db";
import { sql } from "drizzle-orm";

export async function migrateSubscriptionRemindersSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS subscription_reminders (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subscription_id     TEXT NOT NULL,
      user_id             VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reminder_type       TEXT NOT NULL CHECK (reminder_type IN (
                            'trial_ending',
                            'annual_renewal',
                            'monthly_6mo',
                            'monthly_12mo',
                            'price_change'
                          )),
      scheduled_for       TIMESTAMPTZ NOT NULL,
      sent_at             TIMESTAMPTZ,
      send_error          TEXT,
      email_message_id    TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Idempotency: re-scheduling the same reminder for the same renewal
  // is a no-op (ON CONFLICT DO NOTHING in scheduleReminder).
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS subscription_reminders_subscription_idx
      ON subscription_reminders (subscription_id, reminder_type, scheduled_for)
  `);

  // Dispatcher hot path: "what's due to send?"
  // Partial index — only un-sent rows get indexed. Cheap and exactly
  // what the dispatcher's WHERE clause selects on.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS subscription_reminders_due_idx
      ON subscription_reminders (sent_at, scheduled_for)
      WHERE sent_at IS NULL
  `);
}
