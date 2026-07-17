-- ROLLBACK for migrations/0001_partner_foundation.sql (Partner Network Phase 1).
-- NOT a forward migration: the filename has no NNNN_ prefix, so the numbered runner ignores it.
-- Destructive (drops the partner_* family + restricted role). Owner-approved protected action
-- only; rehearse on a disposable DB first (see MASTER-ROLLBACK-PLAN.md). Touches no existing
-- MintVault table. Order respects FKs (children before parents).
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
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    -- DROP OWNED removes every privilege/default-priv the role still holds anywhere, so DROP ROLE
    -- cannot fail on a lingering grant. Safe: partner_runtime owns no data objects.
    EXECUTE 'DROP OWNED BY partner_runtime';
    DROP ROLE partner_runtime;
  END IF;
END$$;
