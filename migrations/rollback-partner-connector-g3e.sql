-- ROLLBACK for the Trusted Intake Connector — Phase G3E (migration
-- 0011_partner_connector_reconciliation.sql).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Reverts
-- partner_connector_records.state to its G3 shape (dropping 'reconciliation_required' and
-- 'manual_review' from the CHECK). No table/sequence/grant to drop — 0011 added no new object,
-- only widened one CHECK constraint. Does NOT touch any G1/G2/G3/Phase 1/2 object, and never
-- deletes or modifies any row in submissions/submission_items/users.
--
-- Idempotent. Owner-approved protected action only; rehearse on a disposable DB first.

BEGIN;

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
