-- ROLLBACK 0058 — remove the MintVault Public Partner Network schema.
--
-- Reverts exactly what 0058 created: three tables, their policies, indexes, constraints, the
-- listing state-transition trigger and its function, and the two UNIQUE INDEXes 0058 added to
-- partner_locations as composite-FK targets.
--
-- OWNED STATE ONLY. This file touches NOTHING outside 0058's own footprint:
--   * partner_locations keeps every column, row, policy and grant it had. The only things removed
--     from it are the two indexes 0058 itself created (uq_partner_public_listings_tenant_location
--     and, on the listings table, uq_partner_public_listings_tenant_id).
--   * certificates and every origin_* column are untouched. Public-address history and certificate
--     provenance are independent by design, and rolling back the public network must not disturb
--     a single certificate.
--   * No role is dropped and no grant belonging to another migration is revoked. Dropping the
--     tables removes their grants with them; nothing else is touched.
--
-- DATA LOSS IS REAL AND INTENTIONAL. Dropping partner_public_listings destroys every approved
-- public identity, every rating snapshot and every Super Admin override. That is correct for a
-- rollback of an additive feature — the operational partner records, the certificates and their
-- origin snapshots all survive, so nothing that a customer or a partner depends on is lost. But an
-- operator running this on an estate with live listings is deleting HQ approval decisions, so the
-- guard below refuses unless the operator explicitly opts in.
--
-- The numbered runner never executes rollback files (it matches ^\d{4,}_.+\.sql$), so this is run
-- by an operator with `psql -v ON_ERROR_STOP=1 -f`, and must carry its own transaction and its own
-- lock bound. This is the opposite of the forward migration, which must NOT open a transaction.
--
-- DESCENDING-ORDER GUARD: deliberately omitted, matching 0050/0051/0052/0054/0055/0056/0057. 0058
-- is the newest migration and nothing structurally depends on it. If a later migration is ever
-- added that references partner_public_listings, THAT migration's rollback must run first, and
-- this file's FK-dependency drop order below will surface the problem as a loud FK error rather
-- than silent corruption.
--
-- OPT-IN FOR A POPULATED ESTATE:
--   psql -v ON_ERROR_STOP=1 -v allow_public_network_data_loss=1 -f rollback-0058-...sql
-- Without the variable the file refuses when any listing row exists. On an empty estate (a test
-- round trip, or a rollback immediately after apply) it proceeds unprompted, which is what
-- tests/partner-rollback-integrity.test.ts requires.

BEGIN;

-- ---- 0. DESCENDING-ORDER GUARD ----------------------------------------------------------------
-- 0058 is no longer the newest migration: 0059 adds columns to partner_public_listings and 0060
-- adds more. DROP TABLE below would take those columns with it while 0059/0060 remain journalled as
-- applied, so the runner would never restore them — a silently half-rolled-back estate that reports
-- green. Every rollback in this series carries the same guard for the same reason; descending order
-- is the supported recovery path, and each file de-journals itself so that order is always reachable.
DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 58$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0058 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
-- partner_locations is read on the partner authentication and location-switch paths, and this file
-- takes a lock on it to drop the composite-FK target index. An unbounded wait here would queue
-- partner logins behind this rollback.
SET LOCAL lock_timeout = '5s';

-- ---- 0. Refuse to silently destroy live HQ approval decisions --------------------------------
DO $$
DECLARE
  listing_rows bigint := 0;
  opt_in text := '';
BEGIN
  IF to_regclass('public.partner_public_listings') IS NULL THEN
    RETURN; -- already rolled back, or never applied; nothing to protect
  END IF;

  EXECUTE 'SELECT count(*) FROM partner_public_listings' INTO listing_rows;
  IF listing_rows = 0 THEN
    RETURN;
  END IF;

  -- current_setting(..., true) returns NULL rather than raising when the variable was not passed.
  opt_in := coalesce(current_setting('allow_public_network_data_loss', true), '');
  IF opt_in NOT IN ('1', 'true', 'yes', 'on') THEN
    RAISE EXCEPTION
      'rollback-0058 refused: % public listing(s) exist. Dropping them destroys Super Admin approval decisions, rating history and overrides. Re-run with -v allow_public_network_data_loss=1 to confirm.',
      listing_rows;
  END IF;
END$$;

