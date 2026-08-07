-- rollback-0047-partner-owner-invariant-tenants-rls.sql
--
-- ⚠️  THIS ROLLBACK RE-OPENS A HIGH-SEVERITY TENANT-ISOLATION HOLE (A8-F1). Running it returns
-- partner_owner_invariant_tenants to the state 0032 left it in: no RLS, no policy, and a live
-- SELECT + INSERT grant to partner_runtime, so every partner session can again enumerate every
-- tenant UUID on the network and pin any other tenant into the owner invariant. Run it only to
-- unblock an incident, and re-apply 0047 immediately afterwards.
--
-- Journal guard: refuse while any migration numbered above 47 is journalled, so this file cannot be
-- run underneath 0048 or 0049. The threshold is always this file's OWN number; if this file is ever
-- renumbered, the integer moves with it.

BEGIN;

DO $$
DECLARE
  later_migrations bigint := 0;
BEGIN
  -- Reach the journal only through EXECUTE: PL/pgSQL plans a whole IF expression up front, so a
  -- direct reference raises 42P01 on any database that has no schema_migrations table.
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 47$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0047 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;

  IF to_regclass('public.partner_owner_invariant_tenants') IS NULL THEN
    RAISE NOTICE 'rollback-0047: partner_owner_invariant_tenants absent; nothing to do.';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS partner_owner_invariant_tenants_tenant_isolation
    ON partner_owner_invariant_tenants;
  ALTER TABLE partner_owner_invariant_tenants NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE partner_owner_invariant_tenants DISABLE ROW LEVEL SECURITY;
END$$;

-- Prove the reversal actually happened rather than trusting the DDL above.
DO $$
DECLARE
  enabled boolean;
  npolicy integer;
BEGIN
  IF to_regclass('public.partner_owner_invariant_tenants') IS NULL THEN
    RETURN;
  END IF;

  SELECT c.relrowsecurity INTO enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'partner_owner_invariant_tenants';
  IF enabled THEN
    RAISE EXCEPTION 'rollback-0047: ROW LEVEL SECURITY is still enabled';
  END IF;

  SELECT count(*) INTO npolicy
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_owner_invariant_tenants';
  IF npolicy <> 0 THEN
    RAISE EXCEPTION 'rollback-0047: % policy row(s) survive', npolicy;
  END IF;
END$$;

COMMIT;
