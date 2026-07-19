-- 0014_partner_connector_admin_actions.sql
-- Trusted Intake Connector — Phase G4: append-only Super-Admin operational-action audit.
--
-- Additive only. Adds one new append-only table, partner_connector_admin_actions, recording one
-- immutable row per Super-Admin operational action against a Partner connector (retry, reconcile,
-- resolve-reconciliation, manual-review decision, release-expired-claim, batch-retry). It is the
-- admin-facing operations ledger; the AUTHORITATIVE per-record state evidence remains the connector
-- services' own in-transaction partner_connector_events rows. This table never drives connector state
-- and is never read by any connector service — it is written by the privileged super-admin path only.
--
-- No new column on any existing table. No change to any MintVault-internal table. No backfill.
--
-- Same trust model as 0008/0009/0012's append-only tables: partner_connector_runtime is granted
-- SELECT+INSERT only (no UPDATE/DELETE — immutability is DB-enforced), no PUBLIC, no pg enums (CHECK
-- constraints only), uuid PK via gen_random_uuid() (no sequence grant needed). actor_user_id is a bare
-- uuid (no FK) — same convention as partner_audit_events — so the runtime role needs no privilege on
-- the MintVault-internal users table.

CREATE TABLE IF NOT EXISTS partner_connector_admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_organisation_id uuid REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  connector_record_id uuid REFERENCES partner_connector_records(id) ON DELETE RESTRICT,
  import_mapping_id uuid REFERENCES partner_connector_imports(id) ON DELETE RESTRICT,
  action_type text NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_email text NOT NULL,
  request_id text NOT NULL,
  idempotency_key text,
  before_state text,
  after_state text,
  reason text NOT NULL,
  result text NOT NULL,
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_connector_admin_actions_type
    CHECK (action_type IN (
      'retry_import','retry_interrupted','resume_reserved','request_reconciliation',
      'reconcile_retain','reconcile_retry','reconcile_mark_manual','manual_review_retry',
      'manual_review_cancel','ack_permanent_failure','release_expired_claim','batch_retry'
    )),
  CONSTRAINT chk_partner_connector_admin_actions_result
    CHECK (result IN ('attempted','succeeded','failed','no_op'))
);

-- At most one SUCCEEDED action per idempotency key — the evidentiary backstop for admin-action
-- idempotency. The service records 'attempted' first (no key uniqueness needed) then a terminal row;
-- only the succeeded terminal is uniquely constrained, so a repeated key cannot record a second
-- success. Constant predicate → IMMUTABLE, legal in a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_connector_admin_actions_idem
  ON partner_connector_admin_actions(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND result = 'succeeded';

-- Real read paths only: the record audit-history view (record detail) and the partner audit view.
CREATE INDEX IF NOT EXISTS idx_partner_connector_admin_actions_record
  ON partner_connector_admin_actions(connector_record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_partner_connector_admin_actions_org
  ON partner_connector_admin_actions(partner_organisation_id, created_at);

-- Grants: append-only (SELECT + INSERT, no UPDATE/DELETE). No PUBLIC. partner_runtime gets nothing.
GRANT SELECT, INSERT ON partner_connector_admin_actions TO partner_connector_runtime;
