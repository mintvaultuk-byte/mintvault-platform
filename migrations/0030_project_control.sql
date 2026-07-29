-- Super Admin Project Control Dashboard — permanent engineering control centre.
--
-- ADDITIVE ONLY. Creates nine brand-new `pc_*` tables, their indexes, their referential
-- integrity, and one trigger that enforces the append-only status ledger. It does NOT touch any
-- existing table, column, index, constraint, trigger or row. There is no backfill, no rename, no
-- drop, no data movement. Reverting it drops only those nine objects
-- (migrations/rollback-0030-project-control.sql) with zero effect on anything else.
--
-- MIGRATION NUMBER: 0030. Deliberately clear of the contested 0019–0024 band. 0019–0021 are
-- claimed by unmerged branches (catalogue manager, partner submission credits, grading
-- concurrency); 0022 is print workflow; 0023/0024 are already journalled on production. 0030 is
-- free across every active worktree, so the runner's duplicate-number hard-reject cannot fire
-- whatever order those branches land in. The gap is harmless: the runner applies present files in
-- numeric order and does not require contiguity.
--
-- SAFETY: every statement is IF NOT EXISTS or guarded by a DO block, so re-running is a no-op.
-- Runs inside the runner's default transaction (no CONCURRENTLY, so no migrate:no-transaction).
--
-- REVISED after hostile review (findings H4, M1, M9, M10) and NOT YET APPLIED ANYWHERE. The first
-- draft had no foreign keys, no delete behaviour, no uniqueness on evidence, no optimistic-locking
-- column, and enforced its append-only ledger by convention only. All five are fixed here, before
-- any environment has this schema, so no follow-up migration is needed.
--
-- Applying this to staging or production remains a protected action requiring explicit owner
-- approval.

