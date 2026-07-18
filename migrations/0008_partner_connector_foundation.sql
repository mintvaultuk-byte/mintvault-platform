-- 0008_partner_connector_foundation.sql
-- Trusted Intake Connector — Phase G1: connector foundation ONLY.
--
-- Builds the safe, inert scaffolding that a future (G2+) trusted connector will use to move an
-- approved Partner handoff (partner_submission_handoffs, migration 0007) into the normal MintVault
-- intake workflow. This migration does NOT touch `submissions`, `cards`, `certificates`,
-- `cert_counter`, `partner_submissions`, or `partner_submission_handoffs` — additive only, two new
-- tables + one new role. See .claude/controlled-code-lead/tasks/partner-network-connector-g1/
-- ARCHITECTURE.md for the full design rationale.
--
-- Idempotent (IF NOT EXISTS). Follows the pn_migrator / non-superuser applying-role convention
-- established in 0001-0007. Deliberately NO RLS on the two new tables — see ARCHITECTURE.md §7 for
-- why grants-alone is the correct trust model here (purely-internal tables, no tenant HTTP session
-- ever touches them, and the global claim-next queue must legitimately span every tenant).

-- ---------------------------------------------------------------------------
-- New, purely-internal runtime role. Same shape as partner_runtime (0001): NOLOGIN group role, a
-- real login role is GRANTed membership out-of-band (infra/tests) — never created here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    CREATE ROLE partner_connector_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END$$;

-- Defensive: this role must never be superuser/bypassrls, however it got here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'partner_connector_runtime' AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION 'partner_connector_runtime must be NOSUPERUSER and NOBYPASSRLS.';
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- partner_connector_records — one canonical row per Partner handoff (UNIQUE on handoff_id).
-- tenant_id/partner_submission_id are denormalised from the handoff for cheap status lookups and
-- so a caller-supplied tenantId can be checked against the row without a join on every call.
-- version = optimistic-concurrency guard, identical convention to partner_submissions.version.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_connector_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE RESTRICT,
  handoff_id uuid NOT NULL UNIQUE REFERENCES partner_submission_handoffs(id) ON DELETE RESTRICT,
  source_handoff_idempotency_key text, -- copied from partner_submissions.idempotency_key at creation
  state text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  claimed_by text, -- opaque claimant/worker identifier, not a partner_users FK (fully internal actor)
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_category text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_partner_connector_records_state
    CHECK (state IN ('queued','claimed','validating','awaiting_validation','rejected','failed','cancelled','imported')),
  CONSTRAINT chk_partner_connector_records_attempt CHECK (attempt_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_partner_connector_records_tenant ON partner_connector_records(tenant_id);
-- Claim-next query: queued rows, or claimed rows whose lease has lapsed.
CREATE INDEX IF NOT EXISTS idx_partner_connector_records_claimable
  ON partner_connector_records(state, claim_expires_at) WHERE state IN ('queued','claimed');
CREATE INDEX IF NOT EXISTS idx_partner_connector_records_retryable
  ON partner_connector_records(state, next_retry_at) WHERE state = 'failed';
-- Second idempotency layer: the SAME source idempotency key can never be attached to two different
-- connector records (the handoff_id UNIQUE above catches same-handoff reuse; this catches
-- same-key-different-handoff reuse, which handoff_id uniqueness alone would miss).
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_connector_records_idem_key
  ON partner_connector_records(source_handoff_idempotency_key) WHERE source_handoff_idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- partner_connector_events — append-only, immutable history. One row per successful state
-- transition, written in the SAME transaction as the records UPDATE (see connector-service.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_connector_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_record_id uuid NOT NULL REFERENCES partner_connector_records(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  event_type text NOT NULL, -- created|claimed|released|transitioned|failed|retried|rejected|cancelled
  attempt_number integer NOT NULL,
  metadata jsonb, -- safe-only: no stack traces, no secrets, no unnecessary personal data
  actor_type text NOT NULL DEFAULT 'system', -- this table has no partner-facing actor
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_connector_events_record ON partner_connector_events(connector_record_id, created_at);

-- ---------------------------------------------------------------------------
-- Grants: partner_connector_runtime is the ONLY role with DML on these two tables.
-- partner_runtime (the Partner-facing role) receives NOTHING here — Postgres default-deny means it
-- has zero access, verified by the "trust boundary" tests rather than assumed from omission.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO partner_connector_runtime;
GRANT SELECT, INSERT, UPDATE ON partner_connector_records TO partner_connector_runtime; -- no DELETE: never hard-deleted
GRANT SELECT, INSERT         ON partner_connector_events  TO partner_connector_runtime; -- append-only, no UPDATE/DELETE

-- No RLS on either NEW table — see ARCHITECTURE.md §7. Both are only ever queried by
-- partner_connector_runtime, over a connection distinct from partner_runtime's; partner_runtime is
-- never granted any privilege on them, so there is no tenant-scoped HTTP session for RLS to protect
-- against here, and the global claim-next queue must legitimately see rows across every tenant.

-- ---------------------------------------------------------------------------
-- Read-only access to the two EXISTING tables ensureConnectorRecordForHandoff must validate against
-- (handoff readiness + the source idempotency key). Both are FORCE ROW LEVEL SECURITY under the
-- existing `tenant_id = partner_current_tenant()` policy (migration 0007) — partner_connector_runtime
-- is NOBYPASSRLS (see role definition above), so a query against these tables only ever returns rows
-- for whichever tenant the CALLER explicitly set via set_config('app.tenant_id', ...) in the same
-- transaction (connector-db.ts's withConnectorTx tenantId param) — exactly the same GUC-scoping
-- mechanism partner_runtime already uses via withTenant(). A caller-claimed tenantId that does not
-- match the handoff's real tenant_id therefore sees zero rows (non-leaking "not found"), never the
-- other tenant's data. No write grant on either table: the connector NEVER mutates a Partner-owned
-- row (migration 0007's own comment already established partner_runtime itself has no UPDATE on
-- partner_submission_handoffs; this grants nothing beyond SELECT to the new role either).
-- ---------------------------------------------------------------------------
GRANT SELECT ON partner_submission_handoffs TO partner_connector_runtime;
GRANT SELECT ON partner_submissions         TO partner_connector_runtime;
