/**
 * server/vault-club-subscriptions-schema.ts
 *
 * Phase 1 Step 1 of the Vault Club Stripe Subscriptions build.
 *
 * Idempotent CREATE TABLE IF NOT EXISTS for vault_club_subscriptions.
 * Mirrors the Drizzle definition in shared/schema.ts. Pattern matches
 * server/account-auth.ts migrateAccountSchema() — runs at startup,
 * additive only, safe to call repeatedly.
 *
 * Wired into the startup chain in server/routes.ts after
 * migrateMarketplaceSchema(). On first boot of a deploy that includes this
 * code, the table + indexes get created. Subsequent boots are no-ops.
 *
 * What this DOES NOT do (deferred to later steps):
 *   - Step 2: buy buttons + checkout endpoint
 *   - Step 3: webhook handlers + state machine
 *   - Step 4: trial-end + dashboard gating
 *
 * Schema reminder (full definition in shared/schema.ts):
 *   id                       varchar PK, gen_random_uuid()
 *   user_id                  varchar NOT NULL, FK users.id ON DELETE CASCADE
 *   stripe_customer_id       text NOT NULL
 *   stripe_subscription_id   text NOT NULL UNIQUE
 *   stripe_price_id          text NOT NULL
 *   status                   text NOT NULL  (Stripe enum: trialing, active,
 *                                            past_due, canceled, incomplete, ...)
 *   trial_end                timestamptz nullable
 *   current_period_start     timestamptz NOT NULL
 *   current_period_end       timestamptz NOT NULL
 *   cancel_at_period_end     boolean NOT NULL DEFAULT false
 *   canceled_at              timestamptz nullable
 *   created_at               timestamptz NOT NULL DEFAULT now()
 *   updated_at               timestamptz NOT NULL DEFAULT now()
 *
 * Indexes:
 *   idx_vault_club_subs_user_id            (user_id)
 *   idx_vault_club_subs_status_period      (status, current_period_end)
 *   stripe_subscription_id UNIQUE          (auto via UNIQUE constraint)
 */

import { db } from "./db";
import { sql } from "drizzle-orm";

export async function migrateVaultClubSubscriptionsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS vault_club_subscriptions (
      id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                  VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_customer_id       TEXT NOT NULL,
      stripe_subscription_id   TEXT NOT NULL UNIQUE,
      stripe_price_id          TEXT NOT NULL,
      status                   TEXT NOT NULL,
      trial_end                TIMESTAMPTZ,
      current_period_start     TIMESTAMPTZ NOT NULL,
      current_period_end       TIMESTAMPTZ NOT NULL,
      cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
      canceled_at              TIMESTAMPTZ,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_vault_club_subs_user_id
      ON vault_club_subscriptions (user_id)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_vault_club_subs_status_period
      ON vault_club_subscriptions (status, current_period_end)
  `);
}
