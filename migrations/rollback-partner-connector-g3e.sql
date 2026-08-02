-- ROLLBACK for the Trusted Intake Connector — Phase G3E (migration
-- 0011_partner_connector_reconciliation.sql).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Reverts
-- partner_connector_records.state to its G3 shape (dropping 'reconciliation_required' and
-- 'manual_review' from the CHECK). No table/sequence/grant to drop — 0011 added no new object,
-- only widened one CHECK constraint. Does NOT touch any G1/G2/G3/Phase 1/2 object, and never
-- deletes or modifies any row in submissions/submission_items/users.
--
-- Idempotent. Owner-approved protected action only; rehearse on a disposable DB first.
--
-- REFUSES to run once migration 0012 (G3F import-attempt evidence) is present — 0012's table
-- FK-references partner_connector_records/partner_connector_imports/partner_connector_validation_runs
-- (all of which survive this G3E rollback, so 0012 would not be orphaned by dependency), but the
-- reconciliation states this rollback narrows away are part of the state model 0012's evidence
-- assumes; refuse and require the G3F rollback first so the teardown order stays unambiguous. Same
-- refusal-guard pattern every earlier rollback in this family uses.
--
-- WARNING: if the refusal fires, this BEGIN is never matched by a COMMIT — the connection's session
-- is left in "aborted transaction" state; a caller reusing a pooled connection must issue an
-- explicit ROLLBACK before reuse (see tests/partner-connector-migration.test.ts for the pattern).

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE filename = '0012_partner_connector_import_attempts.sql' AND status = 'applied'
  ) THEN
    RAISE EXCEPTION 'rollback-partner-connector-g3e.sql refuses to run: migration 0012 (G3F import-attempt evidence) is present. Run rollback-partner-connector-g3f.sql first, or use the comprehensive rollback-partner-network-phase1.sql for a full teardown.';
  END IF;
END$$;

-- Revert any 'reconciliation_required'/'manual_review' rows back to a G3-legal state before
-- narrowing the CHECK. Both are genuinely reachable states (unlike 'importing'), so this is not
-- purely defensive — pick the safest available fallback: 'reconciliation_required' rows return to
-- 'ready_for_import' (the state they were in before reconciliation flagged them; their mapping
-- row, if any, is untouched by this rollback and still reflects the true state), 'manual_review'
-- rows return to 'failed' (the closest existing G1 state meaning "needs attention, not currently
-- progressing").
UPDATE partner_connector_records SET state = 'ready_for_import' WHERE state = 'reconciliation_required';
UPDATE partner_connector_records SET state = 'failed' WHERE state = 'manual_review';
ALTER TABLE partner_connector_records DROP CONSTRAINT IF EXISTS chk_partner_connector_records_state;
ALTER TABLE partner_connector_records ADD CONSTRAINT chk_partner_connector_records_state
  CHECK (state IN ('queued','claimed','validating','ready_for_import','importing','rejected','failed','cancelled','imported'));

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
    SELECT m.filename, m.checksum, COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0), 'rollback-partner-connector-g3e.sql'
      FROM schema_migrations m
     WHERE filename = '0011_partner_connector_reconciliation.sql'
    ON CONFLICT DO NOTHING;
  END IF;
END $ledger$;

DELETE FROM schema_migrations WHERE filename = '0011_partner_connector_reconciliation.sql';

COMMIT;
