-- Phase 1 Part B — auth hardening from independent review (additive). Applied via the Phase 0.5
-- runner; validated on disposable Postgres only. Touches no existing MintVault table.

-- M5: partner login/reset resolve users by email pre-auth; per-tenant uniqueness allowed the same
-- email in two orgs, which made partner_auth_lookup return >1 row → silent permanent lockout.
-- Decision: partner-user emails are GLOBALLY unique (login identifier). Enforced case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_users_email_lower ON partner_users (lower(email));

-- L7: recovery-code verification matches by code_hash — give it a supporting index.
CREATE INDEX IF NOT EXISTS idx_partner_recovery_code_hash ON partner_recovery_codes (code_hash);

-- L6: derive the reset tenant FROM the token (never a request body). Narrow SECURITY DEFINER
-- lookup returning only the tenant for a valid, unused, unexpired token hash.
CREATE OR REPLACE FUNCTION partner_reset_token_tenant(p_token_hash text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $fn$
  SELECT tenant_id FROM partner_password_reset_tokens
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
$fn$;
REVOKE ALL ON FUNCTION partner_reset_token_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_reset_token_tenant(text) TO partner_runtime;

-- H3: session validation must also fail closed when the session's bound location is not ACTIVE.
-- Extend the session lookup with the location's status (LEFT JOIN — location may be unbound/NULL).
-- Return type changes, so drop + recreate.
DROP FUNCTION IF EXISTS partner_session_lookup(text);
CREATE FUNCTION partner_session_lookup(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid, location_id uuid, session_cred_version integer,
  mfa_passed boolean, absolute_expires_at timestamptz, revoked_at timestamptz, last_seen_at timestamptz,
  user_status text, user_cred_version integer, org_status text, location_status text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $fn$
  SELECT s.id, s.tenant_id, s.user_id, s.location_id, s.credential_version, s.mfa_passed,
         s.absolute_expires_at, s.revoked_at, s.last_seen_at,
         u.status, u.credential_version, o.status, l.status
    FROM partner_sessions s
    JOIN partner_users u ON u.id = s.user_id
    JOIN partner_organisations o ON o.id = s.tenant_id
    LEFT JOIN partner_locations l ON l.id = s.location_id
   WHERE s.token_hash = p_token_hash
$fn$;
REVOKE ALL ON FUNCTION partner_session_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_session_lookup(text) TO partner_runtime;
