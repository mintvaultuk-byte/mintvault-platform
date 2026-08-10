-- ROLLBACK 0064 — remove the anonymous slab-image projection.
--
-- Reverts exactly what 0064 created that is SAFE to remove: one view and its grant.
--
-- ⚠️ THE TWO COLUMNS ARE DELIBERATELY NOT DROPPED, AND THAT IS NOT AN OVERSIGHT.
-- 0064 created `grading_front_cropped` and `grading_front_display` with ADD COLUMN IF NOT EXISTS
-- because no migration owned them, not because 0064 introduced them. On staging and production
-- they already held data written by four call sites (server/routes.ts:7658, 7860, 10046 and
-- server/scan-ingest-service.ts:758) long before this migration existed, and
-- `grading_front_cropped` is additionally recreated by boot-time DDL on every start.
--
-- Dropping them here would therefore destroy live image-key data that 0064 did not create, to
-- undo a migration whose actual contribution was a VIEW. A rollback that deletes data it did not
-- write is not a rollback. The columns stay; the reversal assertion below proves the view and the
-- grant are gone, which is the whole of 0064's own footprint.
--
-- ⚠️ SAFETY DIRECTION. Rolling this back returns the anonymous slab-image route to having no
-- public-reader projection to read. The APPLICATION MUST BE ROLLED BACK ALONGSIDE IT: the
-- re-platformed route queries this view on the bounded public pool, and without it every public
-- slab image 503s (fail closed — it will NOT silently fall back to the privileged pool; that
-- fallback is the defect 0064 exists to close, and server/partner/db.ts refuses it by design).
--
-- Public card scans disappearing from the showcase is recoverable in one deploy. Anonymous
-- traffic quietly returning to the owner connection is not, which is why the failure direction
-- is the one chosen.

BEGIN;

-- ---- 0. DESCENDING-ORDER GUARD ----------------------------------------------------------------
DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 64$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0064 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. The view (the grant goes with it) -----------------------------------------------------
DROP VIEW IF EXISTS public_slab_image_projection;

-- ---- 2. Reversal assertions -------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.public_slab_image_projection') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0064 failed: public_slab_image_projection survives';
  END IF;

  -- NOT OURS TO REMOVE — prove we did not overreach on either neighbour.
  IF to_regclass('public.certificates') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='certificates' AND column_name='front_image_path') THEN
      RAISE EXCEPTION 'rollback-0064 overreached: certificates.front_image_path was removed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='certificates' AND column_name='grading_front_display') THEN
      RAISE EXCEPTION 'rollback-0064 overreached: it dropped grading_front_display, which it did not create';
    END IF;
  END IF;
  IF to_regclass('public.partner_public_card_projection') IS NULL
     AND to_regclass('public.certificates') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0064 overreached: it removed 0061''s partner_public_card_projection';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_public_reader')
     AND has_table_privilege('partner_public_reader', 'public.certificates', 'SELECT') THEN
    RAISE EXCEPTION 'rollback-0064 left partner_public_reader with direct SELECT on certificates';
  END IF;
END$$;

DELETE FROM schema_migrations WHERE filename = '0064_public_slab_image_projection.sql';

COMMIT;
