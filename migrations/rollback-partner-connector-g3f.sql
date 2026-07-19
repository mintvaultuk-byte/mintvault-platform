-- ROLLBACK for the Trusted Intake Connector — Phase G3F (migrations
-- 0012_partner_connector_import_attempts.sql AND 0013_partner_connector_claim_index.sql).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Removes ONLY the G3F objects:
-- the append-only partner_connector_import_attempts table (0012), and reverts the claim-next index
-- (0013) back to its G1/0008 definition. Does NOT touch any G1/G2/G3/G3E/Phase 1/2 data object.
--
-- CRITICAL: never deletes or modifies any row in submissions/submission_items/users, and never
-- touches partner_connector_imports/_records/_events/_validation_runs DATA — only the new
-- append-only evidence table is removed and one index is reverted (index changes lose no data).
-- Rolling back G3F returns the audit model to the G3E state (mapping-fingerprint-only, with the
-- documented resume ambiguity) and the claim index to its 0008 form — a safe, known prior state.
-- Imported MintVault destinations survive untouched.
--
-- Idempotent (IF EXISTS everywhere). Owner-approved protected action only; rehearse on a disposable
-- DB first.

BEGIN;

-- 0012: drop the append-only evidence table.
DROP TABLE IF EXISTS partner_connector_import_attempts CASCADE;

-- 0013: revert the claim-next index to its 0008 definition (state, claim_expires_at) WHERE state IN
-- ('queued','claimed'). DROP wrapped in a DO/EXECUTE block per the same linter-safe idiom the forward
-- migration uses.
DO $$
BEGIN
  EXECUTE 'DROP INDEX IF EXISTS idx_partner_connector_records_claimable';
END$$;
CREATE INDEX IF NOT EXISTS idx_partner_connector_records_claimable
  ON partner_connector_records(state, claim_expires_at) WHERE state IN ('queued','claimed');

DELETE FROM schema_migrations WHERE filename IN (
  '0012_partner_connector_import_attempts.sql',
  '0013_partner_connector_claim_index.sql'
);

COMMIT;
