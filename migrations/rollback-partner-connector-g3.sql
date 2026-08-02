-- ROLLBACK for the Trusted Intake Connector — Phase G3 (migration 0010_partner_connector_import).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Removes ONLY the G3 objects:
-- the two new provenance tables, the connector-scoped reference sequence, the new
-- users/submissions/submission_items grants on partner_connector_runtime, and reverts
-- partner_connector_records.state to its G2 shape (dropping 'importing' from the CHECK). Does NOT
-- touch any G1/G2/Phase 1/2 object.
--
-- CRITICAL: this script NEVER deletes or modifies any row in submissions/submission_items/users —
-- see ROLLBACK-PLAN.md "preservation of valid MintVault submissions". A submission the connector
-- created before this rollback survives, indistinguishable from any other submission; only the
-- provenance mapping that recorded where it came from is lost, which is an accepted, documented
-- consequence of rolling back the schema that stores that mapping (identical in kind to G1/G2
-- rollback already discarding connector-processing history).
--
-- Idempotent (IF EXISTS everywhere). Owner-approved protected action only; rehearse on a disposable
-- DB first.
--
-- REFUSES to run once migration 0011 (G3E reconciliation) is present — 0011 widens
-- partner_connector_records.state to permit 'reconciliation_required'/'manual_review'; this
-- script's own CHECK-constraint narrowing does not know how to migrate rows sitting in either new
-- state back down safely (unlike 'importing', both are genuinely reachable states, not merely
-- defensive), so it refuses rather than guess. Run rollback-partner-connector-g3e.sql first.
--
-- ⚠️ If the refusal fires, the aborted transaction leaves a pooled connection in "current
-- transaction is aborted" state for any further query on it — issue an explicit ROLLBACK before
-- reuse. Same caveat every earlier refusal guard in this migration family documents.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE filename = '0011_partner_connector_reconciliation.sql' AND status = 'applied'
  ) THEN
    RAISE EXCEPTION 'rollback-partner-connector-g3.sql refuses to run: migration 0011 (G3E reconciliation) is present. Run rollback-partner-connector-g3e.sql first, or use the comprehensive rollback-partner-network-phase1.sql for a full teardown.';
  END IF;
END$$;

DROP TABLE IF EXISTS partner_connector_imports CASCADE;
DROP TABLE IF EXISTS partner_connector_customer_links CASCADE;
DROP SEQUENCE IF EXISTS partner_connector_submission_ref_seq;

-- Revoke the MintVault-internal-table grants this migration added. REVOKE, unlike DROP TABLE, never
-- touches the tables' data — only partner_connector_runtime's privileges on them.
REVOKE ALL ON users            FROM partner_connector_runtime;
REVOKE ALL ON submissions      FROM partner_connector_runtime;
REVOKE ALL ON submission_items FROM partner_connector_runtime;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'submissions_id_seq') THEN
    EXECUTE 'REVOKE ALL ON SEQUENCE submissions_id_seq FROM partner_connector_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'submission_items_id_seq') THEN
    EXECUTE 'REVOKE ALL ON SEQUENCE submission_items_id_seq FROM partner_connector_runtime';
  END IF;
END$$;

-- Revert any 'importing' rows back to 'ready_for_import' before narrowing the CHECK (a genuinely
-- mid-import row should never exist given the single-transaction design, but fail safe rather than
-- assume — see IDEMPOTENCY-AND-TRANSACTION.md's crash-point table for why this is expected to be a
-- no-op in practice).
UPDATE partner_connector_records SET state = 'ready_for_import' WHERE state = 'importing';
ALTER TABLE partner_connector_records DROP CONSTRAINT IF EXISTS chk_partner_connector_records_state;
ALTER TABLE partner_connector_records ADD CONSTRAINT chk_partner_connector_records_state
  CHECK (state IN ('queued','claimed','validating','ready_for_import','rejected','failed','cancelled','imported'));

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
    SELECT m.filename, m.checksum, COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0), 'rollback-partner-connector-g3.sql'
      FROM schema_migrations m
     WHERE filename = '0010_partner_connector_import.sql'
    ON CONFLICT DO NOTHING;
  END IF;
END $ledger$;

DELETE FROM schema_migrations WHERE filename = '0010_partner_connector_import.sql';

COMMIT;
