-- ROLLBACK 0062 — remove rating dirty/retry state.
--
-- Reverts exactly what 0062 created: six columns, two CHECK constraints and one partial index.
--
-- OWNED STATE ONLY. This file touches NOTHING outside 0062's own footprint:
--   * Every 0058 effective-rating column, every 0059 eligibility column and every 0060
--     override-expiry column survives. The published rating is unaffected by this rollback.
--   * partner_public_rating_snapshots and partner_public_rating_overrides are untouched: the
--     rating history and the override audit trail are not this migration's to remove.
--   * 0061's reader role and projections survive; they never referenced these columns (0062
--     asserts that they must not).
--
-- ⚠️ SAFETY DIRECTION. Rolling this back returns rating refresh to being a manual Super Admin
-- button: nothing will mark a shop dirty and the reconciler has nothing to select, so published
-- ratings freeze at their last computed value. That is stale, not wrong — the last good rating
-- stays public and correct-as-of-then — but it stops tracking reality. The application must be
-- rolled back alongside it, or the dirty-marking writes will fail with 42703.

BEGIN;

-- ---- 0. DESCENDING-ORDER GUARD ----------------------------------------------------------------
DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 62$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0062 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. Index, constraints, then columns ------------------------------------------------------
DROP INDEX IF EXISTS idx_partner_public_listings_rating_dirty;

ALTER TABLE partner_public_listings
  DROP CONSTRAINT IF EXISTS chk_partner_public_listings_rating_dirty_since,
  DROP CONSTRAINT IF EXISTS chk_partner_public_listings_rating_failure_count;

ALTER TABLE partner_public_listings
  DROP COLUMN IF EXISTS rating_dirty,
  DROP COLUMN IF EXISTS rating_dirty_since,
  DROP COLUMN IF EXISTS rating_last_attempted_at,
  DROP COLUMN IF EXISTS rating_last_success_at,
  DROP COLUMN IF EXISTS rating_failure_count,
  DROP COLUMN IF EXISTS rating_last_error_code;

-- ---- 2. Prove the rollback did not overreach --------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.partner_public_listings') IS NULL THEN
    RAISE EXCEPTION 'rollback-0062 overreached: partner_public_listings is gone.';
  END IF;
  -- The published rating and every gate that governs it must survive.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_public_listings'
       AND column_name='current_public_rating') THEN
    RAISE EXCEPTION 'rollback-0062 overreached: current_public_rating is gone.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_public_listings'
       AND column_name='org_status') THEN
    RAISE EXCEPTION 'rollback-0062 overreached: 0059 org_status is gone.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_public_listings'
       AND column_name='current_override_expires_at') THEN
    RAISE EXCEPTION 'rollback-0062 overreached: 0060 current_override_expires_at is gone.';
  END IF;
  -- The rating history and the override audit trail are not this rollback's to remove.
  IF to_regclass('public.partner_public_rating_snapshots') IS NULL THEN
    RAISE EXCEPTION 'rollback-0062 overreached: the rating snapshot history is gone.';
  END IF;
  IF to_regclass('public.partner_public_rating_overrides') IS NULL THEN
    RAISE EXCEPTION 'rollback-0062 overreached: the override audit trail is gone.';
  END IF;
END$$;

-- ---- 3. De-journal, so the runner re-applies 0062 instead of skipping it as applied -----------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. The filename below is DATA, not a comment — a rename-by-grep would miss it.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0062_partner_rating_dirty_state.sql'$q$;
  END IF;
END$$;

COMMIT;
