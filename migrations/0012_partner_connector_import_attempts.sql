-- 0012_partner_connector_import_attempts.sql
-- Trusted Intake Connector — Phase G3F: append-only import-attempt evidence.
--
-- Additive only. Adds one new append-only table, partner_connector_import_attempts, recording one
-- immutable row per COMMITTED import-attempt outcome — capturing the exact validation run and
-- fingerprint THAT attempt verified against. Resolves the G3E-documented stale-reservation
-- fingerprint ambiguity (see PROVENANCE-EVIDENCE-MODEL.md, approach C) without mutating any existing
-- immutable row: instead of rewriting partner_connector_imports' immutable fingerprint columns on a
-- resume, every attempt appends its own evidence row, so the completed attempt unambiguously records
-- what authorised the actual destination.
--
-- No new column on any existing table. No change to any MintVault-internal table. No backfill needed
-- (the connector has never run outside disposable-DB tests — zero pre-existing completed imports).
--
-- Same trust model as 0008/0009/0010's append-only tables: partner_connector_runtime is the only
-- role granted DML, SELECT+INSERT only (no UPDATE/DELETE — immutability is DB-enforced), no PUBLIC,
-- no RLS (purely-internal table, same rationale as the other connector tables).

CREATE TABLE IF NOT EXISTS partner_connector_import_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_record_id uuid NOT NULL REFERENCES partner_connector_records(id) ON DELETE RESTRICT,
  import_mapping_id uuid REFERENCES partner_connector_imports(id) ON DELETE RESTRICT,
  partner_organisation_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE RESTRICT,
  partner_handoff_id uuid NOT NULL REFERENCES partner_submission_handoffs(id) ON DELETE RESTRICT,
  validation_run_id uuid REFERENCES partner_connector_validation_runs(id) ON DELETE RESTRICT,
  source_fingerprint text,
  source_fingerprint_version integer,
  attempt_number integer NOT NULL,
  attempt_type text NOT NULL,
  claimant text,
  outcome text NOT NULL,
  safe_error_code text,
  destination_submission_id integer,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_connector_import_attempts_type
    CHECK (attempt_type IN ('initial','retry','resumed','reconciled','manual')),
  CONSTRAINT chk_partner_connector_import_attempts_outcome
    CHECK (outcome IN ('started','stale','failed','completed','reconciliation_required','cancelled')),
  CONSTRAINT chk_partner_connector_import_attempts_number CHECK (attempt_number >= 1)
);

-- At most one COMPLETED attempt per connector — the evidentiary mirror of the exactly-once
-- destination guarantee. The code never attempts a second completed insert (the importer's
-- already_completed early return writes nothing, and the connector row FOR UPDATE lock serialises
-- concurrent attempts), so this partial unique index is a DB backstop, not the primary control.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_connector_import_attempts_completed
  ON partner_connector_import_attempts(connector_record_id) WHERE outcome = 'completed';

-- Only the evidence-backed history-lookup index. The append-only chain is read solely by
-- connector_record_id (getImportAttempts, the reconciliation completed-check, and the importer's
-- attempt_number/existing-completed reads) — all covered here or by the partial unique above. No
-- code path filters by import_mapping_id / validation_run_id / destination_submission_id, so no
-- index on those columns is added (they would be speculative — a future G4 operator lookup by those
-- provenance dimensions can add them when the query that needs them actually exists).
CREATE INDEX IF NOT EXISTS idx_partner_connector_import_attempts_connector
  ON partner_connector_import_attempts(connector_record_id, created_at);

-- Grants: append-only (SELECT + INSERT, no UPDATE/DELETE). No PUBLIC. partner_runtime gets nothing.
GRANT SELECT, INSERT ON partner_connector_import_attempts TO partner_connector_runtime;
