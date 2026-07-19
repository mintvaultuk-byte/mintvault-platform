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

DELETE FROM schema_migrations WHERE filename = '0011_partner_connector_reconciliation.sql';

COMMIT;
