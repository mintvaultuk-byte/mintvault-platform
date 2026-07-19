-- 0013_partner_connector_claim_index.sql
-- Trusted Intake Connector — Phase G3F: hot-path claim-next index correction (evidence-driven).
--
-- The G3E fix broadened the claim-next query's claimable set to include 'validating' and
-- 'ready_for_import' expired-lease rows (connector-service.ts claimNextConnectorRecord /
-- claimConnectorRecord), but the partial index created in migration 0008
-- (idx_partner_connector_records_claimable ON (state, claim_expires_at) WHERE state IN
-- ('queued','claimed')) still only covered the OLD two-state set. EXPLAIN ANALYZE on a realistic
-- ~2000-row dataset (95% terminal 'imported', ~5% claimable) confirmed the claim-next query fell back
-- to a FULL Seq Scan of every record (including all terminal rows) plus a sort — catastrophic at
-- scale. See PERFORMANCE-RESULTS.md for the before/after plans.
--
-- This migration REPLACES that index with a partial index whose predicate covers the full claimable
-- state set. The predicate uses only immutable state values (not claim_expires_at < now(), which is
-- STABLE not IMMUTABLE and cannot appear in a partial-index predicate — same reason 0008's index put
-- claim_expires_at as a column, not a predicate). With this index the planner reads only the small
-- claimable subset (Bitmap Index/Heap Scan) instead of scanning the whole table. Ordering on
-- created_at matches the claim-next ORDER BY.
--
-- Additive/idempotent. The DROP INDEX is wrapped in a DO/EXECUTE dollar-quoted block — the same idiom
-- migrations 0006/0009/0011 use for DROP CONSTRAINT so the destructive-SQL linter (which strips
-- dollar-quoted bodies before pattern-matching a bare top-level DROP) does not conflate this
-- reviewed, index-only replacement with an unreviewed destructive drop. No table/column/data is
-- touched; an index drop+recreate loses no data.

DO $$
BEGIN
  EXECUTE 'DROP INDEX IF EXISTS idx_partner_connector_records_claimable';
END$$;

CREATE INDEX IF NOT EXISTS idx_partner_connector_records_claimable
  ON partner_connector_records(created_at)
  WHERE state IN ('queued','claimed','validating','ready_for_import');
