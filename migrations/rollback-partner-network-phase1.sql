-- COMPREHENSIVE ROLLBACK for Partner Network Phase 1+2+G1+G2+G3 (migrations 0001–0010).
-- NOT a forward migration (no NNNN_ prefix → the runner ignores it). Destructive (drops the whole
-- partner_* family + helper functions + all THREE restricted roles: partner_runtime,
-- partner_definer, partner_connector_runtime). Owner-approved protected action only; rehearse on a
-- disposable DB first. Touches NO existing MintVault table — existing data is preserved. Idempotent
-- (IF EXISTS everywhere).
-- THIS is the ONLY script that fully rolls back the Partner Network. The 0001-only rollback refuses
-- to run once later migrations are present. For a G1-ONLY rollback (leaving Phase 1+2 intact), use
-- rollback-partner-connector-g1.sql instead.
--
-- Wrapped in a single transaction so a mid-script failure rolls the whole rollback back atomically
-- (and so it behaves identically under `psql -f` and node-postgres).

BEGIN;

-- G3 provenance tables (0010) — dropped first: deepest children (FK to partner_connector_records/
-- partner_connector_validation_runs, dropped next). Never touches submissions/submission_items/users
-- data — see ROLLBACK-PLAN.md. Grants on those MintVault-internal tables are removed below by
-- DROP OWNED BY partner_connector_runtime, not by any DELETE/UPDATE against the tables themselves.
DROP TABLE IF EXISTS partner_connector_imports CASCADE;
DROP TABLE IF EXISTS partner_connector_customer_links CASCADE;
DROP SEQUENCE IF EXISTS partner_connector_submission_ref_seq;

-- G2 validation tables (0009) — dropped next: deepest children (FK to partner_connector_records,
-- dropped next).
DROP TABLE IF EXISTS partner_connector_validation_findings CASCADE;
DROP TABLE IF EXISTS partner_connector_validation_runs CASCADE;

-- G1 connector tables (0008) — dropped next: deepest children (FK to organisations/submissions/
-- handoffs, which are dropped later below).
DROP TABLE IF EXISTS partner_connector_events CASCADE;
DROP TABLE IF EXISTS partner_connector_records CASCADE;

-- Phase 2 tables (0007) — dropped next as they are also deep children (FK to organisations/
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
  '0007_partner_submissions.sql','0008_partner_connector_foundation.sql','0009_partner_connector_validation.sql',
  '0010_partner_connector_import.sql'
);

-- restricted roles (after their objects/grants are gone). Order does not matter now that all
-- partner_* tables and functions are dropped, so none of the three roles owns any remaining object.
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
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    EXECUTE 'DROP OWNED BY partner_connector_runtime';
    DROP ROLE partner_connector_runtime;
  END IF;
END$$;

COMMIT;
