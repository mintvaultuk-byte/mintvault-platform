-- Phase 1 Part B — Partner auth support (additive). Lockout state, password-reset tokens, and
-- MFA recovery codes. Applied via the Phase 0.5 runner; validated on disposable Postgres only.
-- Touches no existing MintVault table.

-- lockout / throttle state on partner_users
ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;

-- password-reset tokens (single-use, expiring)
CREATE TABLE IF NOT EXISTS partner_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_pwreset_tenant ON partner_password_reset_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_partner_pwreset_user ON partner_password_reset_tokens(user_id);

-- MFA recovery codes (single-use)
CREATE TABLE IF NOT EXISTS partner_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_recovery_tenant ON partner_recovery_codes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_partner_recovery_user ON partner_recovery_codes(user_id);

-- RLS + grants for the two new tenant-scoped tables (same fail-closed predicate + role model).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_password_reset_tokens','partner_recovery_codes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO partner_runtime', t);
  END LOOP;
END$$;

-- Pre-auth lookup: authentication happens BEFORE tenant context exists (chicken-and-egg), and the
-- partner runtime must connect ONLY as the restricted partner_runtime role (never the privileged
-- MintVault role). A narrow SECURITY DEFINER function lets partner_runtime resolve a single user by
-- email for authentication (returning only auth fields), without granting broad table access.
-- SET search_path hardens the definer context. EXECUTE is granted only to partner_runtime.
CREATE OR REPLACE FUNCTION partner_auth_lookup(p_email text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, partner_id uuid, password_hash text, user_status text,
  org_status text, credential_version integer, failed_login_count integer,
  locked_until timestamptz, mfa_required boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $fn$
  SELECT u.id, u.tenant_id, u.partner_id, u.password_hash, u.status,
         o.status, u.credential_version, u.failed_login_count, u.locked_until, u.mfa_required
    FROM partner_users u
    JOIN partner_organisations o ON o.id = u.tenant_id
   WHERE lower(u.email) = lower(p_email)
$fn$;
REVOKE ALL ON FUNCTION partner_auth_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_auth_lookup(text) TO partner_runtime;

-- idle-timeout tracking
ALTER TABLE partner_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- Session validation also precedes tenant context (the session identifies the tenant). Narrow
-- SECURITY DEFINER lookup by token hash, returning the fields needed to validate a session +
-- its user/org state. EXECUTE granted only to partner_runtime.
CREATE OR REPLACE FUNCTION partner_session_lookup(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid, location_id uuid, session_cred_version integer,
  mfa_passed boolean, absolute_expires_at timestamptz, revoked_at timestamptz, last_seen_at timestamptz,
  user_status text, user_cred_version integer, org_status text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $fn$
  SELECT s.id, s.tenant_id, s.user_id, s.location_id, s.credential_version, s.mfa_passed,
         s.absolute_expires_at, s.revoked_at, s.last_seen_at,
         u.status, u.credential_version, o.status
    FROM partner_sessions s
    JOIN partner_users u ON u.id = s.user_id
    JOIN partner_organisations o ON o.id = s.tenant_id
   WHERE s.token_hash = p_token_hash
$fn$;
REVOKE ALL ON FUNCTION partner_session_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_session_lookup(text) TO partner_runtime;
