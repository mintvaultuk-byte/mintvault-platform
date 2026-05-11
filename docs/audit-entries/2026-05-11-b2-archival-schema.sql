-- B2 cold-archive schema additions — 2026-05-11.
--
-- The migration runs automatically at startup (server/routes.ts startup
-- ALTER TABLE IF NOT EXISTS block, alongside the other additive migrations).
-- This file documents the SQL the startup migration emits, for the change-
-- log record. Operator does NOT need to run this manually — startup migration
-- handles it on first deploy of the branch.
--
-- The startup migration ALSO writes a single audit_log row on first run
-- (information_schema gate prevents duplicate audit rows on re-runs).
-- See server/routes.ts around the `[archival-b2-migrate]` block.

-- Column: cold-archive timestamp
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS archived_to_b2_at TIMESTAMP;

-- Partial index: archival candidates only. Keeps the index small as most
-- prod certs will eventually have archived_to_b2_at IS NOT NULL.
CREATE INDEX IF NOT EXISTS idx_certificates_archive_candidates
  ON certificates(grade_approved_at)
  WHERE archived_to_b2_at IS NULL AND deleted_at IS NULL;

-- Audit row written by startup migration (NOT this file — listed for reference):
--
-- INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
-- VALUES ('schema', 'certificates', 'add_column_archived_to_b2_at', 'startup_migration',
--   '{"column":"archived_to_b2_at","type":"timestamp","nullable":true,"default":null,
--     "index":"idx_certificates_archive_candidates",
--     "index_predicate":"archived_to_b2_at IS NULL AND deleted_at IS NULL",
--     "age_signal":"grade_approved_at",
--     "note":"Phase 1 cold-archive marker; see server/workers/r2-to-b2-archival.ts."}'::jsonb);
