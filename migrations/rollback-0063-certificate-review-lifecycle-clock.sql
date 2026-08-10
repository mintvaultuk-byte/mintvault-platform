-- ROLLBACK 0063 — remove the certificate review-lifecycle clock.
--
-- Reverts exactly what 0063 created: two columns on `certificates`.
--
-- NO INDEX IS DROPPED HERE. 0063 builds none — the reviewed-unit index lives in 0065 and is
-- removed by rollback-0065, which drops it CONCURRENTLY. Descending order (0065 then 0064 then
-- 0063) is the supported path and the guard below enforces it.
--
-- OWNED STATE ONLY. This file touches NOTHING outside 0063's own footprint:
--   * 0058's idx_certificates_origin_location_recent survives — 0063 did not create it and does
--     not own it.
--   * Every 0035 origin column survives, and the 0035 ENABLE ALWAYS immutability trigger is not
--     touched. Certificate provenance is unaffected.
--   * No grading column, no grade, no sub-grade, no timestamp used by the MVGS engine is touched.
--
-- ⚠️ status_updated_at IS DROPPED BY THIS FILE, AND THAT NEEDS SAYING PLAINLY. 0063 created it,
-- so 0063's rollback removes it — but on staging and production the column ALSO exists because
-- server/routes.ts runs `ADD COLUMN IF NOT EXISTS status_updated_at` at boot, and one route
-- writes it. Dropping it here therefore removes a column the running application expects.
-- On those hosts the column is recreated automatically on the next boot (empty), so the failure
-- mode is "the shipping-status timestamps are lost", not "the application 500s forever". If that
-- data matters on the host you are rolling back, set MV_ROLLBACK_0063_KEEP_STATUS_UPDATED_AT
-- before running (see the guard below) and drop only the review clock.
--
-- ⚠️ SAFETY DIRECTION for review_entered_at. Rolling this back returns the rating engine's rolling
-- window to dating abandoned units from `issued_at` — i.e. it REOPENS BLOCKER B1. The application
-- must be rolled back alongside it, or the rating measurement will fail with 42703. That is the
-- safe direction (the rating fails loudly and the listing stays dirty; grading is unaffected),
-- but it is an outage of the rating, not a graceful degradation.

BEGIN;

-- ---- 0. DESCENDING-ORDER GUARD ----------------------------------------------------------------
DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 63$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0063 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. Bound the lock wait -------------------------------------------------------------------
-- Every statement below takes ACCESS EXCLUSIVE on `certificates` — which blocks READS as well as
-- writes, i.e. the public certificate-verification surface. Rollback files are never executed by
-- scripts/db/migrate.ts (its FILE_RE matches only NNNN_*.sql), so the runner's 5s default does NOT
-- apply here and an unbounded wait would be genuinely unbounded. 2s, matching 0063 itself.
SET LOCAL lock_timeout = '2s';

-- ---- 2. Columns -------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN RETURN; END IF;

  EXECUTE 'ALTER TABLE certificates DROP COLUMN IF EXISTS review_entered_at';

  -- Opt-out for the boot-time-DDL collision described in the header.
  IF coalesce(current_setting('mv.rollback_0063_keep_status_updated_at', true), '') = '' THEN
    EXECUTE 'ALTER TABLE certificates DROP COLUMN IF EXISTS status_updated_at';
  ELSE
    RAISE NOTICE 'rollback-0063: keeping certificates.status_updated_at on request';
  END IF;
END$$;

-- ---- 3. Reversal assertions -------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='certificates' AND column_name='review_entered_at') THEN
    RAISE EXCEPTION 'rollback-0063 failed: certificates.review_entered_at survives';
  END IF;

  -- NOT OURS TO REMOVE — prove we did not overreach.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='certificates' AND column_name='origin_location_id')
     AND to_regclass('public.idx_certificates_origin_location_recent') IS NULL THEN
    RAISE EXCEPTION 'rollback-0063 overreached: it removed 0058''s idx_certificates_origin_location_recent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='certificates' AND column_name='origin_location_id') THEN
    RAISE EXCEPTION 'rollback-0063 overreached: certificates.origin_location_id was removed';
  END IF;
END$$;

DELETE FROM schema_migrations WHERE filename = '0063_certificate_review_lifecycle_clock.sql';

COMMIT;
