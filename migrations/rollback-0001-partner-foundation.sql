-- ROLLBACK for migrations/0001_partner_foundation.sql ONLY (Partner Network Phase 1).
-- NOT a forward migration: the filename has no NNNN_ prefix, so the numbered runner ignores it.
-- Destructive (drops the partner_* family + restricted role). Owner-approved protected action
-- only; rehearse on a disposable DB first (see MASTER-ROLLBACK-PLAN.md). Touches no existing
-- MintVault table. Order respects FKs (children before parents).
--
-- ⚠️ DB-F2 GUARD: this script rolls back ONLY 0001. It is NOT a full Phase-1 rollback. If any later
-- Partner migration (0002–0006) is applied, a CASCADE here would silently orphan their objects and
-- desync the journal. It therefore REFUSES to run in that case — use
-- migrations/rollback-partner-network-phase1.sql for a full Phase-1 rollback.
--
-- The guard AND the destructive statements live in a SINGLE PL/pgSQL DO block, so the whole script
-- is ONE statement: if the guard RAISEs, nothing else in the block runs — and there is no separate
-- following statement for psql to execute. This makes the guard SELF-PROTECTING in every invocation
-- mode: `psql -f` with or without `-v ON_ERROR_STOP=1`, and node-postgres — with no risk of leaving
-- an aborted-open transaction on the connection. (Because the drops are inside a dollar-quoted body
-- the regex destructive-SQL linter does not flag this file; that is acceptable — the numbered runner
-- never executes it, and the full-phase rollback keeps bare DROPs that the linter still blocks.)
DO $$
BEGIN
  -- refuse-guard
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'schema_migrations')
     AND EXISTS (
       SELECT 1 FROM schema_migrations
        WHERE filename IN (
          '0002_partner_auth_support.sql','0003_partner_auth_hardening.sql',
          '0004_partner_mfa_enrol.sql','0005_partner_mfa_replay_and_grants.sql',
          '0006_partner_definer_role.sql','0007_partner_submissions.sql')
     ) THEN
    RAISE EXCEPTION
      'rollback-0001 is a 0001-ONLY rollback, but later Partner migrations (0002+) are applied. Use migrations/rollback-partner-network-phase1.sql for a full Phase 1 rollback.';
  END IF;

  -- destructive rollback of 0001 (children → parents)
  DROP TABLE IF EXISTS partner_emergency_controls CASCADE;
  DROP TABLE IF EXISTS partner_security_events CASCADE;
  DROP TABLE IF EXISTS partner_audit_events CASCADE;
  DROP TABLE IF EXISTS partner_feature_flags CASCADE;
  DROP TABLE IF EXISTS partner_mfa_methods CASCADE;
  DROP TABLE IF EXISTS partner_sessions CASCADE;
  DROP TABLE IF EXISTS partner_user_roles CASCADE;
  DROP TABLE IF EXISTS partner_user_locations CASCADE;
  DROP TABLE IF EXISTS partner_users CASCADE;
  DROP TABLE IF EXISTS partner_locations CASCADE;
  DROP TABLE IF EXISTS partner_organisations CASCADE;
  DROP TABLE IF EXISTS partner_role_permissions CASCADE;
  DROP TABLE IF EXISTS partner_permissions CASCADE;
  DROP TABLE IF EXISTS partner_roles CASCADE;
  -- the fail-closed tenant-context helper (created by the forward migration)
  DROP FUNCTION IF EXISTS partner_current_tenant();
  -- Remove the migration journal row so the forward migration can be re-applied cleanly.
  DELETE FROM schema_migrations WHERE filename = '0001_partner_foundation.sql';
  -- Revoke + drop the restricted role (after its objects are gone).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    EXECUTE 'DROP OWNED BY partner_runtime';
    DROP ROLE partner_runtime;
  END IF;
END$$;
