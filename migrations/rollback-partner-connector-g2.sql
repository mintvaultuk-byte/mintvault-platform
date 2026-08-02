-- ROLLBACK for the Trusted Intake Connector — Phase G2 (migration 0009_partner_connector_validation).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Removes ONLY the G2 objects:
-- the two new validation tables, and reverts partner_connector_records.state to its G1 shape
-- (dropping 'ready_for_import' from the CHECK, restoring 'awaiting_validation'). Does NOT touch
-- partner_connector_records data beyond that CHECK-constraint reversion, and does not touch any
-- Phase 1/2 table, partner_connector_events, or any MintVault-internal table. Owner-approved
-- protected action only; rehearse on a disposable DB first. Idempotent (IF EXISTS everywhere).
--
-- REFUSES to run once migration 0010 (G3 import) is present — G3's partner_connector_imports FK-
-- references partner_connector_validation_runs, so a bare DROP here would silently orphan it. Same
-- refusal pattern rollback-partner-connector-g1.sql already uses once 0009+ is present — use
-- rollback-partner-connector-g3.sql first, or the comprehensive rollback-partner-network-phase1.sql.
--
-- ⚠️ If the refusal fires, the aborted transaction leaves a pooled connection in "current transaction
-- is aborted" state for any further query on it — issue an explicit ROLLBACK before reuse. Same
-- caveat rollback-partner-connector-g1.sql documents.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.partner_connector_imports') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-partner-connector-g2.sql refuses to run: migration 0010 (G3 import) is present and depends on partner_connector_validation_runs. Run rollback-partner-connector-g3.sql first, or use the comprehensive rollback-partner-network-phase1.sql for a full teardown.';
  END IF;
END$$;

DROP TABLE IF EXISTS partner_connector_validation_findings CASCADE;
DROP TABLE IF EXISTS partner_connector_validation_runs CASCADE;

-- Revert any 'ready_for_import' rows back to 'awaiting_validation' before narrowing the CHECK,
-- else the constraint reversion below would fail on any row still in the new-named state.
UPDATE partner_connector_records SET state = 'awaiting_validation' WHERE state = 'ready_for_import';
ALTER TABLE partner_connector_records DROP CONSTRAINT IF EXISTS chk_partner_connector_records_state;
ALTER TABLE partner_connector_records ADD CONSTRAINT chk_partner_connector_records_state
  CHECK (state IN ('queued','claimed','validating','awaiting_validation','rejected','failed','cancelled','imported'));

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
    SELECT m.filename, m.checksum, COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0), 'rollback-partner-connector-g2.sql'
      FROM schema_migrations m
     WHERE filename = '0009_partner_connector_validation.sql'
    ON CONFLICT DO NOTHING;
  END IF;
END $ledger$;

DELETE FROM schema_migrations WHERE filename = '0009_partner_connector_validation.sql';

COMMIT;
