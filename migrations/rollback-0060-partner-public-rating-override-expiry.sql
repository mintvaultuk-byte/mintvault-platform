-- ROLLBACK 0060 — remove read-time rating-override expiry.
--
-- Reverts exactly what 0060 created: five denormalised columns on partner_public_listings and one
-- partial index.
--
-- OWNED STATE ONLY. This file touches NOTHING outside 0060's own footprint:
--   * partner_public_rating_overrides is untouched — 0060 never wrote to it, never retired a row
--     and never deleted one. Every override record, its reason, actor, created_at and expires_at
--     survive this rollback exactly as they were.
--   * partner_public_listings keeps every 0058 and 0059 column, its triggers, policies and grants.
--     The current_* effective rating columns 0058 created are NOT touched: the public rating that
--     was being served before 0060 is the same one served after this rollback.
--
-- ⚠️ SAFETY DIRECTION. Rolling this back re-opens HIGH B: an expired override becomes publicly
-- effective again, indefinitely, until a Super Admin presses Recalculate. Before rolling back,
-- list any listing with an active-but-expired override and recalculate it by hand:
--
--   SELECT l.slug, o.expires_at
--     FROM partner_public_listings l
--     JOIN partner_public_rating_overrides o ON o.listing_id = l.id AND o.removed_at IS NULL
--    WHERE l.current_rating_is_override IS TRUE AND o.expires_at IS NOT NULL AND o.expires_at <= now();

BEGIN;

-- ---- 1. Index, then the columns ---------------------------------------------------------------
DROP INDEX IF EXISTS idx_partner_public_listings_override_expiry;

ALTER TABLE partner_public_listings
  DROP COLUMN IF EXISTS current_override_expires_at,
  DROP COLUMN IF EXISTS current_computed_public_rating,
  DROP COLUMN IF EXISTS current_computed_rating_label,
  DROP COLUMN IF EXISTS current_computed_rating_available,
  DROP COLUMN IF EXISTS current_computed_rating_version;

-- ---- 2. Prove the rollback did not overreach --------------------------------------------------
DO $$
BEGIN
  -- The 0058 effective-rating columns must all survive.
  IF to_regclass('public.partner_public_listings') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='partner_public_listings'
         AND column_name='current_public_rating') THEN
      RAISE EXCEPTION 'rollback-0060 overreached: current_public_rating is gone.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='partner_public_listings'
         AND column_name='current_rating_is_override') THEN
      RAISE EXCEPTION 'rollback-0060 overreached: current_rating_is_override is gone.';
    END IF;
    -- 0059's eligibility snapshot must survive too.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='partner_public_listings'
         AND column_name='org_status') THEN
      RAISE EXCEPTION 'rollback-0060 overreached: 0059 org_status is gone.';
    END IF;
  END IF;

  -- The override history must be intact and untouched.
  IF to_regclass('public.partner_public_rating_overrides') IS NULL THEN
    RAISE EXCEPTION 'rollback-0060 overreached: partner_public_rating_overrides is gone.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_public_rating_overrides'
       AND column_name='expires_at') THEN
    RAISE EXCEPTION 'rollback-0060 overreached: partner_public_rating_overrides.expires_at is gone.';
  END IF;
END$$;

-- ---- 3. De-journal, so the runner re-applies 0060 instead of skipping it as applied -----------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. The filename below is DATA, not a comment — a rename-by-grep would miss it.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0060_partner_public_rating_override_expiry.sql'$q$;
  END IF;
END$$;

COMMIT;
