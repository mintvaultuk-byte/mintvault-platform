-- ============================================================================
-- ROLLBACK: v213 Pricing Rebuild
-- Date: 2026-04-12
-- Run this against the production database to revert all v213 changes.
-- Safe to run multiple times (idempotent).
-- ============================================================================

-- ── Revert grading tier prices and names ────────────────────────────────────
UPDATE service_tiers SET name = 'STANDARD',   price_per_card = 1200,  turnaround_days = 20, turnaround_label = '20 working days', max_value_gbp = 500,  sort_order = 1 WHERE tier_id = 'standard';
UPDATE service_tiers SET name = 'PRIORITY',   price_per_card = 1500,  turnaround_days = 10, turnaround_label = '10 working days', max_value_gbp = 1500, sort_order = 2 WHERE tier_id = 'priority';
UPDATE service_tiers SET name = 'EXPRESS',    price_per_card = 2000,  turnaround_days = 5,  turnaround_label = '5 working days',  max_value_gbp = 3000, sort_order = 3 WHERE tier_id = 'express';
UPDATE service_tiers SET name = 'GOLD',       price_per_card = 8500,  turnaround_days = 5,  turnaround_label = '5 working days',  max_value_gbp = 2500, sort_order = 4 WHERE tier_id = 'gold';

-- ── Re-activate gold-elite ──────────────────────────────────────────────────
UPDATE service_tiers SET is_active = true, name = 'GOLD ELITE', price_per_card = 12500, turnaround_days = 3, turnaround_label = '2-3 working days', max_value_gbp = 5000, sort_order = 5 WHERE tier_id = 'gold-elite';

-- ── Revert ancillary service prices ─────────────────────────────────────────
UPDATE service_tiers SET price_per_card = 800,  turnaround_days = 20, turnaround_label = '20 working days' WHERE tier_id = 'reholder';
UPDATE service_tiers SET price_per_card = 1500, turnaround_days = 20, turnaround_label = '20 working days' WHERE tier_id = 'crossover';
UPDATE service_tiers SET price_per_card = 1000, turnaround_days = 20, turnaround_label = '20 working days' WHERE tier_id = 'authentication';

-- ── Clear new columns (safe even if columns don't exist — wrap in DO block) ─
DO $$ BEGIN
  UPDATE service_tiers SET display_name = NULL, tagline = NULL, most_popular = false;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ── Drop new columns (optional — safe to leave them as NULL) ────────────────
ALTER TABLE service_tiers DROP COLUMN IF EXISTS display_name;
ALTER TABLE service_tiers DROP COLUMN IF EXISTS tagline;
ALTER TABLE service_tiers DROP COLUMN IF EXISTS most_popular;

-- ── Drop credit_type column from reholder_credits ───────────────────────────
ALTER TABLE reholder_credits DROP COLUMN IF EXISTS credit_type;

-- ── Verification queries (run after rollback to confirm) ────────────────────
-- SELECT tier_id, name, price_per_card, turnaround_days, is_active FROM service_tiers ORDER BY service_type, sort_order;
-- Expected: standard=1200, priority=1500, express=2000, gold=8500, gold-elite=12500 (active)
-- Expected: reholder=800, crossover=1500, authentication=1000
