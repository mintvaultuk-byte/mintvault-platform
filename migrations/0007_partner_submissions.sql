-- 0007_partner_submissions.sql
-- Phase 2 — Partner submission intake (isolated from the existing MintVault submission pipeline).
--
-- ARCHITECTURE DECISION: shared/schema.ts `submissions`/`cards`/`certificates` have NO tenant
-- column, and Phase 1 explicitly forbids bolting one on. Partner intake therefore lives entirely in
-- new, isolated, RLS'd partner_* tables. A `partner_submission_handoffs` row is the only audited
-- bridge to a future connector into the trusted MintVault pipeline — this migration does NOT touch
-- `submissions`, `cards`, `certificates`, `cert_counter`, or any other existing MintVault table.
--
-- Additive only. Idempotent (IF NOT EXISTS). Follows the exact RLS/FORCE-RLS/grant pattern
-- established in 0001. No existing partner_* table, role, or function is modified.

-- ---------------------------------------------------------------------------
-- partner_customers — a partner's own customer book. Optional email/phone (data minimisation
-- default per Phase 2 spec §8; owner may later mandate).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  email text,
  phone text,
  reference text, -- partner's own customer reference, optional
  created_by uuid REFERENCES partner_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_customers_tenant ON partner_customers(tenant_id);

