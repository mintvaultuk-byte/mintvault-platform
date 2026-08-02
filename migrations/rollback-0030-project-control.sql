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
--
-- ROLLBACK ORDER IS MANDATORY: 0040 -> 0039 -> 0030.
--
-- 0030 is the BASE migration. 0039 (live evidence) and 0040 (seed reconciliation) build on it,
-- and running this file while either is still applied used to succeed SILENTLY. The CASCADE-free
-- drops do not catch it: 0040's only reference into this schema is
-- fk_pc_work_packages_superseded_by, which is SELF-referencing on pc_work_packages and is
-- therefore dropped with the table rather than raising. 0039's four tables reference nothing here
-- at all.
--
-- The result was the worst kind of half-teardown: pc_sync_*, pc_evidence_snapshots, pc_seed_state
-- and pc_seed_runs left orphaned, the 0039 and 0040 journal rows left claiming to be applied, and
-- only 0030's row retracted. A later `db:migrate --apply` would then re-apply 0030 ALONE —
-- recreating pc_work_packages WITHOUT the supersession columns while the journal insists 0040 is
-- applied. Every seed-repository query naming superseded_at then fails at runtime. That is the
-- canonical "journal says applied, column does not exist" trap, reached through the rollback door.
--
-- rollback-0039 already asserts the state of ITS neighbour (it refuses when pc_nodes /
-- pc_work_packages are missing). This is the mirror-image guard that was absent.
--
-- The check runs BEFORE any DROP and raises, so a wrong-order attempt performs zero destructive
-- writes. It is inside the transaction, so even the RAISE leaves nothing behind.

BEGIN;

-- 0. ORDER PRECONDITION — refuse while a dependent migration is still applied.
--    Named precisely, so the operator is told which file to run first rather than "something is
--    wrong". Checks the SCHEMA (to_regclass), not the journal: a table that exists is the fact
--    that matters here, and a hand-edited journal must not be able to unlock a destructive drop.
DO $$
DECLARE
  dependent TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF to_regclass('public.pc_seed_state')        IS NOT NULL THEN dependent := array_append(dependent, 'pc_seed_state');        END IF;
  IF to_regclass('public.pc_seed_runs')         IS NOT NULL THEN dependent := array_append(dependent, 'pc_seed_runs');         END IF;
  IF to_regclass('public.pc_sync_runs')         IS NOT NULL THEN dependent := array_append(dependent, 'pc_sync_runs');         END IF;
  IF to_regclass('public.pc_sync_leases')       IS NOT NULL THEN dependent := array_append(dependent, 'pc_sync_leases');       END IF;
  IF to_regclass('public.pc_sync_checkpoints')  IS NOT NULL THEN dependent := array_append(dependent, 'pc_sync_checkpoints');  END IF;
  IF to_regclass('public.pc_evidence_snapshots') IS NOT NULL THEN dependent := array_append(dependent, 'pc_evidence_snapshots'); END IF;

  IF array_length(dependent, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 0030: dependent migration objects are still present (%). Roll back in order 0040 -> 0039 -> 0030: run migrations/rollback-0040-project-control-seed-reconciliation.sql, then migrations/rollback-0039-project-control-live-evidence.sql, then this file. Nothing has been dropped.',
      array_to_string(dependent, ', ');
  END IF;
END $$;

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
