-- ROLLBACK for 0039 — Project Control durable live evidence.
--
-- Hand-run only. The migration runner never picks this up: its filename does not match the
-- `NNNN_name.sql` pattern, so it cannot be applied as a forward migration by accident.
--
-- SCOPE: drops only the four `pc_*` tables 0039 created, their indexes (dropped with the tables),
-- and the append-only trigger function. It does NOT touch migration 0030's nine tables, and it
-- touches nothing outside the `pc_` namespace.
--
-- WHAT YOU LOSE, STATED PLAINLY
-- -----------------------------
-- Every recorded observation and every sync-run audit row. That is EVIDENCE HISTORY — the answer
-- to "when did staging start running this commit?" and "who triggered that refresh?". It is not
-- recoverable by re-running a sync: a sync can only observe the present, so the past is gone.
--
-- Nothing else depends on it. No pre-existing table has a foreign key into these, the programme
-- structure in 0030's tables is untouched, and the dashboard degrades to the transient
-- per-request behaviour it had before 0039 — UNKNOWN where it would have shown history, never a
-- false success.
--
-- EXPORT FIRST if the history matters:
--   \copy (SELECT * FROM pc_evidence_snapshots ORDER BY id) TO 'pc_evidence_snapshots.csv' CSV HEADER
--   \copy (SELECT * FROM pc_sync_runs ORDER BY id)          TO 'pc_sync_runs.csv' CSV HEADER
--
-- The append-only trigger blocks UPDATE and DELETE on rows, not DROP TABLE, so the drop below
-- succeeds without disarming anything first. That is deliberate: the trigger protects history
-- from a buggy writer, not from a deliberate, reviewed rollback.

BEGIN;

DROP TABLE IF EXISTS pc_evidence_snapshots;
DROP TABLE IF EXISTS pc_sync_checkpoints;
DROP TABLE IF EXISTS pc_sync_leases;
DROP TABLE IF EXISTS pc_sync_runs;

-- Dropped only after its sole table is gone.
DROP FUNCTION IF EXISTS pc_evidence_snapshots_append_only();

DO $$
DECLARE
  remaining TEXT := '';
BEGIN
  IF to_regclass('public.pc_evidence_snapshots') IS NOT NULL THEN remaining := remaining || 'pc_evidence_snapshots '; END IF;
  IF to_regclass('public.pc_sync_checkpoints')   IS NOT NULL THEN remaining := remaining || 'pc_sync_checkpoints '; END IF;
  IF to_regclass('public.pc_sync_leases')        IS NOT NULL THEN remaining := remaining || 'pc_sync_leases '; END IF;
  IF to_regclass('public.pc_sync_runs')          IS NOT NULL THEN remaining := remaining || 'pc_sync_runs '; END IF;
  IF remaining <> '' THEN
    RAISE EXCEPTION 'rollback-0039 incomplete: still present: %', remaining;
  END IF;

  -- 0030's tables must be untouched. A rollback that took them out would be a catastrophe
  -- disguised as a clean exit, so it is checked rather than assumed.
  IF to_regclass('public.pc_nodes') IS NULL OR to_regclass('public.pc_work_packages') IS NULL THEN
    RAISE EXCEPTION 'rollback-0039 damaged migration 0030 state — pc_nodes/pc_work_packages are missing. Investigate before proceeding.';
  END IF;

  RAISE NOTICE 'rollback-0039 complete: 4 tables and 1 function removed; migration 0030 intact.';
END $$;

-- Retract the ledger row LAST.
--
-- The runner's identity is the journal row, not the presence of the tables (scripts/db/migrate.ts
-- reads schema_migrations to decide what is pending). Dropping the objects without retracting the
-- row leaves the runner permanently convinced 0039 is applied over a schema that no longer exists:
-- `db:migrate` reports 0 pending, every live-evidence read fails with `relation
-- "pc_evidence_snapshots" does not exist`, and recovery needs hand-written SQL against a live host
-- during an incident. This is the identical defect that was fixed in rollback-0030 on this branch;
-- rollback-0040 already retracts its row. This script was the remaining omission.
--
-- Guarded on the journal existing at all, so this script still runs cleanly against a disposable
-- test database that was never driven by the runner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    DELETE FROM schema_migrations WHERE filename = '0039_project_control_live_evidence.sql';
  END IF;
END $$;

COMMIT;