-- ---------------------------------------------------------------------------
-- partner_service_tiers — config-driven pricing (Phase 2 §8: NOT hardcoded partner prices).
-- tenant_id NULL = global default row (super-admin managed); a tenant-specific row overrides it.
-- Seeded below from the CURRENT retail tiers as a starting default ONLY — UI must label the
-- resulting number "Estimated — price confirmed by MintVault", never a firm partner price.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_service_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES partner_organisations(id) ON DELETE CASCADE, -- NULL = global default
  tier_code text NOT NULL, -- standard|priority|express (matches shared/schema.ts pricingTiers ids)
  label text NOT NULL,
  price_per_card_pence integer NOT NULL,
  turnaround_days integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tier_code)
);
-- Partial unique index: at most one GLOBAL row per tier_code (tenant_id IS NULL case is not
-- covered by the UNIQUE(tenant_id, tier_code) constraint above because NULL <> NULL in SQL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_service_tiers_global
  ON partner_service_tiers(tier_code) WHERE tenant_id IS NULL;

-- ---------------------------------------------------------------------------
-- partner_submissions — one row per intake ("order"). version = optimistic-concurrency guard
-- (stale-draft protection). idempotency_key unique per tenant so a retried create can't duplicate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES partner_users(id) ON DELETE RESTRICT,
  public_ref text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text, -- stable partner-facing reference
  customer_id uuid REFERENCES partner_customers(id) ON DELETE SET NULL,
  internal_reference text, -- partner's own free-text reference
  service_tier_code text, -- standard|priority|express, resolved against partner_service_tiers
  estimated_price_pence integer,
  card_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft', -- draft|submitted_to_mintvault|cancelled
  intake_notes text,
  version integer NOT NULL DEFAULT 1, -- optimistic concurrency
  idempotency_key text, -- set on submit attempt; unique per tenant below
  cancelled_reason text,
  cancelled_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_submissions_status
    CHECK (status IN ('draft','submitted_to_mintvault','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_partner_submissions_tenant ON partner_submissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_partner_submissions_location ON partner_submissions(location_id);
CREATE INDEX IF NOT EXISTS idx_partner_submissions_status ON partner_submissions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_submissions_created_at ON partner_submissions(tenant_id, created_at DESC);
-- Idempotency: the SAME idempotency_key can only ever be attached to one submission per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_submissions_idem
  ON partner_submissions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- partner_submission_cards — per-card intake. NO grade/cert/label columns exist on this table AT
-- ALL, so a partner cannot write one even by accident — enforced by omission, not just permission.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_submission_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  card_name text NOT NULL,
  game text,
  card_set text,
  card_number text,
  year integer,
  variant text,
  language text,
  declared_value_pence integer,
  quantity integer NOT NULL DEFAULT 1,
  customer_notes text,
  intake_notes text, -- non-binding partner observations only (e.g. "visible crease") — never a grade
  front_image_key text, -- reserved, unused until image upload is authorised (Phase 2 §9)
  back_image_key text,  -- reserved, unused until image upload is authorised (Phase 2 §9)
  removed_at timestamptz, -- soft delete
  removed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_submission_cards_qty CHECK (quantity >= 1)
);
CREATE INDEX IF NOT EXISTS idx_partner_submission_cards_tenant ON partner_submission_cards(tenant_id);
CREATE INDEX IF NOT EXISTS idx_partner_submission_cards_submission ON partner_submission_cards(submission_id);
-- Sequence numbers must be unique WITHIN a submission (excluding soft-deleted rows).
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_submission_cards_seq
  ON partner_submission_cards(submission_id, sequence_number) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- partner_submission_events — append-only activity timeline. Runtime gets SELECT+INSERT only
-- (granted below), matching the partner_audit_events pattern from 0001.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_submission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES partner_users(id) ON DELETE SET NULL,
  event_type text NOT NULL, -- created|updated|card_added|card_updated|card_removed|submitted|cancelled
  from_status text,
  to_status text,
  reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_submission_events_submission ON partner_submission_events(submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_partner_submission_events_tenant ON partner_submission_events(tenant_id);

-- ---------------------------------------------------------------------------
-- partner_submission_handoffs — the ONE audited, idempotent bridge point (Phase 2 §6). UNIQUE on
-- submission_id: a retried submit can never create a second handoff row for the same submission.
-- snapshot is the immutable submitted-data snapshot for audit (never mutated after insert).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_submission_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  submission_id uuid NOT NULL UNIQUE REFERENCES partner_submissions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending', -- pending|applied|failed
  snapshot jsonb NOT NULL, -- immutable copy of submission+cards at the moment of handoff
  mintvault_reference text, -- set once a future connector materializes a real submission (deferred)
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT chk_partner_submission_handoffs_status CHECK (status IN ('pending','applied','failed'))
);
CREATE INDEX IF NOT EXISTS idx_partner_submission_handoffs_tenant ON partner_submission_handoffs(tenant_id);

-- ---------------------------------------------------------------------------
-- RLS: enable + FORCE + tenant-isolation policy on every new tenant-scoped table, identical
-- pattern to 0001. partner_service_tiers gets the same NULL-or-match override as
-- partner_feature_flags (global default rows must be readable by every tenant).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_customers','partner_service_tiers','partner_submissions',
    'partner_submission_cards','partner_submission_events','partner_submission_handoffs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

DROP POLICY IF EXISTS partner_service_tiers_tenant_isolation ON partner_service_tiers;
CREATE POLICY partner_service_tiers_tenant_isolation ON partner_service_tiers
  USING (tenant_id IS NULL OR tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

-- ---------------------------------------------------------------------------
-- Grants: partner_runtime gets exactly the DML each table needs, matching the 0001 pattern.
-- Append-only tables (events, handoffs) get NO UPDATE/DELETE. service_tiers is SELECT-only
-- (config is super-admin managed, same as feature_flags).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE        ON partner_customers            TO partner_runtime; -- no DELETE: no customer-management route exists yet; add deliberately with a soft-delete design when one does
GRANT SELECT                        ON partner_service_tiers         TO partner_runtime;
GRANT SELECT, INSERT, UPDATE        ON partner_submissions           TO partner_runtime; -- no hard delete; use status
GRANT SELECT, INSERT, UPDATE        ON partner_submission_cards      TO partner_runtime; -- soft delete only
GRANT SELECT, INSERT                ON partner_submission_events     TO partner_runtime; -- append-only
GRANT SELECT, INSERT, UPDATE        ON partner_submission_handoffs   TO partner_runtime; -- status pending→applied/failed only; no DELETE (audit-immutable existence)

-- NOTE: the global default service-tier rows (tenant_id NULL) are NOT seeded here. Under FORCE RLS
-- the migration applies as pn_migrator (non-superuser, non-BYPASSRLS — the realistic DB-F1 owner
-- model), and the tenant_id-NULL WITH CHECK predicate on partner_service_tiers_tenant_isolation
-- requires tenant_id = partner_current_tenant(), which a NULL row can never satisfy with no request
-- transaction's tenant context set. This is the exact same reason migration 0001 never seeds
-- partner_feature_flags' global rows either — global-scope rows are written out-of-band by an
-- elevated/superuser (ops/super-admin) action, never by a numbered migration. See
-- docs/runbooks/db-migration-safety.md for the seeding step required before Phase 2 launch.
