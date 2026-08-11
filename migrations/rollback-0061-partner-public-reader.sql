-- ROLLBACK 0061 — remove the least-privileged public reader and its projections.
--
-- Reverts exactly what 0061 created: two views, and every privilege held by the reader role.
-- The ROLE itself is left in place — see section 2 for why dropping a cluster-wide role from a
-- database-scoped rollback is the wrong move.
--
-- OWNED STATE ONLY. This file touches NOTHING outside 0061's own footprint:
--   * certificates and partner_public_listings keep every column, row, policy, grant and trigger.
--     0061 only ever read them through views; it never altered either table.
--   * partner_runtime, partner_connector_runtime, partner_definer and
--     partner_credit_lifecycle_definer are untouched.
--   * The 0059 eligibility columns and the 0060 override-expiry columns survive — the views read
--     them, they do not own them.
--
-- ⚠️ SAFETY DIRECTION. Rolling this back re-opens HIGH A: anonymous Shop Finder / public profile
-- traffic returns to the BYPASSRLS admin pool, which also means public load can again consume
-- privileged capacity. The application must be rolled back to a build that does not expect
-- PARTNER_PUBLIC_DATABASE_URL, or its public endpoints will fail closed with 503 — which is the
-- correct direction, but it is an outage of the public site, not a silent degradation.

BEGIN;

-- ---- 0. DESCENDING-ORDER GUARD ----------------------------------------------------------------
DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 61$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0061 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. Views (grants go with them) -----------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'DROP VIEW IF EXISTS partner_public_shop_projection';
  EXECUTE 'DROP VIEW IF EXISTS partner_public_card_projection';
END$$;

-- ---- 2. The role — REVOKED, deliberately NOT dropped ------------------------------------------
-- A PostgreSQL role is CLUSTER-wide, not database-scoped. Dropping it here would reach outside this
-- migration's own database and could break any other database in the same cluster that still has
-- 0061 applied — and the migrator, being NOSUPERUSER, may not even hold ADMIN on a role another
-- database's migrator created, so the DROP fails and takes the whole descending rollback with it.
--
-- Revoking every privilege leaves the role inert: it can reach nothing, which is the state that
-- actually matters. Re-applying 0061 finds the role already present and re-grants it, so the round
-- trip is still exact.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_public_reader') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA public FROM partner_public_reader';
  END IF;
END$$;

-- ---- 3. Prove the rollback did not overreach --------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION 'rollback-0061 overreached: certificates is gone.';
  END IF;
  IF to_regclass('public.partner_public_listings') IS NULL THEN
    RAISE EXCEPTION 'rollback-0061 overreached: partner_public_listings is gone.';
  END IF;
  -- 0059 and 0060 columns must survive: this rollback owns neither.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_public_listings' AND column_name='org_status') THEN
    RAISE EXCEPTION 'rollback-0061 overreached: 0059 org_status is gone.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_public_listings'
       AND column_name='current_override_expires_at') THEN
    RAISE EXCEPTION 'rollback-0061 overreached: 0060 current_override_expires_at is gone.';
  END IF;
  -- The other partner roles must survive.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    RAISE EXCEPTION 'rollback-0061 overreached: partner_runtime is gone.';
  END IF;
END$$;

-- ---- 4. De-journal, so the runner re-applies 0061 instead of skipping it as applied -----------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. The filename below is DATA, not a comment — a rename-by-grep would miss it.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0061_partner_public_reader.sql'$q$;
  END IF;
END$$;

COMMIT;