/* -------------------------------------------------------------------------------------------
   1. Programme nodes
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_nodes (
  id            SERIAL PRIMARY KEY,
  key           TEXT NOT NULL,
  -- Self-referencing parent. ON DELETE RESTRICT: a node with children must be re-parented
  -- deliberately; deleting it silently would orphan an entire subtree of work.
  parent_key    TEXT,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pc_nodes_key UNIQUE (key),
  CONSTRAINT pc_nodes_no_self_parent CHECK (parent_key IS NULL OR parent_key <> key)
);

DO $$ BEGIN
  ALTER TABLE pc_nodes
    ADD CONSTRAINT fk_pc_nodes_parent
    FOREIGN KEY (parent_key) REFERENCES pc_nodes (key) ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_nodes_parent ON pc_nodes (parent_key, sort_order);

/* -------------------------------------------------------------------------------------------
   2. Work packages
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_work_packages (
  id                       SERIAL PRIMARY KEY,
  key                      TEXT NOT NULL,
  -- ON DELETE RESTRICT: work must be re-homed before its programme node can be removed.
  node_key                 TEXT NOT NULL,
  title                    TEXT NOT NULL,
  summary                  TEXT NOT NULL DEFAULT '',
  status                   TEXT NOT NULL DEFAULT 'not_started',
  declared_completion      INTEGER NOT NULL DEFAULT 0,
  risk                     TEXT NOT NULL DEFAULT 'low',
  classification           TEXT NOT NULL DEFAULT 'A',
  review_state             TEXT NOT NULL DEFAULT 'not_started',
  deployment_state         TEXT NOT NULL DEFAULT 'not_deployed',
  production_verification  TEXT NOT NULL DEFAULT 'not_verified',
  business_value           INTEGER NOT NULL DEFAULT 3,
  engineering_risk         INTEGER NOT NULL DEFAULT 3,
  estimated_effort_days    INTEGER,
  remaining_work           TEXT NOT NULL DEFAULT '',
  branch                   TEXT,
  worktree_path            TEXT,
  base_commit              TEXT,
  latest_commit            TEXT,
  pr_url                   TEXT,
  tags                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_tests           JSONB NOT NULL DEFAULT '[]'::jsonb,
  category_states          JSONB NOT NULL DEFAULT '{}'::jsonb,
  category_notes           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Optimistic locking. Every update must present the version it read; the writer that arrives
  -- second is rejected instead of silently overwriting the first.
  version                  INTEGER NOT NULL DEFAULT 1,
  archived                 BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by               TEXT,
  CONSTRAINT uq_pc_work_packages_key UNIQUE (key),
  CONSTRAINT pc_work_packages_completion_range CHECK (declared_completion BETWEEN 0 AND 100),
  CONSTRAINT pc_work_packages_business_value_range CHECK (business_value BETWEEN 1 AND 5),
  CONSTRAINT pc_work_packages_engineering_risk_range CHECK (engineering_risk BETWEEN 1 AND 5),
  CONSTRAINT pc_work_packages_effort_nonneg CHECK (estimated_effort_days IS NULL OR estimated_effort_days >= 0),
  CONSTRAINT pc_work_packages_version_positive CHECK (version >= 1)
);

DO $$ BEGIN
  ALTER TABLE pc_work_packages
    ADD CONSTRAINT fk_pc_work_packages_node
    FOREIGN KEY (node_key) REFERENCES pc_nodes (key) ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_work_packages_node ON pc_work_packages (node_key);
CREATE INDEX IF NOT EXISTS idx_pc_work_packages_status ON pc_work_packages (status);
CREATE INDEX IF NOT EXISTS idx_pc_work_packages_updated ON pc_work_packages (updated_at DESC);
-- Supports the default dashboard read: live packages, newest first.
CREATE INDEX IF NOT EXISTS idx_pc_work_packages_live ON pc_work_packages (archived, node_key, key);

/* -------------------------------------------------------------------------------------------
   3. Evidence
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_evidence (
  id           SERIAL PRIMARY KEY,
  -- ON DELETE CASCADE: evidence has no meaning without the work package it describes, and an
  -- orphaned row would otherwise sit in the table forever influencing nothing.
  package_key  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  supports     BOOLEAN NOT NULL DEFAULT TRUE,
  summary      TEXT NOT NULL DEFAULT '',
  source_ref   TEXT,
  commit_sha   TEXT,
  environment  TEXT,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_by  TEXT,
  CONSTRAINT pc_evidence_environment_valid
    CHECK (environment IS NULL OR environment IN ('local','staging','production')),
  -- A timestamp in the future is not evidence. Rejected at the database, not merely in code.
  CONSTRAINT pc_evidence_not_future CHECK (captured_at <= NOW() + INTERVAL '5 minutes')
);

DO $$ BEGIN
  ALTER TABLE pc_evidence
    ADD CONSTRAINT fk_pc_evidence_package
    FOREIGN KEY (package_key) REFERENCES pc_work_packages (key) ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_evidence_package ON pc_evidence (package_key, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_pc_evidence_kind ON pc_evidence (kind);

/* -------------------------------------------------------------------------------------------
   4. Blockers
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_blockers (
  id               SERIAL PRIMARY KEY,
  package_key      TEXT NOT NULL,
  kind             TEXT NOT NULL,
  description      TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'none',
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by        TEXT,
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT,
  resolution_note  TEXT,
  CONSTRAINT pc_blockers_severity_valid
    CHECK (severity IN ('none','low','medium','high','critical')),
  CONSTRAINT pc_blockers_resolved_after_opened
    CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);

DO $$ BEGIN
  ALTER TABLE pc_blockers
    ADD CONSTRAINT fk_pc_blockers_package
    FOREIGN KEY (package_key) REFERENCES pc_work_packages (key) ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_blockers_package_open ON pc_blockers (package_key, resolved_at);
CREATE INDEX IF NOT EXISTS idx_pc_blockers_kind ON pc_blockers (kind);
-- Supports the "open HIGH security issue" readiness cap lookup.
CREATE INDEX IF NOT EXISTS idx_pc_blockers_open_security
  ON pc_blockers (severity, resolved_at) WHERE kind = 'security_issue';

/* -------------------------------------------------------------------------------------------
   5. Dependencies
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_dependencies (
  id              SERIAL PRIMARY KEY,
  package_key     TEXT NOT NULL,
  depends_on_key  TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pc_dependencies_edge UNIQUE (package_key, depends_on_key),
  -- A package depending on itself is always a data error.
  CONSTRAINT pc_dependencies_no_self CHECK (package_key <> depends_on_key)
);

-- BOTH sides are foreign-keyed, so a dependency can never point at a package that does not exist.
DO $$ BEGIN
  ALTER TABLE pc_dependencies
    ADD CONSTRAINT fk_pc_dependencies_package
    FOREIGN KEY (package_key) REFERENCES pc_work_packages (key) ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pc_dependencies
    ADD CONSTRAINT fk_pc_dependencies_depends_on
    FOREIGN KEY (depends_on_key) REFERENCES pc_work_packages (key) ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_dependencies_depends_on ON pc_dependencies (depends_on_key);

/* -------------------------------------------------------------------------------------------
   6. Status history — APPEND-ONLY, ENFORCED BY THE DATABASE
   ------------------------------------------------------------------------------------------- */

