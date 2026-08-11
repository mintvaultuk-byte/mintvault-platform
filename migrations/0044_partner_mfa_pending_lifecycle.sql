-- Partner MFA pending-setup lifecycle hardening (additive).
-- A pending TOTP setup is bound to the password-stage session that created it, expires quickly,
-- and only one pending setup can be valid per user at a time.

ALTER TABLE partner_mfa_methods ADD COLUMN IF NOT EXISTS enrolment_session_id uuid REFERENCES partner_sessions(id) ON DELETE SET NULL;
ALTER TABLE partner_mfa_methods ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE partner_mfa_methods ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY user_id, method ORDER BY created_at DESC, id DESC) AS rn
    FROM partner_mfa_methods
   WHERE status = 'PENDING'
)
UPDATE partner_mfa_methods m
   SET status = 'DISABLED'
  FROM ranked r
 WHERE m.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_mfa_one_pending
  ON partner_mfa_methods (user_id, method)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_partner_mfa_pending_session
  ON partner_mfa_methods (user_id, enrolment_session_id)
  WHERE status = 'PENDING';

DROP FUNCTION IF EXISTS partner_auth_lookup(text);
CREATE FUNCTION partner_auth_lookup(p_email text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, partner_id uuid, password_hash text, user_status text,
  org_status text, credential_version integer, failed_login_count integer,
  locked_until timestamptz, mfa_required boolean, has_active_mfa boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $fn$
  SELECT u.id, u.tenant_id, u.partner_id, u.password_hash, u.status,
         o.status, u.credential_version, u.failed_login_count, u.locked_until, u.mfa_required,
         EXISTS (
           SELECT 1 FROM partner_mfa_methods m
            WHERE m.user_id = u.id
              AND m.method = 'totp'
              AND m.status = 'ACTIVE'
              AND m.secret_ref IS NOT NULL
         )
    FROM partner_users u
    JOIN partner_organisations o ON o.id = u.tenant_id
   WHERE lower(u.email) = lower(p_email)
$fn$;
REVOKE ALL ON FUNCTION partner_auth_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_auth_lookup(text) TO partner_runtime;

GRANT SELECT ON partner_mfa_methods TO partner_definer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_definer') THEN
    BEGIN
      EXECUTE format('GRANT partner_definer TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
      NULL;
    END;
    GRANT CREATE ON SCHEMA public TO partner_definer;
    ALTER FUNCTION partner_auth_lookup(text) OWNER TO partner_definer;
    ALTER FUNCTION partner_auth_lookup(text) SET search_path = public, pg_temp;
    REVOKE CREATE ON SCHEMA public FROM partner_definer;
  END IF;
END$$;
