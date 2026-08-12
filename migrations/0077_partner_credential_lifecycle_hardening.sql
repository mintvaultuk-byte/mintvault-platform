-- Partner credential lifecycle hardening (additive).
--
-- Existing hashes have no reliable owner-set provenance. They remain unusable
-- until a partner completes a fresh invitation or password-reset flow; no hash,
-- plaintext credential, or token is exposed or copied by this migration.

ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

-- A recovery link is a credential. Keep only the newest live link for each user
-- before enforcing that invariant for all future issuances.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY tenant_id, user_id ORDER BY created_at DESC, id DESC) AS rn
    FROM partner_password_reset_tokens
   WHERE used_at IS NULL
)
UPDATE partner_password_reset_tokens t
   SET used_at=now()
  FROM ranked r
 WHERE t.id=r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_password_reset_one_live
  ON partner_password_reset_tokens (tenant_id, user_id)
  WHERE used_at IS NULL;

DROP FUNCTION IF EXISTS public.partner_auth_lookup(text);
CREATE FUNCTION public.partner_auth_lookup(p_email text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, partner_id uuid, password_hash text, user_status text,
  org_status text, credential_version integer, failed_login_count integer,
  locked_until timestamptz, mfa_required boolean, has_active_mfa boolean,
  password_set_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $fn$
  SELECT u.id, u.tenant_id, u.partner_id, u.password_hash, u.status,
         o.status, u.credential_version, u.failed_login_count, u.locked_until, u.mfa_required,
         EXISTS (
           SELECT 1 FROM public.partner_mfa_methods m
            WHERE m.user_id=u.id AND m.method='totp' AND m.status='ACTIVE' AND m.secret_ref IS NOT NULL
         ),
         u.password_set_at
    FROM public.partner_users u
    JOIN public.partner_organisations o ON o.id=u.tenant_id
   WHERE lower(u.email)=lower(p_email)
$fn$;
REVOKE ALL ON FUNCTION public.partner_auth_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_auth_lookup(text) TO partner_runtime;
GRANT SELECT ON public.partner_mfa_methods TO partner_definer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_definer') THEN
    BEGIN
      EXECUTE format('GRANT partner_definer TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
      NULL;
    END;
    GRANT CREATE ON SCHEMA public TO partner_definer;
    ALTER FUNCTION public.partner_auth_lookup(text) OWNER TO partner_definer;
    REVOKE CREATE ON SCHEMA public FROM partner_definer;
  END IF;
END$$;