-- Deliberately NOT foreign-keyed to pc_work_packages: the audit ledger must survive the deletion
-- of the thing it describes. A history that disappears with its subject is not an audit trail.
CREATE TABLE IF NOT EXISTS pc_status_events (
  id            SERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT 'system',
  -- Where the change came from: 'dashboard' | 'scanner' | 'seed' | 'system'.
  source        TEXT NOT NULL DEFAULT 'dashboard',
  evidence_ref  TEXT,
  anomaly       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pc_status_events_subject_type_valid
    CHECK (subject_type IN ('work_package','node','deployment','test_run','prompt'))
);

CREATE INDEX IF NOT EXISTS idx_pc_status_events_subject
  ON pc_status_events (subject_type, subject_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pc_status_events_created ON pc_status_events (created_at DESC);

-- REMEDIATION of hostile-review finding M1. The append-only guarantee was previously enforced
-- only by the application's own discipline. This trigger makes UPDATE and DELETE impossible on
-- the ledger for every caller, including a future bug, a migration, or a direct psql session.
CREATE OR REPLACE FUNCTION pc_status_events_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'pc_status_events is append-only: % is not permitted on the Project Control audit ledger',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_pc_status_events_append_only ON pc_status_events;
CREATE TRIGGER trg_pc_status_events_append_only
  BEFORE UPDATE OR DELETE ON pc_status_events
  FOR EACH ROW EXECUTE FUNCTION pc_status_events_append_only();

-- Backdating is impossible: created_at is forced to the transaction clock on insert, so a client
-- cannot claim a change happened earlier (or later) than it did.
CREATE OR REPLACE FUNCTION pc_status_events_stamp_time() RETURNS TRIGGER AS $$
BEGIN
  NEW.created_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_pc_status_events_stamp_time ON pc_status_events;
CREATE TRIGGER trg_pc_status_events_stamp_time
  BEFORE INSERT ON pc_status_events
  FOR EACH ROW EXECUTE FUNCTION pc_status_events_stamp_time();

/* -------------------------------------------------------------------------------------------
   7. Deployment history
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_deployments (
  id               SERIAL PRIMARY KEY,
  environment      TEXT NOT NULL,
  commit_sha       TEXT NOT NULL,
  release_version  TEXT,
  result           TEXT NOT NULL DEFAULT 'succeeded',
  migration_state  TEXT,
  -- Nullable: a release may not belong to one work package. ON DELETE SET NULL keeps the release
  -- record (it really happened) while releasing the association.
  package_key      TEXT,
  deployed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deployed_by      TEXT,
  verified_at      TIMESTAMPTZ,
  verified_by      TEXT,
  rollback_of_sha  TEXT,
  notes            TEXT NOT NULL DEFAULT '',
  external_id      TEXT,
  -- STABLE idempotency identity. Deliberately excludes any timestamp: the previous constraint
  -- included deployed_at, which defaults to NOW(), so two identical submissions never collided.
  idempotency_key  TEXT NOT NULL,
  CONSTRAINT pc_deployments_environment_valid
    CHECK (environment IN ('local','staging','production')),
  CONSTRAINT pc_deployments_result_valid
    CHECK (result IN ('succeeded','failed','rolled_back','in_progress')),
  CONSTRAINT pc_deployments_verified_not_future
    CHECK (verified_at IS NULL OR verified_at <= NOW() + INTERVAL '5 minutes'),
  CONSTRAINT pc_deployments_verified_after_deploy
    CHECK (verified_at IS NULL OR verified_at >= deployed_at),
  CONSTRAINT pc_deployments_idempotency_key_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  -- Recording the same release twice is one row, not two pieces of evidence.
  CONSTRAINT uq_pc_deployments_idempotency UNIQUE (idempotency_key)
);

DO $$ BEGIN
  ALTER TABLE pc_deployments
    ADD CONSTRAINT fk_pc_deployments_package
    FOREIGN KEY (package_key) REFERENCES pc_work_packages (key) ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_deployments_env_deployed
  ON pc_deployments (environment, deployed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pc_deployments_sha ON pc_deployments (commit_sha);

/* -------------------------------------------------------------------------------------------
   8. Test / gate history
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_test_runs (
  id           SERIAL PRIMARY KEY,
  package_key  TEXT,
  kind         TEXT NOT NULL,
  result       TEXT NOT NULL,
  commit_sha   TEXT,
  detail       TEXT NOT NULL DEFAULT '',
  ran_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ran_by       TEXT,
  external_run_id  TEXT,
  -- Same reasoning as pc_deployments: identity must not depend on a defaulted timestamp.
  idempotency_key  TEXT NOT NULL,
  CONSTRAINT pc_test_runs_idempotency_key_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT uq_pc_test_runs_idempotency UNIQUE (idempotency_key),
  CONSTRAINT pc_test_runs_result_valid
    CHECK (result IN ('passed','failed','skipped','not_run')),
  CONSTRAINT pc_test_runs_not_future
    CHECK (ran_at <= NOW() + INTERVAL '5 minutes')
);

DO $$ BEGIN
  ALTER TABLE pc_test_runs
    ADD CONSTRAINT fk_pc_test_runs_package
    FOREIGN KEY (package_key) REFERENCES pc_work_packages (key) ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_test_runs_package_ran ON pc_test_runs (package_key, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_pc_test_runs_kind ON pc_test_runs (kind, ran_at DESC);
-- Idempotency is carried by the idempotency_key UNIQUE constraint declared on the table.

/* -------------------------------------------------------------------------------------------
   9. Generated prompts
   ------------------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS pc_prompts (
  id            SERIAL PRIMARY KEY,
  package_key   TEXT NOT NULL,
  target        TEXT NOT NULL,
  body          TEXT NOT NULL,
  branch        TEXT,
  base_commit   TEXT,
  -- SHA-256 of body at generation time; lets a stored prompt be proven unaltered.
  content_hash  TEXT NOT NULL DEFAULT '',
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by  TEXT
);

DO $$ BEGIN
  ALTER TABLE pc_prompts
    ADD CONSTRAINT fk_pc_prompts_package
    FOREIGN KEY (package_key) REFERENCES pc_work_packages (key) ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pc_prompts_package ON pc_prompts (package_key, generated_at DESC);

-- Prompt snapshots are immutable once issued: what was handed to an agent must remain
-- reconstructable exactly. New prompts are inserted; existing ones are never edited.
CREATE OR REPLACE FUNCTION pc_prompts_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'pc_prompts is immutable: % is not permitted on an issued prompt snapshot', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_pc_prompts_immutable ON pc_prompts;
CREATE TRIGGER trg_pc_prompts_immutable
  BEFORE UPDATE ON pc_prompts
  FOR EACH ROW EXECUTE FUNCTION pc_prompts_immutable();
