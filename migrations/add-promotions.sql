-- Promotions engine — one active promotion at a time, DB-enforced.
-- Tier columns mirror the code's real grading checkout tier ids
-- (shared/schema.ts pricingTiers): standard (= "Vault Queue"),
-- priority (= "Standard"), express. "Black Label" is a post-grading label
-- type, NOT a checkout tier, so it is intentionally not represented here.
-- Idempotent: safe to re-run. Applied to the STAGING Neon branch only.

CREATE TABLE IF NOT EXISTS promotions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  banner_text VARCHAR(200) NOT NULL,
  standard_pct INTEGER NOT NULL DEFAULT 0 CHECK (standard_pct BETWEEN 0 AND 100),
  priority_pct INTEGER NOT NULL DEFAULT 0 CHECK (priority_pct BETWEEN 0 AND 100),
  express_pct  INTEGER NOT NULL DEFAULT 0 CHECK (express_pct  BETWEEN 0 AND 100),
  standard_coupon_id VARCHAR(100),
  priority_coupon_id VARCHAR(100),
  express_coupon_id  VARCHAR(100),
  active BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DB-ENFORCED SINGLETON: a partial unique index on (active) filtered to
-- active = true permits exactly one row with active = true at any time.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_promotion
  ON promotions ((active)) WHERE active = true;

-- Per-promo discount stacking behaviour at the grading checkout (prompt 2).
--   best_of      = charge the single LOWEST final price across
--                  {vault-club, bulk, promo}. Default; matches the locked
--                  non-stacking rule.
--   stack_on_top = apply promo AFTER the better-of(vault-club, bulk),
--                  compounding. Floored at £0.
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS stacking_mode VARCHAR(20) NOT NULL DEFAULT 'best_of'
  CHECK (stacking_mode IN ('best_of', 'stack_on_top'));
