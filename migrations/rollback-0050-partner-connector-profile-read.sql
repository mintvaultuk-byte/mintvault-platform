-- ROLLBACK for 0050_partner_connector_profile_read.sql.
--
-- Deliberately NOT numbered: scripts/db/migrate.ts only discovers `NNNN_*.sql`, so the runner can
-- never apply this file by accident. It is applied by hand by an operator, exactly like every other
-- migrations/rollback-*.sql in this repo.
--
-- WHAT IT UNDOES: the single column-level SELECT grant 0050 issued. Nothing else — 0050 creates no
-- object and modifies no row, so there is nothing else to undo.
--
-- ⚠️ OPERATIONAL WARNING. After this runs, server/partner/connector-import-service.ts's origin
-- snapshot query fails with 42501 (permission denied for table partner_profiles) and EVERY partner
-- connector import aborts and rolls back. That is the intended fail-closed behaviour — an import
-- that cannot read the approved trading name must not mint a certificate with the wrong one, since
-- migration 0035's ENABLE ALWAYS trigger makes the snapshot unfixable afterwards. Only run this
-- alongside reverting the application to a build whose importer does not read partner_profiles.

DO $$
BEGIN
  IF to_regclass('public.partner_profiles') IS NULL THEN
    RAISE NOTICE 'rollback-0050: partner_profiles absent — nothing to revoke.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    RAISE NOTICE 'rollback-0050: partner_connector_runtime absent — nothing to revoke.';
    RETURN;
  END IF;

  -- Column-scoped revoke only. A blanket `REVOKE ALL ON partner_profiles` would also strip
  -- privileges granted by other migrations to other roles.
  EXECUTE 'REVOKE SELECT (tenant_id, trading_name) ON partner_profiles FROM partner_connector_runtime';

  IF has_column_privilege('partner_connector_runtime', 'public.partner_profiles', 'trading_name', 'SELECT') THEN
    RAISE EXCEPTION
      'rollback-0050 assertion failed: partner_connector_runtime can still SELECT partner_profiles.trading_name (a table-level grant from elsewhere may be in play).';
  END IF;

  RAISE NOTICE 'rollback-0050: revoked partner_connector_runtime SELECT on partner_profiles(tenant_id, trading_name).';
END$$;
