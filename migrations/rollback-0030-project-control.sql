-- ROLLBACK for 0030_project_control.sql.
--
-- DESTRUCTIVE: drops the nine Project Control tables, their triggers and their functions, and
-- everything recorded in them (programme tree, work packages, evidence, blockers, dependencies,
-- audit history, deployment history, test history, generated prompts).
--
-- It touches NOTHING else — no certificate, grading, payment, partner, storage or Vault Quest
-- object is referenced here. MintVault runs exactly as before without them.
--
-- Running this is a protected action requiring explicit owner approval. It is NOT run by the
-- migration runner; apply it by hand only, and only deliberately.
--
-- Before running, export first:
--   GET /api/admin/project-control/export   (full JSON snapshot, super-admin session required)
--
-- DROP ORDER respects the foreign keys added in 0030: children before parents. Every table also
-- carries CASCADE-free drops so an unexpected dependency surfaces as an error rather than
-- silently removing something this script did not intend to touch.
--
-- TRANSACTIONAL. The whole teardown is one unit. The CASCADE-free drops above exist precisely so
-- an unexpected dependency raises an error; without a transaction that error would leave the
-- schema half-dismantled — some tables gone, the rest present, and the journal untouched. Wrapped,
-- an error rolls the entire teardown back and the environment is exactly as it started.

BEGIN;

-- 1. Triggers first: pc_status_events and pc_prompts refuse UPDATE/DELETE while their guards are
--    installed. DROP TABLE is not blocked by them, but removing the triggers first keeps the
--    teardown explicit and reviewable.
DROP TRIGGER IF EXISTS trg_pc_status_events_append_only ON pc_status_events;
DROP TRIGGER IF EXISTS trg_pc_status_events_stamp_time ON pc_status_events;
DROP TRIGGER IF EXISTS trg_pc_prompts_immutable ON pc_prompts;

-- 2. Leaf tables (all reference pc_work_packages).
DROP TABLE IF EXISTS pc_prompts;
DROP TABLE IF EXISTS pc_test_runs;
DROP TABLE IF EXISTS pc_deployments;
DROP TABLE IF EXISTS pc_dependencies;
DROP TABLE IF EXISTS pc_blockers;
DROP TABLE IF EXISTS pc_evidence;

-- 3. The audit ledger has no foreign key by design, so its position is free; dropped here so a
--    partial rollback still leaves the history until the very end.
DROP TABLE IF EXISTS pc_status_events;

-- 4. Work packages reference nodes; nodes reference themselves.
DROP TABLE IF EXISTS pc_work_packages;
DROP TABLE IF EXISTS pc_nodes;

-- 5. Functions last — nothing references them once the triggers and tables are gone.
DROP FUNCTION IF EXISTS pc_status_events_append_only();
DROP FUNCTION IF EXISTS pc_status_events_stamp_time();
DROP FUNCTION IF EXISTS pc_prompts_immutable();

-- 6. Retract the ledger row LAST.
--
-- The migration runner's identity is the journal row, not the presence of the tables
-- (scripts/db/migrate.ts reads schema_migrations to decide what is pending). Dropping the objects
-- without retracting the row leaves the runner permanently convinced 0030 is applied over a schema
-- that no longer exists: `db:migrate` reports 0 pending, every Project Control read fails with
-- `relation "pc_work_packages" does not exist`, and recovery needs hand-written SQL against a live
-- host during an incident. Thirteen sibling rollback scripts in this directory already retract
-- their row for exactly this reason; this one did not, which was the defect.
--
-- Guarded on the journal existing at all, so this script still runs cleanly against a database
-- that was never driven by the runner (a disposable test database, for instance).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    DELETE FROM schema_migrations WHERE filename = '0030_project_control.sql';
  END IF;
END $$;

COMMIT;
