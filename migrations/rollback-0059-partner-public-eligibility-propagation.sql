-- ROLLBACK 0059 — remove public eligibility propagation.
--
-- Reverts exactly what 0059 created: two snapshot columns on partner_public_listings, three
-- trigger/function pairs, one index, and the tightening of the public read policy.
--
-- OWNED STATE ONLY. This file touches NOTHING outside 0059's own footprint:
--   * partner_organisations and partner_locations keep every column, row, policy, grant and
--     pre-existing trigger. The only triggers removed from them are the two 0059 itself created.
--   * partner_public_listings keeps every 0058 column, its 0058 state-transition trigger, its
--     grants and its tenant policies.
--   * The public read policy is RESTORED to 0058's form rather than dropped. Leaving it absent
--     would not be a rollback — it would silently make every listing invisible to anonymous
--     traffic behind an HTTP 200, which is the failure mode 0059 exists to reason about.
--
-- ⚠️ SAFETY DIRECTION. Rolling this back re-opens HIGH C: a suspended or revoked organisation
-- becomes publicly advertised again. Do not roll back 0059 while any partner organisation is in
-- SUSPENDED or REVOKED with an ACTIVE listing without first suspending those listings by hand.

BEGIN;

-- ---- 0. DESCENDING-ORDER GUARD ----------------------------------------------------------------
-- 0059 is no longer the newest migration: 0060 denormalises the computed rating and the override
-- expiry onto the same table, and its backfill reads rows this file's propagation keeps honest.
-- Rolling 0059 back underneath 0060 would leave 0060 journalled as applied on an estate whose
-- eligibility snapshot no longer exists. Every rollback in this series carries the same guard for
-- the same reason; descending order is the supported recovery path, and each file de-journals
-- itself so that order is always reachable.
DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 59$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0059 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. Restore 0058's public read policy ----------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.partner_public_listings') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS partner_public_listings_public_read ON partner_public_listings';
    EXECUTE 'CREATE POLICY partner_public_listings_public_read ON partner_public_listings '
         || 'FOR SELECT USING (listing_status = ''ACTIVE'')';
  END IF;
END$$;

-- ---- 2. Triggers, then the functions they reference -------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.partner_public_listings') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_public_listing_stamp_eligibility ON partner_public_listings';
  END IF;
  IF to_regclass('public.partner_organisations') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_public_propagate_org_status ON partner_organisations';
  END IF;
  IF to_regclass('public.partner_locations') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_public_propagate_location_status ON partner_locations';
  END IF;
END$$;

DROP FUNCTION IF EXISTS partner_public_listing_stamp_eligibility();
DROP FUNCTION IF EXISTS partner_public_propagate_org_status();
DROP FUNCTION IF EXISTS partner_public_propagate_location_status();

-- ---- 3. Index, then the columns ---------------------------------------------------------------
DROP INDEX IF EXISTS idx_partner_public_listings_public_eligible;

ALTER TABLE partner_public_listings
  DROP COLUMN IF EXISTS org_status,
  DROP COLUMN IF EXISTS location_status;

-- ---- 4. Prove the rollback did not overreach --------------------------------------------------
DO $$
BEGIN
  -- 0058's state-transition trigger must survive untouched.
  IF to_regclass('public.partner_public_listings') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.partner_public_listings'::regclass
          AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'rollback-0059 overreached: partner_public_listings has no user triggers left.';
  END IF;

  -- The public read policy must EXIST, in 0058's form.
  IF to_regclass('public.partner_public_listings') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policy
        WHERE polrelid = 'public.partner_public_listings'::regclass
          AND polname = 'partner_public_listings_public_read') THEN
    RAISE EXCEPTION 'rollback-0059 overreached: the public read policy is gone.';
  END IF;

  -- partner_organisations / partner_locations keep their status columns.
  IF to_regclass('public.partner_organisations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='partner_organisations' AND column_name='status') THEN
    RAISE EXCEPTION 'rollback-0059 overreached: partner_organisations.status is gone.';
  END IF;
  IF to_regclass('public.partner_locations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='partner_locations' AND column_name='status') THEN
    RAISE EXCEPTION 'rollback-0059 overreached: partner_locations.status is gone.';
  END IF;
END$$;

-- ---- 5. De-journal, so the runner re-applies 0059 instead of skipping it as applied -----------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. The filename below is DATA, not a comment — a rename-by-grep would miss it.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0059_partner_public_eligibility_propagation.sql'$q$;
  END IF;
END$$;

COMMIT;
