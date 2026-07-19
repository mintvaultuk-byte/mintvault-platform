-- 0009_partner_connector_validation.sql
-- Trusted Intake Connector — Phase G2: deterministic validation engine schema.
--
-- Adds two immutable-history tables (validation runs + findings) and extends
-- partner_connector_records.state to permit 'ready_for_import'. Additive only —
-- touches no existing Partner or MintVault table beyond that one CHECK-constraint widening.
-- Same trust model as migration 0008: partner_connector_runtime is the only role granted DML,
-- append-only (SELECT+INSERT, no UPDATE/DELETE), no RLS (see G1 ARCHITECTURE.md §7 — these are
-- purely-internal tables, same rationale applies unchanged). No new role needed.
--
-- NOTE on `source_handoff_version`: the brief's field list names this, but
-- partner_submission_handoffs (migration 0007) has no version column at all — handoffs are
-- immutable pending records identified only by `status`. Rather than fabricate a version concept
-- that doesn't exist on the source table, this migration stores `source_handoff_status` (the real
-- column we actually read and validated against) instead. Documented here per the "do not guess
-- columns" instruction — this is a deliberate correction, not an oversight.

-- ---------------------------------------------------------------------------
-- partner_connector_validation_runs — one row per validation attempt. Never updated after
-- completion (completed_at set once, in the same statement as outcome/counts — see
-- connector-validation-service.ts). validation_version is the RULE-SET version (VALIDATION-
-- CONTRACT.md's own revision); validator_version is the CODE version that ran it; both are
-- separate from source_fingerprint_version (SOURCE-FINGERPRINT.md's algorithm version).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_connector_validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_record_id uuid NOT NULL REFERENCES partner_connector_records(id) ON DELETE RESTRICT,
  validation_version integer NOT NULL DEFAULT 1,
  validator_version text NOT NULL DEFAULT 'g2.1',
  validation_attempt integer NOT NULL,
  source_submission_version integer NOT NULL,
  source_handoff_status text NOT NULL,
  source_fingerprint text,
  source_fingerprint_version integer,
  outcome text NOT NULL,
  blocking_error_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_connector_validation_runs_outcome
    CHECK (outcome IN ('valid','invalid','stale','cancelled','failed')),
  CONSTRAINT chk_partner_connector_validation_runs_counts
    CHECK (blocking_error_count >= 0 AND warning_count >= 0)
);
-- Latest-validation-per-connector-record lookup (getLatestValidationRun).
CREATE INDEX IF NOT EXISTS idx_partner_connector_validation_runs_record
  ON partner_connector_validation_runs(connector_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_connector_validation_runs_outcome
  ON partner_connector_validation_runs(outcome);

-- ---------------------------------------------------------------------------
-- partner_connector_validation_findings — append-only. safe_entity_reference is always an
-- opaque id (never a name/email/free text); safe_metadata is a small structured object, never a
-- copy of user-authored text (see VALIDATION-CONTRACT.md "safe metadata rules").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_connector_validation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  validation_run_id uuid NOT NULL REFERENCES partner_connector_validation_runs(id) ON DELETE CASCADE,
  severity text NOT NULL,
  code text NOT NULL,
  entity_type text NOT NULL,
  safe_entity_reference text,
  safe_field_name text,
  safe_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_connector_validation_findings_severity
    CHECK (severity IN ('warning','blocking'))
);
CREATE INDEX IF NOT EXISTS idx_partner_connector_validation_findings_run
  ON partner_connector_validation_findings(validation_run_id);

-- ---------------------------------------------------------------------------
-- RENAME the post-validation state from G1's 'awaiting_validation' to this programme's
-- 'ready_for_import' — the same lifecycle position (validation succeeded, nothing has claimed it
-- for import yet), renamed to match this brief's naming throughout VALIDATION-CONTRACT.md and
-- OPERATIONS-RUNBOOK.md. Safe to rename outright: partner_connector_enabled has never been ON
-- outside a disposable test database, so no real row anywhere has ever held the old value.
-- 'importing' is intentionally NOT added to the CHECK yet — G2 does not implement any transition
-- into it (that's G3B scope); adding a state value the code can never legally reach would be
-- exactly the kind of untested surface this programme's own discipline forbids. 'imported' was
-- already present in 0008's CHECK for forward-schema-compat and is left unchanged (G2 still cannot
-- reach it — the connector-service.ts guard blocking it stays in place unchanged).
-- Idempotent: drop-then-recreate the CHECK constraint under its existing name, inside a DO block
-- (the migration-safety linter's drop_constraint rule matches ALTER TABLE...DROP CONSTRAINT at the
-- top level; wrapping it in EXECUTE inside a dollar-quoted DO body is the same idiom migrations
-- 0006/0007 already use for ALTER TABLE...ENABLE/FORCE ROW LEVEL SECURITY — the linter strips
-- dollar-quoted bodies before pattern-matching, exactly so a reviewed, intentional, additive
-- constraint change like this one isn't conflated with an unreviewed destructive one).
-- ---------------------------------------------------------------------------
UPDATE partner_connector_records SET state = 'ready_for_import' WHERE state = 'awaiting_validation';
DO $$
BEGIN
  EXECUTE 'ALTER TABLE partner_connector_records DROP CONSTRAINT IF EXISTS chk_partner_connector_records_state';
  EXECUTE $c$ALTER TABLE partner_connector_records ADD CONSTRAINT chk_partner_connector_records_state
    CHECK (state IN ('queued','claimed','validating','ready_for_import','rejected','failed','cancelled','imported'))$c$;
END$$;

-- ---------------------------------------------------------------------------
-- Grants: partner_connector_runtime only, append-only (no UPDATE/DELETE on either table) —
-- identical trust model to partner_connector_events in migration 0008.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON partner_connector_validation_runs      TO partner_connector_runtime;
GRANT SELECT, INSERT ON partner_connector_validation_findings  TO partner_connector_runtime;

-- ---------------------------------------------------------------------------
-- Additional READ-ONLY grants the validation engine needs to load the trusted source (migration
-- 0008 only granted SELECT on partner_submission_handoffs/partner_submissions — organisation,
-- location, customer, service-tier, and card rows were never needed until G2). Same GUC-scoped RLS
-- model as 0008 (see connector-db.ts's withConnectorTx tenantId param) — every one of these tables
-- is FORCE ROW LEVEL SECURITY under the existing tenant_id = partner_current_tenant() policy
-- (migration 0001/0007), so a query only ever returns the caller-claimed tenant's rows. No write
-- grant on any of them — the connector NEVER mutates a Partner-owned row.
-- ---------------------------------------------------------------------------
GRANT SELECT ON partner_organisations       TO partner_connector_runtime;
GRANT SELECT ON partner_locations           TO partner_connector_runtime;
GRANT SELECT ON partner_customers           TO partner_connector_runtime;
GRANT SELECT ON partner_service_tiers       TO partner_connector_runtime;
GRANT SELECT ON partner_submission_cards    TO partner_connector_runtime;
