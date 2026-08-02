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
    SELECT m.filename, m.checksum, COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0), 'rollback-partner-connector-g3f.sql'
      FROM schema_migrations m
     WHERE filename IN (
  '0012_partner_connector_import_attempts.sql',
  '0013_partner_connector_claim_index.sql'
)
    ON CONFLICT DO NOTHING;
  END IF;
END $ledger$;

DELETE FROM schema_migrations WHERE filename IN (
  '0012_partner_connector_import_attempts.sql',
  '0013_partner_connector_claim_index.sql'
);

COMMIT;
