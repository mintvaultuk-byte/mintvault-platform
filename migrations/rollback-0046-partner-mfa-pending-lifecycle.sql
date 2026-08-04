-- rollback-0046-partner-mfa-pending-lifecycle.sql
-- Reverses only the Partner MFA pending-setup lifecycle objects introduced by 0046.
-- Refuses if any active MFA method still depends on the 0046 consumption metadata.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM partner_mfa_methods
     WHERE status = 'ACTIVE'
       AND consumed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot roll back 0046: active MFA methods have consumed_at evidence from this migration.';
  END IF;
END$$;

DROP INDEX IF EXISTS idx_partner_mfa_pending_session;
DROP INDEX IF EXISTS uq_partner_mfa_one_pending;

DROP FUNCTION IF EXISTS partner_auth_lookup(text);
CREATE FUNCTION partner_auth_lookup(p_email text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, partner_id uuid, password_hash text, user_status text,
  org_status text, credential_version integer, failed_login_count integer,
  locked_until timestamptz, mfa_required boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $fn$
  SELECT u.id, u.tenant_id, u.partner_id, u.password_hash, u.status,
         o.status, u.credential_version, u.failed_login_count, u.locked_until, u.mfa_required
    FROM partner_users u
    JOIN partner_organisations o ON o.id = u.tenant_id
   WHERE lower(u.email) = lower(p_email)
$fn$;
REVOKE ALL ON FUNCTION partner_auth_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_auth_lookup(text) TO partner_runtime;

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

ALTER TABLE partner_mfa_methods DROP COLUMN IF EXISTS consumed_at;
ALTER TABLE partner_mfa_methods DROP COLUMN IF EXISTS expires_at;
ALTER TABLE partner_mfa_methods DROP COLUMN IF EXISTS enrolment_session_id;
