-- ROLLBACK for the Trusted Intake Connector — Phase G1 (migration 0008_partner_connector_foundation).
-- NOT a forward migration (no NNNN_ prefix → the runner ignores it). Removes ONLY the G1 objects:
-- the two new connector tables and the new partner_connector_runtime role. Does NOT touch
-- partner_submission_handoffs, partner_submissions, partner_runtime, or any other pre-existing
-- Partner or MintVault table/role — those survive this rollback untouched. Owner-approved protected
-- action only; rehearse on a disposable DB first. Idempotent (IF EXISTS everywhere).
--
-- REFUSES to run once migration 0009 (G2 validation) is present — G2's tables FK-reference
-- partner_connector_records, so a bare CASCADE here would silently drop them and leave
-- schema_migrations claiming 0009 is still "applied" over tables that no longer exist. This is the
-- SAME refusal pattern rollback-0001-partner-foundation.sql already uses once 0002+ is present — use
-- rollback-partner-connector-g2.sql first, or the comprehensive rollback-partner-network-phase1.sql
-- for a full teardown.
--
-- Wrapped in a single transaction so a mid-script failure rolls the whole rollback back atomically
-- (and so it behaves identically under `psql -f` and node-postgres).
--
-- ⚠️ If the refusal above fires: this script's own BEGIN is never matched by a COMMIT (the RAISE
-- aborts first), which leaves the CONNECTION's session in "current transaction is aborted" state for
-- any further query on that same connection. `psql -f` closes the connection on exit, so this is a
-- non-issue there; a caller reusing a pooled/long-lived connection (e.g. a test suite chaining this
-- script programmatically) MUST issue an explicit `ROLLBACK` before reusing that connection — see
-- tests/partner-connector-migration.test.ts's refusal test for the exact pattern.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.partner_connector_validation_runs') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-partner-connector-g1.sql refuses to run: migration 0009 (G2 validation) is present and depends on partner_connector_records. Run rollback-partner-connector-g2.sql first, or use the comprehensive rollback-partner-network-phase1.sql for a full teardown.';
  END IF;
END$$;

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

-- ROLLBACK LEDGER — mint the reapply marker BEFORE retracting the journal row.
--
-- The numbered runner refuses a pending migration numbered below the highest applied, because that
-- is how a stale branch lands a schema change underneath later ones. A deliberate rollback creates
-- the same shape, so without this the runner cannot tell "the operator just backed this out" from
-- "a stale branch turned up", and re-applying what was just removed is impossible.
--
-- The checksum is copied FROM the journal row — what was genuinely applied to THIS database — never
-- hashed from disk, so a migration edited at any point after it was applied fails the comparison.
-- watermark_at_rollback pins the journal as it stands right now: the marker dies the moment any
-- other migration is applied, which keeps this an "undo, then immediately redo" window rather than
-- a standing licence.
--
-- Guarded on the ledger existing so this script still runs against a database built by an older
-- runner. A hand-deleted schema_migrations row mints nothing and stays refused.
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_rollbacks') IS NOT NULL THEN
    INSERT INTO schema_migration_rollbacks (filename, checksum, watermark_at_rollback, batch)
    SELECT m.filename, m.checksum, COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0), 'rollback-partner-connector-g1.sql'
      FROM schema_migrations m
     WHERE filename = '0008_partner_connector_foundation.sql'
    ON CONFLICT DO NOTHING;
  END IF;
END $ledger$;

DELETE FROM schema_migrations WHERE filename = '0008_partner_connector_foundation.sql';

COMMIT;
