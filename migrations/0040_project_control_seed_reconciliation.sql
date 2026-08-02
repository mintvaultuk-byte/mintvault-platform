-- 0040_project_control_seed_reconciliation.sql
--
-- Durable state for seed reconciliation: what version of the compiled programme structure this
-- database currently holds, the history of every reconciliation attempt, and the supersession
-- links that let an obsolete work package be retired without deleting it.
--
-- WHY A NEW MIGRATION RATHER THAN REUSING EXISTING TABLES
--
-- Checked first, and neither fits:
--   * pc_status_events is a per-subject audit ledger whose CHECK restricts subject_type to
--     ('work_package','node','deployment','test_run','prompt'). A reconciliation RUN is not an
--     event about one subject — it has a mode, a manifest digest, counts across several entity
--     types and an outcome. Forcing it into (subject, field, old_value, new_value) would lose
--     most of that and require widening a 0030 constraint anyway.
--   * pc_sync_runs (0039) is the GitHub sync lifecycle: leases, checkpoints, evidence snapshots.
--     Different cadence, different failure model, different retention.
--
-- ADDITIVE ONLY. Creates two tables and adds three nullable columns to pc_work_packages. It
-- alters no existing column, drops nothing, and changes no existing constraint. Migrations 0030
-- and 0039 are untouched — 0030 in particular is applied to staging under a matching checksum and
-- must never be edited.

-- ── Current seed state ──────────────────────────────────────────────────────────────────────
--
-- Deliberately a SINGLETON, enforced by the primary key rather than by convention: a database
-- holds exactly one seed version, and two rows would make "which version are we on?" ambiguous
-- at the moment it matters most.
CREATE TABLE IF NOT EXISTS pc_seed_state (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  seed_version    INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by      TEXT NOT NULL DEFAULT 'seed',
  CONSTRAINT pc_seed_state_singleton CHECK (id = 1),
  CONSTRAINT pc_seed_state_version_positive CHECK (seed_version >= 1),
  -- A digest identifies WHAT was applied. A timestamp cannot: two different manifests applied a
  -- second apart would be indistinguishable, which is exactly the ambiguity this column removes.
  CONSTRAINT pc_seed_state_digest_shape CHECK (char_length(manifest_digest) BETWEEN 16 AND 128)
);

-- ── Reconciliation run history ──────────────────────────────────────────────────────────────
--
-- Every attempt, including dry runs and failures. A failed apply that wrote nothing still has to
-- leave a trace, or "we tried and it refused" is indistinguishable from "nobody tried".
CREATE TABLE IF NOT EXISTS pc_seed_runs (
  id                       SERIAL PRIMARY KEY,
  mode                     TEXT NOT NULL,
  outcome                  TEXT NOT NULL,
  seed_version_before      INTEGER,
  seed_version_after       INTEGER,
  manifest_digest          TEXT NOT NULL,
  nodes_inserted           INTEGER NOT NULL DEFAULT 0,
  nodes_updated            INTEGER NOT NULL DEFAULT 0,
  packages_inserted        INTEGER NOT NULL DEFAULT 0,
  packages_updated         INTEGER NOT NULL DEFAULT 0,
  packages_superseded      INTEGER NOT NULL DEFAULT 0,
  dependencies_added       INTEGER NOT NULL DEFAULT 0,
  dependencies_removed     INTEGER NOT NULL DEFAULT 0,
  operator_fields_preserved INTEGER NOT NULL DEFAULT 0,
  conflict_count           INTEGER NOT NULL DEFAULT 0,
  warning_count            INTEGER NOT NULL DEFAULT 0,
  -- Bounded summary only. Never raw operator text, never a driver error, never a connection
  -- string — the reconciler redacts and truncates before anything reaches this column.
  summary                  TEXT NOT NULL DEFAULT '',
  actor                    TEXT NOT NULL DEFAULT 'system',
  started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  CONSTRAINT pc_seed_runs_mode_valid CHECK (mode IN ('dry_run','first_seed','upgrade')),
  CONSTRAINT pc_seed_runs_outcome_valid
    CHECK (outcome IN ('planned','applied','no_change','refused','failed')),
  CONSTRAINT pc_seed_runs_summary_bounded CHECK (char_length(summary) <= 4000),
  CONSTRAINT pc_seed_runs_completed_after_started
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_pc_seed_runs_started ON pc_seed_runs (started_at DESC);

-- ── Supersession ────────────────────────────────────────────────────────────────────────────
--
-- Retiring a work package must never be a DELETE. The row carries operator notes, manual
-- blockers, manual evidence and an audit trail; deleting it destroys the only record of why the
-- work existed and what was decided about it. These three nullable columns mark a package as
-- retired and point at what replaced it, while the row itself — and everything foreign-keyed to
-- it — stays exactly where it is.
ALTER TABLE pc_work_packages ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE pc_work_packages ADD COLUMN IF NOT EXISTS superseded_by TEXT;
ALTER TABLE pc_work_packages ADD COLUMN IF NOT EXISTS superseded_reason TEXT;

-- Partial index: superseded packages are the minority and are excluded from every active-work
-- query, so the useful lookup is "show me the retired ones".
CREATE INDEX IF NOT EXISTS idx_pc_work_packages_superseded
  ON pc_work_packages (superseded_at) WHERE superseded_at IS NOT NULL;

-- A replacement must be a real package, and a package may not replace itself.
DO $$
BEGIN
  ALTER TABLE pc_work_packages
    ADD CONSTRAINT pc_work_packages_supersede_not_self
    CHECK (superseded_by IS NULL OR superseded_by <> key);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE pc_work_packages
    ADD CONSTRAINT fk_pc_work_packages_superseded_by
    FOREIGN KEY (superseded_by) REFERENCES pc_work_packages (key)
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Marking a supersession requires stating why. A retired package with no reason is a package
-- nobody can explain later.
DO $$
BEGIN
  ALTER TABLE pc_work_packages
    ADD CONSTRAINT pc_work_packages_supersede_complete
    CHECK (
      (superseded_at IS NULL AND superseded_by IS NULL AND superseded_reason IS NULL)
      OR (superseded_at IS NOT NULL AND superseded_reason IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
