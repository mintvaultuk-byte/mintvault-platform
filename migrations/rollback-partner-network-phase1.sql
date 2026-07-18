-- COMPREHENSIVE ROLLBACK for Partner Network Phase 1+2 (migrations 0001–0007).
-- NOT a forward migration (no NNNN_ prefix → the runner ignores it). Destructive (drops the whole
-- partner_* family + helper functions + BOTH restricted roles partner_runtime and partner_definer).
-- Owner-approved protected action only; rehearse on a disposable DB first. Touches NO existing
-- MintVault table — existing data is preserved. Idempotent (IF EXISTS everywhere).
-- THIS is the ONLY script that fully rolls back the Partner Network. The 0001-only rollback refuses
-- to run once later migrations are present.
--
-- Wrapped in a single transaction so a mid-script failure rolls the whole rollback back atomically
-- (and so it behaves identically under `psql -f` and node-postgres).

BEGIN;

-- Phase 2 tables (0007) — dropped first as they are the deepest children (FK to organisations/
-- locations/users, which are dropped later below).
DROP TABLE IF EXISTS partner_submission_handoffs CASCADE;
DROP TABLE IF EXISTS partner_submission_events CASCADE;
DROP TABLE IF EXISTS partner_submission_cards CASCADE;
DROP TABLE IF EXISTS partner_submissions CASCADE;
DROP TABLE IF EXISTS partner_service_tiers CASCADE;
DROP TABLE IF EXISTS partner_customers CASCADE;

DROP TABLE IF EXISTS partner_recovery_codes CASCADE;
DROP TABLE IF EXISTS partner_password_reset_tokens CASCADE;
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

-- helper functions (SECURITY DEFINER lookups + tenant reader)
DROP FUNCTION IF EXISTS partner_reset_token_tenant(text);
DROP FUNCTION IF EXISTS partner_session_lookup(text);
DROP FUNCTION IF EXISTS partner_auth_lookup(text);
DROP FUNCTION IF EXISTS partner_current_tenant();

-- migration journal rows for the partner migrations (so they can be re-applied cleanly)
DELETE FROM schema_migrations WHERE filename IN (
  '0001_partner_foundation.sql','0002_partner_auth_support.sql','0003_partner_auth_hardening.sql',
  '0004_partner_mfa_enrol.sql','0005_partner_mfa_replay_and_grants.sql','0006_partner_definer_role.sql',
  '0007_partner_submissions.sql'
);

-- restricted roles (after their objects/grants are gone). Order does not matter now that all
-- partner_* tables and functions are dropped, so neither role owns any remaining object.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_definer') THEN
    EXECUTE 'DROP OWNED BY partner_definer';   -- removes any residual grants/memberships
    DROP ROLE partner_definer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    EXECUTE 'DROP OWNED BY partner_runtime';
    DROP ROLE partner_runtime;
  END IF;
END$$;

COMMIT;
