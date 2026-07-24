-- Print Workflow Lifecycle — Approval → Printing → Printed → Completed.
--
-- ADDITIVE ONLY. No column is repurposed; no data is dropped, deleted or moved.
-- Runs inside the runner's default transaction (no CONCURRENTLY, no
-- migrate:no-transaction directive needed).
--
-- MIGRATION NUMBER: 0022. On origin/main the latest applied migration is 0018.
-- Numbers 0019/0020/0021 are claimed by UNMERGED branches (partner submission
-- credit lifecycle, grading optimistic concurrency, project control dashboard,
-- partner auth/shop). 0022 is chosen because it is free across every active
-- worktree, so the runner's duplicate-number hard-reject can never fire when
-- this branch merges — whatever order those branches land in. If 0019–0021
-- never merge, the gap is harmless: the runner applies present files in numeric
-- order and does not require contiguity.
--
-- Adds the three approved print-workflow structures and nothing else:
--   1. certificates.print_state       — explicit print lifecycle state
--   2. print_batches                  — durable batch records
--   3. print_events                   — append-only audit ledger (never deleted)
-- Plus a one-time historical BACKFILL of print_state so the column is the single
-- source of truth immediately (not derived at read time).
--
-- AUTHORITY (see docs/print-workflow/AUTHORITY.md):
--   certificates.print_state is authoritative for the print lifecycle. It is
--   written by (a) this backfill for historical rows and (b) the grade-approval
--   transaction going forward. label_prints / reprint_log remain compatibility/
--   cache surfaces; print_events is append-only historical evidence.
--
-- ROLLBACK (manual, destructive to print history — do NOT run casually):
--   -- Removes all recorded print batches + the append-only audit ledger.
--   DROP TABLE IF EXISTS print_events;
--   DROP TABLE IF EXISTS print_batches;
--   ALTER TABLE certificates DROP COLUMN IF EXISTS print_state;
--   The feature is additive and isolated: reverting the application code leaves
--   these objects in place, unread and harmless. Prefer that over dropping —
--   dropping discards the print audit trail. No existing column is altered, so
--   there is nothing to restore.

-- 1) Explicit print lifecycle state on certificates.
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

-- 4) Historical backfill so print_state is authoritative immediately.
--    Only touches rows still at the 'awaiting_approval' default, so re-running
--    (or running after some rows already advanced) never regresses a live state.
--    Approved + already physically printed → 'printed'; approved + not printed →
--    'needs_printing'. Unapproved / voided / deleted rows stay 'awaiting_approval'.
--
--    Wrapped in a DO block guarded on the real certificates/label_prints columns
--    existing. In production both exist and the backfill runs. In an isolated test
--    fixture that only stubs `certificates` (no grade columns / no label_prints),
--    PL/pgSQL never plans the guarded statements, so the migration still applies
--    cleanly without contorting the production DDL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'certificates' AND column_name = 'grade_approved_at')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'label_prints')
  THEN
    UPDATE certificates c
    SET print_state = 'printed'
    WHERE c.print_state = 'awaiting_approval'
      AND c.grade_approved_at IS NOT NULL
      AND c.deleted_at IS NULL
      AND c.status <> 'voided'
      AND EXISTS (
        SELECT 1 FROM label_prints lp
        WHERE lp.cert_id = c.certificate_number AND lp.printed_at IS NOT NULL
      );

    UPDATE certificates c
    SET print_state = 'needs_printing'
    WHERE c.print_state = 'awaiting_approval'
      AND c.grade_approved_at IS NOT NULL
      AND c.deleted_at IS NULL
      AND c.status <> 'voided';
  END IF;
END $$;
