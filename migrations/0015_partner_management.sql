-- 0015_partner_management.sql
-- Partner Network — Phase G5: internal Super-Admin Partner Management (CRM).
--
-- Additive only. Adds five new tables for internal super-admin partner-company management. Does NOT
-- ALTER partner_organisations (it is parity-locked with shared/partner-schema.ts) — all new metadata
-- lives in an additive 1:1 partner_profiles table. No change to any MintVault-internal table
-- (submissions/cards/certificates/cert_counter untouched — Phase-1 rule). No backfill.
--
-- Two trust models, matching established precedent:
--   * partner-DATA tables (partner_profiles, partner_contacts, partner_branding) are tenant-owned:
--     tenant_id NOT NULL, ENABLE+FORCE ROW LEVEL SECURITY + <t>_tenant_isolation policy keyed to
--     app.tenant_id (0001 idiom), SELECT granted to partner_runtime (RLS-scoped read; writes are
--     super-admin-only via the privileged admin pool). The portal (G9) will read these under RLS.
--   * internal-EVIDENCE tables (partner_internal_notes, partner_management_audit) follow the
--     0012/0014 append-only model: NO RLS (purely-internal, written by the privileged admin pool
--     without a tenant GUC), SELECT+INSERT to partner_connector_runtime ONLY (immutability
--     DB-enforced — no UPDATE/DELETE), NO grant to partner_runtime (never partner-visible),
--     tenancy enforced by explicit WHERE tenant_id = $1 in the service. No PUBLIC anywhere.
--
-- uuid PKs (gen_random_uuid()) — no sequence grant. CHECK constraints only (no pg enums). Indexes
-- only for real query paths in the G5 service (no speculative indexes).

-- ---- 1. partner_profiles (1:1 extended org metadata) ----------------------------------------------
CREATE TABLE IF NOT EXISTS partner_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  trading_name text,
  organisation_kind text,
  company_number text,
  vat_number text,
  website text,
  primary_email text,
  primary_phone text,
  address_line1 text,
  address_line2 text,
  address_city text,
  address_postcode text,
  address_country text,
  onboarding_date date,
  internal_tier text,
  health_note text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_profiles_kind CHECK (
    organisation_kind IS NULL OR organisation_kind IN
    ('shop','independent_grader','franchise','scanning_centre','enterprise','other')
  )
);

-- ---- 2. partner_contacts --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  title text,
  email text,
  phone text,
  contact_type text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_contacts_type CHECK (contact_type IN ('general','billing','technical','operations'))
);
CREATE INDEX IF NOT EXISTS idx_partner_contacts_tenant ON partner_contacts(tenant_id);
-- At most one ACTIVE primary contact per organisation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_contacts_primary
  ON partner_contacts(tenant_id) WHERE is_primary AND active;

-- ---- 3. partner_branding (metadata only, one row per org) -----------------------------------------
CREATE TABLE IF NOT EXISTS partner_branding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  display_name text,
  logo_r2_key text, -- reference only; no upload integration in G5
  primary_colour text,
  secondary_colour text,
  accent_colour text,
  support_email text,
  support_website text,
  custom_domain text, -- status/metadata only; no routing/DNS in G5
  branding_status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_branding_status CHECK (branding_status IN ('draft','ready','disabled'))
);

-- ---- 4. partner_internal_notes (append-only, super-admin-only) ------------------------------------
CREATE TABLE IF NOT EXISTS partner_internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  body text NOT NULL,
  author_user_id uuid NOT NULL,
  author_email text NOT NULL,
  supersedes_note_id uuid REFERENCES partner_internal_notes(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_internal_notes_tenant ON partner_internal_notes(tenant_id, created_at);

-- ---- 5. partner_management_audit (append-only admin-action ledger) --------------------------------
CREATE TABLE IF NOT EXISTS partner_management_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  action_type text NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_email text NOT NULL,
  request_id text NOT NULL,
  idempotency_key text,
  entity_type text,
  entity_id text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  result text NOT NULL,
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
    'partner_created','profile_updated','status_changed','contact_added','contact_updated',
    'contact_deactivated','branding_updated','note_added'
  )),
  CONSTRAINT chk_partner_management_audit_result CHECK (result IN ('attempted','succeeded','failed','no_op'))
);
-- Idempotency backstop: at most one SUCCEEDED action per key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_management_audit_idem
  ON partner_management_audit(idempotency_key) WHERE idempotency_key IS NOT NULL AND result = 'succeeded';
-- Real read path: the partner-focused audit view + the activity union, keyed by tenant + time.
CREATE INDEX IF NOT EXISTS idx_partner_management_audit_tenant ON partner_management_audit(tenant_id, created_at);

-- ---- RLS on the tenant-owned partner-DATA tables (0001 idiom) -------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_profiles','partner_contacts','partner_branding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

-- ---- Grants ---------------------------------------------------------------------------------------
-- partner-DATA tables: RLS-scoped SELECT for partner_runtime (portal read, G9); writes are
-- super-admin-only via the privileged admin pool. No INSERT/UPDATE/DELETE for the runtime in G5.
GRANT SELECT ON partner_profiles, partner_contacts, partner_branding TO partner_runtime;

-- internal-EVIDENCE tables: append-only (SELECT + INSERT, no UPDATE/DELETE), immutability DB-enforced;
-- granted to the internal non-partner-facing runtime role only; partner_runtime gets NOTHING so
-- partner users can never read internal notes or the admin audit. No PUBLIC.
GRANT SELECT, INSERT ON partner_internal_notes, partner_management_audit TO partner_connector_runtime;
