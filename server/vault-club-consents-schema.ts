/**
 * server/vault-club-consents-schema.ts
 *
 * Phase 1 Step 5d — Vault Club sign-up consent ledger (schema half).
 *
 * Idempotent CREATE TABLE IF NOT EXISTS for vault_club_consents. Mirrors
 * the Drizzle definition in shared/schema.ts. Pattern matches
 * server/vault-club-reminders-schema.ts — runs at startup, additive,
 * safe to call repeatedly.
 *
 * Wired into the startup chain in server/routes.ts after
 * migrateSubscriptionRemindersSchema(). On first boot of a deploy that
 * includes this code, the table + index get created. Subsequent boots
 * are no-ops.
 *
 * What this file is for (per docs/dmcc-step5-audit.md Section 2 + the
 * uk-subscription-compliance skill, lines 48-51, 246-247):
 *
 *   - Capture explicit, un-pre-ticked consent at the moment of
 *     subscription sign-up. DMCC requires "specific action" by the
 *     consumer — not inferred consent.
 *   - Pin the consent to the TERMS_VERSION the user actually saw,
 *     plus a hash of the literal consent text. Both ensure that a
 *     post-hoc terms change can't retroactively rewrite what the
 *     user agreed to.
 *   - Record IP + user-agent + timestamp for evidentiary value if a
 *     consumer or regulator disputes a charge.
 *   - Provide a back-reference from Stripe Customer metadata
 *     (vault_club_consent_id) so a Stripe-side audit can land on the
 *     consent row directly.
 *
 * Append-only ledger with ONE permitted post-creation mutation:
 *   - The Stripe Customer + Session ids are attached AFTER the
 *     Checkout Session creation succeeds (UPDATE … COALESCE …, set
 *     once, never overwritten). All other columns are immutable
 *     after INSERT.
 *
 * What this file is NOT (deferred, see commit 5h):
 *   - Cooling-off-right waiver / proportionate-charge mechanics —
 *     committing to the disclosure today would require building the
 *     proportionate-charge refund logic that doesn't exist yet.
 *   - Re-consent flow on TERMS_VERSION bump for existing members
 *     (Phase 2).
 *
 * Schema reminder (full definition in shared/schema.ts):
 *
 *   id                  uuid PK, gen_random_uuid()
 *   user_id             varchar NOT NULL, FK users.id ON DELETE CASCADE
 *   terms_version       text NOT NULL  (TERMS_VERSION at consent time)
 *   consent_text_hash   text NOT NULL  (sha256 of TERMS_VERSION::TEXT)
 *   interval            text NOT NULL  (CHECK: month, year)
 *   stripe_customer_id  text nullable  (set post-creation)
 *   stripe_session_id   text nullable  (set post-creation)
 *   ip_address          inet nullable
 *   user_agent          text nullable
 *   captured_at         timestamptz NOT NULL DEFAULT NOW()
 *
 * Indexes:
 *   vault_club_consents_user_idx — (user_id, captured_at DESC) for
 *     "latest consent per user" lookups (e.g. DSAR export, regulator
 *     audit "what did this user agree to and when?").
 */

import { db } from "./db";
import { sql } from "drizzle-orm";

export async function migrateVaultClubConsentsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS vault_club_consents (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      terms_version       TEXT NOT NULL,
      consent_text_hash   TEXT NOT NULL,
      interval            TEXT NOT NULL CHECK (interval IN ('month', 'year')),
      stripe_customer_id  TEXT,
      stripe_session_id   TEXT,
      ip_address          INET,
      user_agent          TEXT,
      captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Hot path: "latest consent for this user" — DSAR exports, regulator
  // audit lookups, and the (Phase 2) re-consent-on-version-bump check
  // all want this ordering.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS vault_club_consents_user_idx
      ON vault_club_consents (user_id, captured_at DESC)
  `);
}
