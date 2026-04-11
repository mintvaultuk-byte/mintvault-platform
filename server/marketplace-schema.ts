/**
 * server/marketplace-schema.ts
 *
 * Idempotent startup migration for all marketplace tables and columns.
 * Called AFTER migrateAccountSchema() so the users table is fully set up.
 * Pattern matches server/account-auth.ts migrateAccountSchema().
 */

import { db } from "./db";
import { sql } from "drizzle-orm";

export async function migrateMarketplaceSchema(): Promise<void> {
  // ── Seller columns on users ───────────────────────────────────────────────
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT,
      ADD COLUMN IF NOT EXISTS seller_status TEXT DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS seller_onboarded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS seller_onboarding_lock_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS seller_kyc_completed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS seller_kyc_requirements_json JSONB,
      ADD COLUMN IF NOT EXISTS seller_payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS seller_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS seller_default_from_postcode TEXT,
      ADD COLUMN IF NOT EXISTS seller_display_name TEXT,
      ADD COLUMN IF NOT EXISTS seller_is_business BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS seller_legal_name TEXT,
      ADD COLUMN IF NOT EXISTS seller_business_number TEXT,
      ADD COLUMN IF NOT EXISTS seller_vat_number TEXT,
      ADD COLUMN IF NOT EXISTS seller_date_of_birth DATE,
      ADD COLUMN IF NOT EXISTS seller_nino_or_tin_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS seller_rating_average NUMERIC(3,2),
      ADD COLUMN IF NOT EXISTS seller_rating_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS seller_total_sales INTEGER NOT NULL DEFAULT 0
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_users_seller_status
      ON users(seller_status) WHERE seller_status <> 'none'
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_users_stripe_connect_account_id
      ON users(stripe_connect_account_id) WHERE stripe_connect_account_id IS NOT NULL
  `);

  // ── Grade strength score on certificates (internal, not displayed in UI)
  await db.execute(sql`
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade_strength_score INTEGER
  `);

  // ── Listing pointer on certificates ───────────────────────────────────────
  await db.execute(sql`
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS current_listing_id INTEGER
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_certificates_current_listing_id
      ON certificates(current_listing_id) WHERE current_listing_id IS NOT NULL
  `);

  // ── marketplace_listings ──────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id SERIAL PRIMARY KEY,
      cert_id TEXT NOT NULL,
      seller_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      price_pence INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      title TEXT NOT NULL,
      description TEXT,
      ai_description_used BOOLEAN NOT NULL DEFAULT FALSE,
      condition_notes TEXT,
      shipping_method TEXT NOT NULL DEFAULT 'royal_mail_tracked_48',
      shipping_cost_pence INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      watch_count INTEGER NOT NULL DEFAULT 0,
      listed_at TIMESTAMPTZ,
      sold_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      frozen_at TIMESTAMPTZ,
      frozen_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status ON marketplace_listings(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_listings_cert_id ON marketplace_listings(cert_id)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketplace_listings_active_cert
      ON marketplace_listings(cert_id) WHERE status IN ('draft', 'active')
  `);

  // ── marketplace_listing_images ────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_listing_images (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_listing_images_listing_id ON marketplace_listing_images(listing_id)`);

  // ── marketplace_offers ────────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_offers (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL,
      buyer_user_id TEXT NOT NULL,
      seller_user_id TEXT NOT NULL,
      amount_pence INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      counter_offer_id INTEGER,
      expires_at TIMESTAMPTZ,
      responded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_offers_listing ON marketplace_offers(listing_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_offers_buyer ON marketplace_offers(buyer_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_offers_seller ON marketplace_offers(seller_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_offers_status ON marketplace_offers(status) WHERE status = 'pending'`);

  // ── marketplace_orders ────────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_orders (
      id SERIAL PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      listing_id INTEGER NOT NULL,
      cert_id TEXT NOT NULL,
      buyer_user_id TEXT NOT NULL,
      seller_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      price_pence INTEGER NOT NULL,
      shipping_pence INTEGER NOT NULL DEFAULT 0,
      total_pence INTEGER NOT NULL,
      commission_rate NUMERIC(5,4) NOT NULL,
      commission_pence INTEGER NOT NULL,
      stripe_fee_pence INTEGER NOT NULL DEFAULT 0,
      seller_net_pence INTEGER NOT NULL,
      stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT,
      stripe_transfer_id TEXT,
      escrow_release_at TIMESTAMPTZ,
      buyer_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL,
      ship_to_name TEXT NOT NULL,
      ship_to_line1 TEXT NOT NULL,
      ship_to_line2 TEXT,
      ship_to_city TEXT NOT NULL,
      ship_to_postcode TEXT NOT NULL,
      ship_to_country TEXT NOT NULL DEFAULT 'GB',
      paid_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      refunded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer ON marketplace_orders(buyer_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller ON marketplace_orders(seller_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_listing ON marketplace_orders(listing_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status ON marketplace_orders(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_escrow_release ON marketplace_orders(escrow_release_at) WHERE status = 'delivered'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_orders_payment_intent ON marketplace_orders(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL`);

  // ── marketplace_order_events ──────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_order_events (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_order_events_order_id ON marketplace_order_events(order_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_order_events_type ON marketplace_order_events(event_type)`);

  // ── marketplace_shipments ─────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_shipments (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      carrier TEXT NOT NULL DEFAULT 'royal_mail',
      service_code TEXT,
      tracking_number TEXT,
      label_url TEXT,
      cost_pence INTEGER,
      weight_grams INTEGER,
      dispatched_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      last_tracking_event TEXT,
      last_tracking_event_at TIMESTAMPTZ,
      royal_mail_order_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_order_id ON marketplace_shipments(order_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_tracking ON marketplace_shipments(tracking_number) WHERE tracking_number IS NOT NULL`);

  // ── marketplace_conversations + marketplace_messages ──────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_conversations (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER,
      order_id INTEGER,
      buyer_user_id TEXT NOT NULL,
      seller_user_id TEXT NOT NULL,
      last_message_at TIMESTAMPTZ,
      buyer_unread_count INTEGER NOT NULL DEFAULT 0,
      seller_unread_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_buyer ON marketplace_conversations(buyer_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_seller ON marketplace_conversations(seller_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_listing ON marketplace_conversations(listing_id) WHERE listing_id IS NOT NULL`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      sender_user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_messages_conversation_id ON marketplace_messages(conversation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_messages_created_at ON marketplace_messages(created_at)`);

  // ── marketplace_reviews ───────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_reviews (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL UNIQUE,
      reviewer_user_id TEXT NOT NULL,
      reviewee_user_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_reviewee ON marketplace_reviews(reviewee_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_direction ON marketplace_reviews(direction)`);

  // ── marketplace_disputes ──────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_disputes (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      opened_by_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      resolution_notes TEXT,
      resolved_by_admin_id TEXT,
      resolved_at TIMESTAMPTZ,
      refund_amount_pence INTEGER,
      evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_disputes_order_id ON marketplace_disputes(order_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_disputes_status ON marketplace_disputes(status)`);

  // ── marketplace_watchlist ─────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_watchlist (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      listing_id INTEGER NOT NULL,
      price_alert_threshold_pence INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketplace_watchlist_user_listing
      ON marketplace_watchlist(user_id, listing_id)
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_watchlist_user ON marketplace_watchlist(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_watchlist_listing ON marketplace_watchlist(listing_id)`);

  // ── marketplace_dac7_quarterly ────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_dac7_quarterly (
      id SERIAL PRIMARY KEY,
      seller_user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      quarter INTEGER NOT NULL,
      gross_sales_pence BIGINT NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      commission_collected_pence BIGINT NOT NULL DEFAULT 0,
      last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (seller_user_id, year, quarter)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_dac7_seller ON marketplace_dac7_quarterly(seller_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_dac7_year ON marketplace_dac7_quarterly(year)`);

  // ── Tier capacity management (extend existing table) ──────────────────────
  await db.execute(sql`ALTER TABLE tier_capacity ADD COLUMN IF NOT EXISTS tier_id TEXT`);
  await db.execute(sql`ALTER TABLE tier_capacity ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`);
  await db.execute(sql`ALTER TABLE tier_capacity ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE tier_capacity ADD COLUMN IF NOT EXISTS paused_message TEXT`);
  await db.execute(sql`ALTER TABLE tier_capacity ADD COLUMN IF NOT EXISTS max_concurrent INTEGER NOT NULL DEFAULT 50`);
  await db.execute(sql`ALTER TABLE tier_capacity ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE tier_capacity ADD COLUMN IF NOT EXISTS paused_by TEXT`);

  // Backfill tier_id from tier_slug if it exists
  await db.execute(sql`UPDATE tier_capacity SET tier_id = tier_slug WHERE tier_id IS NULL AND tier_slug IS NOT NULL`);
  // Create unique index on tier_id if not exists
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tier_capacity_tier_id ON tier_capacity(tier_id) WHERE tier_id IS NOT NULL`);

  // Make legacy columns nullable
  try { await db.execute(sql`ALTER TABLE tier_capacity ALTER COLUMN max_active DROP NOT NULL`); } catch {}
  try { await db.execute(sql`ALTER TABLE tier_capacity ALTER COLUMN force_open DROP NOT NULL`); } catch {}
  try { await db.execute(sql`ALTER TABLE tier_capacity ALTER COLUMN max_active SET DEFAULT 0`); } catch {}
  try { await db.execute(sql`ALTER TABLE tier_capacity ALTER COLUMN force_open SET DEFAULT false`); } catch {}

  // Seed defaults for any missing tiers
  for (const t of [
    { id: "standard", max: 30 }, { id: "priority", max: 20 }, { id: "express", max: 15 },
    { id: "gold", max: 10 }, { id: "gold-elite", max: 5 }, { id: "reholder", max: 20 },
    { id: "crossover", max: 15 }, { id: "authentication", max: 15 },
  ]) {
    const exists = await db.execute(sql`SELECT 1 FROM tier_capacity WHERE tier_id = ${t.id} LIMIT 1`);
    if (exists.rows.length === 0) {
      await db.execute(sql`
        INSERT INTO tier_capacity (tier_id, tier_slug, status, max_concurrent, max_active, force_open, updated_at)
        VALUES (${t.id}, ${t.id}, 'open', ${t.max}, 0, false, NOW())
      `);
    }
  }

  console.log("[marketplace-schema] migration complete");
}
