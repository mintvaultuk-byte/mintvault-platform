-- Project Control Dashboard governance evidence store.
--
-- MEGS-PCD-001..010, MEGS-EVID-001..004
--
-- Additive only. These tables store governance evidence, calculated status
-- history, and frozen continuation prompt snapshots. They do not grant any
-- operational write/deploy/migration capability.

CREATE TABLE IF NOT EXISTS project_control_evidence (
  id SERIAL PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE,
  requirement_id TEXT NOT NULL,
  evidence_classification TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'unknown',
  source_kind TEXT NOT NULL,
  source_locator TEXT,
  source_timestamp TIMESTAMPTZ,
  summary TEXT NOT NULL,
  payload JSONB,
  stale_after TIMESTAMPTZ,
  confidence_impact INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_control_evidence_requirement_idx
  ON project_control_evidence (requirement_id);

CREATE INDEX IF NOT EXISTS project_control_evidence_source_kind_idx
  ON project_control_evidence (source_kind);

CREATE INDEX IF NOT EXISTS project_control_evidence_created_idx
  ON project_control_evidence (created_at);

CREATE TABLE IF NOT EXISTS project_control_status_history (
  id SERIAL PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  readiness_percent INTEGER NOT NULL DEFAULT 0,
  confidence_percent INTEGER NOT NULL DEFAULT 0,
  evidence_ids JSONB,
  reason TEXT NOT NULL,
  snapshot_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_control_status_requirement_created_idx
  ON project_control_status_history (requirement_id, created_at);

CREATE INDEX IF NOT EXISTS project_control_status_snapshot_idx
  ON project_control_status_history (snapshot_id);

CREATE TABLE IF NOT EXISTS project_control_prompt_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE,
  prompt_text TEXT NOT NULL,
  source_evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  frozen_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS project_control_prompt_snapshots_created_idx
  ON project_control_prompt_snapshots (created_at);

-- Governance records are append-only. A future, explicitly approved writer may
-- insert records, but no application or operator path may rewrite, delete, or
-- truncate historical evidence, status, or prompt snapshots.
CREATE OR REPLACE FUNCTION project_control_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Project Control governance records are append-only';
END;
$$;

DO $$
BEGIN
  EXECUTE 'CREATE TRIGGER project_control_evidence_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON project_control_evidence FOR EACH STATEMENT EXECUTE FUNCTION project_control_reject_mutation()';
  EXECUTE 'CREATE TRIGGER project_control_status_history_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON project_control_status_history FOR EACH STATEMENT EXECUTE FUNCTION project_control_reject_mutation()';
  EXECUTE 'CREATE TRIGGER project_control_prompt_snapshots_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON project_control_prompt_snapshots FOR EACH STATEMENT EXECUTE FUNCTION project_control_reject_mutation()';
END;
$$;
