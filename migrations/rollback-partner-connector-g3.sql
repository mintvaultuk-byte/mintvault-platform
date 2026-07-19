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

BEGIN;

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

DELETE FROM schema_migrations WHERE filename = '0010_partner_connector_import.sql';

COMMIT;
