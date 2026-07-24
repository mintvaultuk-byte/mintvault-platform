-- add-print-workflow-schema.sql
-- Print workflow lifecycle (Approval → Printing → Printed → Completed).
-- ADDITIVE + IDEMPOTENT ONLY. No DROP / no data change to existing columns.
-- This file is the checked-in record; the live application is performed by the
-- boot-time idempotent migratePrintWorkflowSchema() in server/print-workflow.ts
-- (same pattern every recent certificates column used). NOT YET APPLIED to any DB.
--
-- Pre-apply requirement (repo has live≠code drift history): inventory the target
-- DB's information_schema for `certificates.print_state`, `print_batches`, and
-- `print_events` before applying, per mintvault-db-migration-discipline.

-- 1) Explicit print lifecycle state on certificates (distinct from status/grader_status).
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS print_state VARCHAR(24) NOT NULL DEFAULT 'awaiting_approval';

CREATE INDEX IF NOT EXISTS idx_certificates_print_state ON certificates (print_state);

-- 2) Durable print batch records.
CREATE TABLE IF NOT EXISTS print_batches (
  id              SERIAL PRIMARY KEY,
  batch_id        TEXT NOT NULL UNIQUE,
  kind            VARCHAR(12) NOT NULL DEFAULT 'batch',
  status          VARCHAR(12) NOT NULL DEFAULT 'open',
  cert_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  cert_count      INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,
  created_by_role VARCHAR(16),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  printed_at      TIMESTAMP,
  notes           TEXT,
  reason          TEXT,
  reason_category VARCHAR(24),
  layout_version  TEXT
);

CREATE INDEX IF NOT EXISTS idx_print_batches_status ON print_batches (status);
CREATE INDEX IF NOT EXISTS idx_print_batches_created_at ON print_batches (created_at);

-- 3) Append-only print event ledger (never deleted).
CREATE TABLE IF NOT EXISTS print_events (
  id              SERIAL PRIMARY KEY,
  cert_id         TEXT NOT NULL,
  batch_id        TEXT,
  actor           TEXT NOT NULL,
  actor_role      VARCHAR(16),
  action          VARCHAR(24) NOT NULL,
  from_state      VARCHAR(24),
  to_state        VARCHAR(24),
  reason          TEXT,
  reason_category VARCHAR(24),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_print_events_cert ON print_events (cert_id);
CREATE INDEX IF NOT EXISTS idx_print_events_batch ON print_events (batch_id);
CREATE INDEX IF NOT EXISTS idx_print_events_created_at ON print_events (created_at);