-- ---- 1. Drop in FK-dependency order: children first -------------------------------------------
-- Overrides and snapshots both reference partner_public_listings, so they must go first or the
-- listing drop is blocked. Each is guarded so a partially-rolled-back estate is a no-op rather
-- than an error.
DROP TABLE IF EXISTS partner_public_rating_overrides;
DROP TABLE IF EXISTS partner_public_rating_snapshots;

-- Dropping the table removes its own triggers, policies, indexes, constraints and grants with it.
DROP TABLE IF EXISTS partner_public_listings;

-- ---- 2. The trigger FUNCTION is not owned by the table and must be dropped explicitly ---------
-- DROP TABLE removes the trigger but leaves the function behind. A stranded plpgsql function in
-- `public` would also be swept by the unpinned-function class check in
-- tests/partner-rollback-integrity.test.ts, so leaving it is not merely untidy.
DROP FUNCTION IF EXISTS partner_public_listing_transition_guard();

-- ---- 3. The composite-FK target index 0058 added to partner_locations -------------------------
-- 0058 created this ON partner_locations (a table it does not own) purely to provide the
-- (tenant_id, id) target for fk_partner_public_listings_location_tenant. With the listings table
-- gone nothing references it, so it is 0058's to remove. NOTHING ELSE on partner_locations is
-- touched — idx_partner_locations_tenant (0001) and every other index survive.
--
-- Named explicitly rather than by pattern: a pattern could match an index a later migration added.
DROP INDEX IF EXISTS uq_partner_public_listings_tenant_location;

-- ---- 3b. The recent-cards index 0058 added to certificates -----------------------------------
-- 0058 created this ON certificates (a table it does not own) to serve the public shop profile's
-- "recent cards" query. It is index-only: no column, constraint, trigger or row on certificates is
-- touched by 0058 or by this file. 0035's idx_certificates_origin_partner and the origin
-- immutability trigger are NOT this file's to remove, and the proof below asserts they survive.
DROP INDEX IF EXISTS idx_certificates_origin_location_recent;

-- ---- 4. Prove the reversal before committing --------------------------------------------------
DO $$
DECLARE
  leftovers text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO leftovers
    FROM unnest(ARRAY[
      'partner_public_listings','partner_public_rating_snapshots','partner_public_rating_overrides'
    ]) AS t
   WHERE to_regclass('public.' || t) IS NOT NULL;
  IF leftovers IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0058 incomplete: table(s) still present: %', leftovers;
  END IF;

  IF to_regprocedure('public.partner_public_listing_transition_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0058 incomplete: partner_public_listing_transition_guard() still present.';
  END IF;

  IF to_regclass('public.uq_partner_public_listings_tenant_location') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0058 incomplete: composite-FK target index still present on partner_locations.';
  END IF;

  IF to_regclass('public.idx_certificates_origin_location_recent') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0058 incomplete: recent-cards index still present on certificates.';
  END IF;

  -- And prove we did NOT overreach: partner_locations must still exist with its 0001 index, and
  -- the certificates origin facility must be exactly as 0035 left it. A rollback that quietly took
  -- a neighbour's index or trigger with it is worse than one that failed.
  IF to_regclass('public.partner_locations') IS NULL THEN
    RAISE EXCEPTION 'rollback-0058 overreached: partner_locations was removed.';
  END IF;
  IF to_regclass('public.idx_partner_locations_tenant') IS NULL THEN
    RAISE EXCEPTION 'rollback-0058 overreached: idx_partner_locations_tenant (owned by 0001) was removed.';
  END IF;
  IF to_regclass('public.certificates') IS NOT NULL
     AND to_regclass('public.idx_certificates_origin_partner') IS NULL THEN
    RAISE EXCEPTION 'rollback-0058 overreached: idx_certificates_origin_partner (owned by 0035) was removed.';
  END IF;
  IF to_regclass('public.certificates') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_certificates_origin_immutable'
          AND tgrelid = 'public.certificates'::regclass) THEN
    RAISE EXCEPTION 'rollback-0058 overreached: the 0035 certificate-origin immutability trigger is gone.';
  END IF;
END$$;

-- ---- 5. De-journal, so the runner re-applies 0058 instead of skipping it as applied -----------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. The filename below is DATA, not a comment — a rename-by-grep would miss it.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0058_partner_public_network.sql'$q$;
  END IF;
END$$;

COMMIT;
