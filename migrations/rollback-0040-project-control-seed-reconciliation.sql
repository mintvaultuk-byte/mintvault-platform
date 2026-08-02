-- ROLLBACK for 0040_project_control_seed_reconciliation.sql.
--
-- DESTRUCTIVE: drops the seed-state and reconciliation-run history, and removes the supersession
-- columns from pc_work_packages.
--
-- WHAT IS LOST, STATED PLAINLY: every record of which seed version this database holds, every
-- reconciliation attempt, and every supersession link. The work packages themselves SURVIVE — a
-- superseded package becomes an ordinary package again, which means it will look like active work
-- until the next reconciliation retires it. Export the reconciliation history first if it matters.
--
-- It touches nothing outside the objects 0040 created. No certificate, grading, payment, partner,
-- storage or Vault Quest object is referenced. Migrations 0030 and 0039 are untouched.
--
-- Running this is a protected action requiring explicit owner approval. It is NOT run by the
-- migration runner; apply it by hand only, and only deliberately.
--
-- TRANSACTIONAL, for the same reason as rollback-0030: the drops below are CASCADE-free so an
-- unexpected dependency surfaces as an error rather than silently removing something this script
-- did not intend to touch. Without a transaction that error would leave the schema half-dismantled.

BEGIN;

-- 1. Constraints and index on pc_work_packages first, so the columns can be dropped cleanly.
ALTER TABLE pc_work_packages DROP CONSTRAINT IF EXISTS pc_work_packages_supersede_complete;
ALTER TABLE pc_work_packages DROP CONSTRAINT IF EXISTS fk_pc_work_packages_superseded_by;
ALTER TABLE pc_work_packages DROP CONSTRAINT IF EXISTS pc_work_packages_supersede_not_self;
DROP INDEX IF EXISTS idx_pc_work_packages_superseded;

-- 2. The additive columns. The rows themselves are untouched.
ALTER TABLE pc_work_packages DROP COLUMN IF EXISTS superseded_reason;
ALTER TABLE pc_work_packages DROP COLUMN IF EXISTS superseded_by;
ALTER TABLE pc_work_packages DROP COLUMN IF EXISTS superseded_at;

-- 3. The two tables 0040 created.
DROP INDEX IF EXISTS idx_pc_seed_runs_started;
DROP TABLE IF EXISTS pc_seed_runs;
DROP TABLE IF EXISTS pc_seed_state;

-- 4. Retract the ledger row LAST.
--
-- The migration runner's identity is the journal row, not the presence of the tables. Dropping
-- the objects without retracting the row leaves the runner convinced 0040 is applied over a
-- schema that no longer exists: db:migrate reports 0 pending while every seed read fails. This is
-- the same defect rollback-0030 carried, and it is not repeated here.
--
-- Guarded on the journal existing at all, so this script still runs cleanly against a disposable
-- test database that was never driven by the runner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    DELETE FROM schema_migrations WHERE filename = '0040_project_control_seed_reconciliation.sql';
  END IF;
END $$;

COMMIT;
