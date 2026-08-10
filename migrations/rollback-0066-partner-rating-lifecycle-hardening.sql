-- ROLLBACK 0066 — remove the rating CAS / lease / backoff / born-dirty state.
--
-- Reverts exactly what 0066 created: six columns, one CHECK constraint, one trigger and its
-- function, two indexes, and the DEFAULT flip on rating_dirty.
--
-- OWNED STATE ONLY. Every 0062 column (rating_dirty, rating_dirty_since, the attempt/success
-- timestamps, the failure count and error code) survives, as does 0062's candidate index and both
-- of its CHECK constraints. The published rating, the snapshot history and the override audit
-- trail are untouched.
--
-- ⚠️ SAFETY DIRECTION. Rolling this back reopens FIVE hostile-review findings at once, and the
-- application MUST be rolled back with it or every rating query fails with 42703:
--   H2  mark-clean loses a quality event that lands mid-calculation
--   H3  two reconcilers process the same listing (the claim they relied on was never durable)
--   H4  one permanently-failing listing occupies every bounded batch forever
--   H5  a newly approved shop is born clean and shows no rating until a human presses Recalculate
--   H6  a 180-day rolling rating never refreshes when only the clock has moved
-- None of those is an outage. All of them are silent. That combination is why this rollback is
-- documented as a last resort rather than a routine step.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 66$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0066 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. Trigger first, so the DEFAULT flip below cannot be re-forced mid-rollback -------------
DROP TRIGGER IF EXISTS trg_partner_public_listings_born_dirty ON partner_public_listings;
DROP FUNCTION IF EXISTS partner_public_listings_born_dirty();

-- ---- 2. Restore 0062's DEFAULT --------------------------------------------------------------
ALTER TABLE partner_public_listings ALTER COLUMN rating_dirty SET DEFAULT false;

-- ---- 3. Indexes, constraint, then columns ----------------------------------------------------
DROP INDEX IF EXISTS idx_partner_public_listings_rating_due;
DROP INDEX IF EXISTS idx_partner_public_listings_rating_retry;

ALTER TABLE partner_public_listings
  DROP CONSTRAINT IF EXISTS chk_partner_public_listings_rating_generations;

ALTER TABLE partner_public_listings
  DROP COLUMN IF EXISTS rating_dirty_generation,
  DROP COLUMN IF EXISTS rating_clean_generation,
  DROP COLUMN IF EXISTS rating_next_attempt_at,
  DROP COLUMN IF EXISTS rating_next_recalc_at,
  DROP COLUMN IF EXISTS rating_claimed_until,
  DROP COLUMN IF EXISTS rating_claimed_by;

-- ---- 4. Reversal assertions ------------------------------------------------------------------
DO $$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['rating_dirty_generation','rating_clean_generation','rating_next_attempt_at',
                           'rating_next_recalc_at','rating_claimed_until','rating_claimed_by'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='partner_public_listings' AND column_name=c) THEN
      RAISE EXCEPTION 'rollback-0066 failed: column % survives', c;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid='public.partner_public_listings'::regclass
                AND tgname='trg_partner_public_listings_born_dirty') THEN
    RAISE EXCEPTION 'rollback-0066 failed: the born-dirty trigger survives';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_partner_public_listings_rating_generations') THEN
    RAISE EXCEPTION 'rollback-0066 failed: the generations CHECK survives';
  END IF;

  -- NOT OURS TO REMOVE — every 0062 artefact must survive.
  FOREACH c IN ARRAY ARRAY['rating_dirty','rating_dirty_since','rating_last_attempted_at',
                           'rating_last_success_at','rating_failure_count','rating_last_error_code'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='partner_public_listings' AND column_name=c) THEN
      RAISE EXCEPTION 'rollback-0066 overreached: it removed 0062''s column %', c;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='idx_partner_public_listings_rating_dirty') THEN
    RAISE EXCEPTION 'rollback-0066 overreached: it removed 0062''s candidate index';
  END IF;
END$$;

DELETE FROM schema_migrations WHERE filename = '0066_partner_rating_lifecycle_hardening.sql';

COMMIT;
