-- ROLLBACK for the Trusted Intake Connector — Phase G1 (migration 0008_partner_connector_foundation).
-- NOT a forward migration (no NNNN_ prefix → the runner ignores it). Removes ONLY the G1 objects:
-- the two new connector tables and the new partner_connector_runtime role. Does NOT touch
-- partner_submission_handoffs, partner_submissions, partner_runtime, or any other pre-existing
-- Partner or MintVault table/role — those survive this rollback untouched. Owner-approved protected
-- action only; rehearse on a disposable DB first. Idempotent (IF EXISTS everywhere).
--
-- Wrapped in a single transaction so a mid-script failure rolls the whole rollback back atomically
-- (and so it behaves identically under `psql -f` and node-postgres).

BEGIN;

DROP TABLE IF EXISTS partner_connector_events CASCADE;
DROP TABLE IF EXISTS partner_connector_records CASCADE;

-- partner_connector_runtime also holds READ-ONLY grants on the two pre-existing tables it validates
-- against (partner_submission_handoffs, partner_submissions — migration 0008) and schema USAGE.
-- DROP TABLE above does not revoke grants a role holds on OTHER tables, so DROP ROLE would fail with
-- "cannot be dropped because some objects depend on it" unless those grants are revoked first.
-- DROP OWNED BY revokes every privilege granted TO this role (it owns no objects, so nothing is
-- actually dropped by this call beyond the grants) — fail closed if the role still can't be dropped
-- afterwards, rather than silently leaving an orphaned privilege.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    EXECUTE 'DROP OWNED BY partner_connector_runtime';
    DROP ROLE partner_connector_runtime;
  END IF;
END$$;

DELETE FROM schema_migrations WHERE filename = '0008_partner_connector_foundation.sql';

COMMIT;
