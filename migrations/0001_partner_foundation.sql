-- Phase 1 — Isolated Partner Foundation (Partner Network).
-- Additive only: creates the partner_* family, a restricted runtime role, and RLS.
-- Applied via the Phase 0.5 numbered runner (npm run db:migrate), never db:push.
-- Idempotent (IF NOT EXISTS). No existing MintVault table is touched.
-- Validated on disposable Postgres only. NOT run against staging/production.

-- ---------------------------------------------------------------------------
-- Restricted runtime role. Fail-closed by default: a fresh role has NO table
-- privileges, so it cannot read existing MintVault tables unless explicitly
-- granted (we grant only partner_* below). NOLOGIN group role; the partner app's
-- login role is GRANTed this role in infra (owner-provisioned, not here).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    CREATE ROLE partner_runtime NOLOGIN;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Global (non-tenant) reference tables: roles, permissions, role→permission.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE, -- PARTNER_OWNER | PARTNER_MANAGER | MVGS_ASSESSMENT_TECHNICIAN | PARTNER_RECEPTION | PARTNER_FINANCE_VIEWER | PARTNER_TRAINEE
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE, -- e.g. partner.orders.create
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_role_permissions (
  role_id uuid NOT NULL REFERENCES partner_roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES partner_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- Tenant-scoped tables. Every row carries tenant_id (= partner org id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text, -- non-sequential public id
  legal_name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', -- PENDING|ACTIVE|SUSPENDED|REVOKED
  accreditation_level text NOT NULL DEFAULT 'PROVISIONAL_PARTNER',
  health text NOT NULL DEFAULT 'NEEDS_ATTENTION',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- tenant_id on the org table is its own id (kept as a generated column for a uniform RLS predicate).
ALTER TABLE partner_organisations ADD COLUMN IF NOT EXISTS tenant_id uuid
  GENERATED ALWAYS AS (id) STORED;

CREATE TABLE IF NOT EXISTS partner_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text,
  status text NOT NULL DEFAULT 'PENDING', -- PENDING|ACTIVE|SUSPENDED
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_locations_tenant ON partner_locations(tenant_id);

CREATE TABLE IF NOT EXISTS partner_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text, -- bcrypt (repo-approved), set out-of-band
  status text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|SUSPENDED|REVOKED
  credential_version integer NOT NULL DEFAULT 1,
  mfa_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_partner_users_tenant ON partner_users(tenant_id);

CREATE TABLE IF NOT EXISTS partner_user_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_user_locations_tenant ON partner_user_locations(tenant_id);

CREATE TABLE IF NOT EXISTS partner_user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES partner_roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_user_roles_tenant ON partner_user_roles(tenant_id);

CREATE TABLE IF NOT EXISTS partner_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  location_id uuid REFERENCES partner_locations(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  credential_version integer NOT NULL,
  mfa_passed boolean NOT NULL DEFAULT false,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_partner_sessions_tenant ON partner_sessions(tenant_id);

CREATE TABLE IF NOT EXISTS partner_mfa_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  method text NOT NULL, -- totp|webauthn
  secret_ref text, -- reference/handle, never a raw secret in logs
  status text NOT NULL DEFAULT 'PENDING', -- PENDING|ACTIVE|DISABLED
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_mfa_tenant ON partner_mfa_methods(tenant_id);

CREATE TABLE IF NOT EXISTS partner_feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES partner_organisations(id) ON DELETE CASCADE, -- NULL = global partner flag
  location_id uuid REFERENCES partner_locations(id) ON DELETE CASCADE,
  flag text NOT NULL,
  enabled boolean NOT NULL DEFAULT false, -- fail-closed default
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_feature_flags_tenant ON partner_feature_flags(tenant_id);

CREATE TABLE IF NOT EXISTS partner_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ON DELETE RESTRICT (not CASCADE): audit evidence must survive an org deletion; you cannot
  -- delete an org while its audit trail exists (F1 — append-only guarantee cannot be cascade-wiped).
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid,
  actor_user_id uuid,
  device_id uuid,
  action text NOT NULL,
  record_type text,
  record_id text,
  before_value jsonb,
  after_value jsonb,
  ip text,
  session_id uuid,
  reason text,
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_audit_tenant ON partner_audit_events(tenant_id);

CREATE TABLE IF NOT EXISTS partner_security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ON DELETE RESTRICT: security evidence must survive org deletion (F1).
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  severity text NOT NULL, -- info|low|medium|high|critical
  kind text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_security_tenant ON partner_security_events(tenant_id);

CREATE TABLE IF NOT EXISTS partner_emergency_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  location_id uuid REFERENCES partner_locations(id) ON DELETE CASCADE,
  scope text NOT NULL, -- partner|location|user|device|credits|orders|grading
  frozen boolean NOT NULL DEFAULT false,
  reason text,
  set_by text, -- MintVault super-admin (internal), not a partner user
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_emergency_tenant ON partner_emergency_controls(tenant_id);

-- ---------------------------------------------------------------------------
-- Safe tenant-context reader. Returns the current app.tenant_id GUC as a uuid, or NULL when it
-- is unset, empty, OR malformed (non-uuid). So EVERY bad-context case — missing, empty, garbage —
-- fails closed to 0 rows uniformly, instead of empty/garbage diverging (garbage previously raised
-- an "invalid input syntax for uuid" error). STABLE, runs as the caller (not SECURITY DEFINER).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION partner_current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN nullif(current_setting('app.tenant_id', true), '')::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Row-Level Security on every tenant-scoped table. Predicate keyed to the per-transaction GUC
-- app.tenant_id via partner_current_tenant(). NULL context => no rows => FAIL CLOSED.
-- SECURITY BOUNDARY (F3): app.tenant_id is a user-settable GUC — the partner runtime role CAN reset
-- it. RLS therefore protects against app-logic bugs (a forgotten WHERE), NOT against a connection
-- that can run arbitrary SQL. The Phase-2 data layer MUST set it with SET LOCAL inside the
-- request transaction from trusted authenticated context, use parameterised queries only, and
-- never expose raw/interpolated SQL on the runtime pool. This is a hard Phase-2 requirement.
-- Location scoping is additionally enforced in the app layer; the DB tenant boundary is the floor.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_organisations','partner_locations','partner_users','partner_user_locations',
    'partner_user_roles','partner_sessions','partner_mfa_methods','partner_feature_flags',
    'partner_audit_events','partner_security_events','partner_emergency_controls'
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

-- F2 — partner_feature_flags: a GLOBAL flag (tenant_id IS NULL) must be READABLE by every tenant,
-- but writable only within one's own tenant (global flags are super-admin/out-of-band). Override the
-- uniform policy for this one table with a NULL-or-match read predicate.
DROP POLICY IF EXISTS partner_feature_flags_tenant_isolation ON partner_feature_flags;
CREATE POLICY partner_feature_flags_tenant_isolation ON partner_feature_flags
  USING (tenant_id IS NULL OR tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

-- ---------------------------------------------------------------------------
-- Grants: partner_runtime may touch ONLY partner_* tables. Reference tables are
-- read-only to the runtime. No grant on any existing MintVault table is made,
-- so the restricted role cannot read them (fail closed by default privilege).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO partner_runtime;
GRANT SELECT ON partner_roles, partner_permissions, partner_role_permissions TO partner_runtime;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_organisations','partner_locations','partner_users','partner_user_locations',
    'partner_user_roles','partner_sessions','partner_mfa_methods','partner_feature_flags',
    'partner_audit_events','partner_security_events','partner_emergency_controls'
  ] LOOP
    IF t IN ('partner_audit_events','partner_security_events') THEN
      -- append-only for the runtime: no UPDATE/DELETE grant.
      EXECUTE format('GRANT SELECT, INSERT ON %I TO partner_runtime', t);
    ELSIF t = 'partner_organisations' THEN
      -- F1/F6: org lifecycle (create/suspend/revoke/accreditation) is SUPER-ADMIN only. The runtime
      -- may READ its own org but never INSERT/UPDATE/DELETE it (revocation uses status, not a hard
      -- delete; a runtime DELETE previously could cascade-wipe its own audit trail).
      EXECUTE format('GRANT SELECT ON %I TO partner_runtime', t);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO partner_runtime', t);
    END IF;
  END LOOP;
END$$;
-- NOTE: no sequence GRANT is issued. Partner PKs are uuid defaults (gen_random_uuid) and the two
-- log tables use GENERATED ALWAYS AS IDENTITY (system-managed; INSERT needs no sequence grant). A
-- blanket "GRANT ON ALL SEQUENCES IN SCHEMA public" would wrongly grant the restricted role rights
-- on EXISTING MintVault sequences (certificates_id_seq, schema_migrations_id_seq) — an isolation
-- leak — so it is deliberately omitted.

-- ---------------------------------------------------------------------------
-- F8 — indexes on FK columns used for reverse lookups / cascade scans (revoke all sessions for a
-- user, "who has role X", location cascades). Every tenant filter is already indexed above.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_partner_sessions_user ON partner_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_partner_sessions_location ON partner_sessions(location_id);
CREATE INDEX IF NOT EXISTS idx_partner_user_roles_role ON partner_user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_partner_user_locations_location ON partner_user_locations(location_id);
CREATE INDEX IF NOT EXISTS idx_partner_feature_flags_location ON partner_feature_flags(location_id);
CREATE INDEX IF NOT EXISTS idx_partner_emergency_location ON partner_emergency_controls(location_id);
