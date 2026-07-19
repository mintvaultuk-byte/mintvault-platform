-- 0010_partner_connector_import.sql
-- Trusted Intake Connector — Phase G3: exactly-once import provenance schema.
--
-- Additive only. Adds: the 'importing' connector state, one sequence (connector-scoped submission
-- reference allocation, G3A), and two new tables (partner_connector_customer_links,
-- partner_connector_imports, G3B). Grants partner_connector_runtime narrow, explicit access to the
-- MintVault-internal `users`/`submissions`/`submission_items` tables for the first time — every
-- prior migration kept this role confined to Partner-side tables plus its own connector tables; G3
-- is the first pass that legitimately needs it to write a real MintVault intake. See
-- .claude/controlled-code-lead/tasks/partner-network-connector-g3/DESTINATION-BOUNDARY.md and
-- IDEMPOTENCY-AND-TRANSACTION.md for the full design rationale.
--
-- Does NOT touch shared/schema.ts, server/storage.ts, or any existing row in
-- submissions/submission_items/users — no DEFAULT changes, no column changes, no data migration
-- against those tables. Deliberately NO FK from either new table toward
-- submissions/submission_items/users (repository convention already established in migration 0007:
-- MintVault-internal tables carry no cross-schema FK, so that rolling back Partner/connector schema
-- can never CASCADE onto a real customer's data — see ROLLBACK-PLAN.md).

-- ---------------------------------------------------------------------------
-- Widen the connector state CHECK to permit 'importing' (G3C). Same idempotent
-- drop-then-recreate-under-a-DO-block idiom migrations 0006/0007/0009 already use (the destructive-
-- SQL linter strips dollar-quoted bodies before pattern-matching a bare top-level DROP CONSTRAINT).
-- 'imported' was already present in 0008's CHECK for forward-compat and is unchanged here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE partner_connector_records DROP CONSTRAINT IF EXISTS chk_partner_connector_records_state';
  EXECUTE $c$ALTER TABLE partner_connector_records ADD CONSTRAINT chk_partner_connector_records_state
    CHECK (state IN ('queued','claimed','validating','ready_for_import','importing','rejected','failed','cancelled','imported'))$c$;
END$$;

-- ---------------------------------------------------------------------------
-- Connector-scoped submission-reference sequence (G3A risk 3). Deliberately separate from any
-- certificate-numbering sequence/counter (no certificate object is ever touched by this migration or
-- by the importer) and separate from the general checkout flow's COUNT(*)-based generator
-- (server/storage.ts's getNextSubmissionId, left untouched — see DESTINATION-BOUNDARY.md for why).
-- Because the two generators are independent, a formatted candidate from this sequence can in
-- principle collide with a tracking_number already produced by the other generator; the importer
-- handles this with a bounded SAVEPOINT-based retry against the real UNIQUE(tracking_number)
-- constraint (the actual, unconditional safety net — see IDEMPOTENCY-AND-TRANSACTION.md), not by
-- assuming this sequence alone guarantees a collision-free value. No gaplessness is claimed: a
-- rolled-back attempt (whether from a retry or a wider transaction abort) burns a sequence value,
-- same as any Postgres sequence used inside a transaction that can roll back.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS partner_connector_submission_ref_seq;

-- ---------------------------------------------------------------------------
-- partner_connector_customer_links — deterministic Partner-customer -> MintVault-user resolution
-- (G3, CUSTOMER-OWNERSHIP-DECISION.md). Keyed by (partner_organisation_id, partner_customer_id), NOT
-- by email — two different orgs' customers sharing an email must never resolve to the same MintVault
-- user. mintvault_user_id has no DB-level FK toward `users` (see file header). email_snapshot exists
-- purely for operator visibility on this table; it carries no uniqueness constraint and is never used
-- to look up or de-duplicate a link.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_connector_customer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_organisation_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_customer_id uuid NOT NULL REFERENCES partner_customers(id) ON DELETE RESTRICT,
  mintvault_user_id varchar NOT NULL,
  email_snapshot text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_partner_connector_customer_links_org_customer UNIQUE (partner_organisation_id, partner_customer_id),
  CONSTRAINT uq_partner_connector_customer_links_user UNIQUE (mintvault_user_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_connector_customer_links_user
  ON partner_connector_customer_links(mintvault_user_id);

-- ---------------------------------------------------------------------------
-- partner_connector_imports — the exactly-once reservation/completion record (G3B,
-- IDEMPOTENCY-AND-TRANSACTION.md). The four UNIQUE constraints below are the actual exactly-once
-- guarantee, not just a convenience index. destination_submission_id has no DB-level FK (see file
-- header) and is nullable until the state reaches 'completed'. A completed row's
-- partner_submission_id/partner_organisation_id/partner_location_id/partner_handoff_id/
-- validation_run_id/source_fingerprint/source_fingerprint_version/mapping_version are immutable —
-- enforced by the narrow column-level UPDATE grant below, not by trusting application code alone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_connector_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_record_id uuid NOT NULL REFERENCES partner_connector_records(id) ON DELETE RESTRICT,
  partner_organisation_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  partner_submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE RESTRICT,
  partner_handoff_id uuid NOT NULL REFERENCES partner_submission_handoffs(id) ON DELETE RESTRICT,
  validation_run_id uuid NOT NULL REFERENCES partner_connector_validation_runs(id) ON DELETE RESTRICT,
  destination_submission_id integer,
  source_fingerprint text NOT NULL,
  source_fingerprint_version integer NOT NULL,
  mapping_version integer NOT NULL DEFAULT 1,
  import_attempt integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'reserved',
  reserved_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  reconciled_at timestamptz,
  last_safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_partner_connector_imports_connector UNIQUE (connector_record_id),
  CONSTRAINT uq_partner_connector_imports_handoff UNIQUE (partner_handoff_id),
  CONSTRAINT uq_partner_connector_imports_submission UNIQUE (partner_submission_id),
  CONSTRAINT uq_partner_connector_imports_destination UNIQUE (destination_submission_id),
  CONSTRAINT chk_partner_connector_imports_state
    CHECK (state IN ('reserved','completed','reconciliation_required','failed')),
  CONSTRAINT chk_partner_connector_imports_attempt CHECK (import_attempt >= 1)
);
CREATE INDEX IF NOT EXISTS idx_partner_connector_imports_state ON partner_connector_imports(state);

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------

-- Connector-owned tables: same append-with-narrow-mutation trust model as 0008/0009's tables, plus
-- an explicit column-level UPDATE grant restricted to exactly the fields the completion/
-- reconciliation step is allowed to change — everything else on a row (including which Partner
-- submission/organisation/handoff/validation-run it references, and its fingerprint) is immutable at
-- the database level, not just by convention.
GRANT SELECT, INSERT         ON partner_connector_customer_links TO partner_connector_runtime;
GRANT SELECT, INSERT         ON partner_connector_imports        TO partner_connector_runtime;
GRANT UPDATE (state, destination_submission_id, completed_at, reconciled_at, last_safe_error_code, updated_at)
  ON partner_connector_imports TO partner_connector_runtime;
GRANT USAGE ON partner_connector_submission_ref_seq TO partner_connector_runtime;

-- MintVault-internal tables: INSERT + narrow SELECT only. No UPDATE, no DELETE — the importer never
-- modifies an existing submission/item/user row, only ever creates new ones. SELECT is needed for the
-- savepoint-retry reference-collision check (DESTINATION-BOUNDARY.md) and for the owner-resolution
-- existing-link lookup path.
GRANT SELECT, INSERT ON users            TO partner_connector_runtime;
GRANT SELECT, INSERT ON submissions      TO partner_connector_runtime;
GRANT SELECT, INSERT ON submission_items TO partner_connector_runtime;
-- The `submissions`/`submission_items` id columns are `serial` (an implicit sequence) — INSERT
-- requires USAGE on that underlying sequence too, matching how any INSERT-granted role needs it.
GRANT USAGE ON SEQUENCE submissions_id_seq TO partner_connector_runtime;
GRANT USAGE ON SEQUENCE submission_items_id_seq TO partner_connector_runtime;
