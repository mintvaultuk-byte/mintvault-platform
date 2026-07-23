-- 0020_partner_auth_invitations_rbac.sql
-- Partner authentication, invitations and RBAC hardening.
--
-- This deliberately follows 0018 on the current authoritative branch. 0019 is reserved for the
-- independently-reviewed G6D credit lifecycle migration and MUST be present before this migration
-- is applied to a shared environment. The migration itself has no dependency on G6D objects.

-- ---- Invitation aggregate ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  invited_email text NOT NULL,
  role_id uuid NOT NULL REFERENCES partner_roles(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  created_by_user_id uuid,
  created_by_email text NOT NULL,
  idempotency_key text,
  idempotency_scope text NOT NULL DEFAULT 'create',
  resend_of_id uuid REFERENCES partner_invitations(id) ON DELETE RESTRICT,
  superseded_by_id uuid REFERENCES partner_invitations(id) ON DELETE RESTRICT,
  accepted_user_id uuid REFERENCES partner_users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  revoked_by_email text,
  superseded_at timestamptz,
  expired_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'PENDING',
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_delivery_at timestamptz,
  delivery_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_partner_invitations_identity UNIQUE (id, tenant_id),
  CONSTRAINT chk_partner_invitations_email CHECK (invited_email = lower(btrim(invited_email)) AND length(invited_email) <= 320),
  CONSTRAINT chk_partner_invitations_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_partner_invitations_status CHECK (status IN ('PENDING','ACCEPTED','EXPIRED','REVOKED','SUPERSEDED')),
  CONSTRAINT chk_partner_invitations_delivery_status CHECK (delivery_status IN ('PENDING','SENT','FAILED','SUPPRESSED')),
  CONSTRAINT chk_partner_invitations_expiry CHECK (expires_at > created_at),
  CONSTRAINT chk_partner_invitations_terminal_times CHECK (
    (status = 'PENDING' AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL AND expired_at IS NULL)
    OR (status = 'ACCEPTED' AND accepted_at IS NOT NULL AND revoked_at IS NULL AND superseded_at IS NULL)
    OR (status = 'EXPIRED' AND expired_at IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND accepted_at IS NULL AND superseded_at IS NULL)
    OR (status = 'SUPERSEDED' AND superseded_at IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL)
  )
);
-- A caller key is only meaningful for the operation it guards. A create and a resend must not
-- collide, nor may a key replay cross a Partner boundary.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_invitations_idempotency
  ON partner_invitations(tenant_id, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_invitations_pending_email
  ON partner_invitations(tenant_id, lower(invited_email)) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_partner_invitations_tenant_status
  ON partner_invitations(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_invitations_expiry
  ON partner_invitations(expires_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS partner_invitation_locations (
  invitation_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, location_id),
  CONSTRAINT fk_partner_invitation_locations_invitation
    FOREIGN KEY (invitation_id, tenant_id) REFERENCES partner_invitations(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_invitation_locations_location
    FOREIGN KEY (location_id, tenant_id) REFERENCES partner_locations(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_partner_invitation_locations_tenant
  ON partner_invitation_locations(tenant_id, location_id);

-- Preserve an invitation-origin link on the existing membership record; no new identity table.
ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS invitation_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_partner_users_invitation') THEN
    ALTER TABLE partner_users ADD CONSTRAINT fk_partner_users_invitation
      FOREIGN KEY (invitation_id) REFERENCES partner_invitations(id) ON DELETE RESTRICT;
  END IF;
END$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_users_invitation
  ON partner_users(invitation_id) WHERE invitation_id IS NOT NULL;

-- ---- Dedicated immutable access-security ledger -----------------------------------------
CREATE TABLE IF NOT EXISTS partner_access_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  actor_user_id uuid,
  actor_email text,
  target_type text NOT NULL,
  target_id uuid,
  action text NOT NULL,
  reason text,
  correlation_id text,
  before_value jsonb,
  after_value jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_access_audit_actor CHECK (actor_type IN ('SUPER_ADMIN','PARTNER_USER','SYSTEM','SERVICE')),
  CONSTRAINT chk_partner_access_audit_action CHECK (action IN (
    'invitation_created','invitation_delivery_sent','invitation_delivery_failed','invitation_delivery_suppressed',
    'invitation_superseded','invitation_revoked','invitation_expired','invitation_acceptance_denied',
    'invitation_accepted','membership_created','role_changed','location_scope_changed','member_suspended',
    'member_reactivated','session_revoked','partner_suspended','partner_reactivated','sensitive_access_denied'
  ))
);
CREATE INDEX IF NOT EXISTS idx_partner_access_audit_tenant_time
  ON partner_access_audit_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_access_audit_target
  ON partner_access_audit_events(target_type, target_id, created_at DESC);

CREATE OR REPLACE FUNCTION partner_access_audit_no_mutate() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'partner_access_audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$;
REVOKE ALL ON FUNCTION partner_access_audit_no_mutate() FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_access_audit_no_row_mutate'
                 AND tgrelid = 'partner_access_audit_events'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_access_audit_no_row_mutate'
         || ' BEFORE UPDATE OR DELETE ON partner_access_audit_events'
         || ' FOR EACH ROW EXECUTE FUNCTION partner_access_audit_no_mutate()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_access_audit_no_truncate'
                 AND tgrelid = 'partner_access_audit_events'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_access_audit_no_truncate'
         || ' BEFORE TRUNCATE ON partner_access_audit_events'
         || ' FOR EACH STATEMENT EXECUTE FUNCTION partner_access_audit_no_mutate()';
  END IF;
END$$;

-- Invitations are tenant-owned but are intentionally not directly readable/writable by the partner
-- runtime. Acceptance is the only pre-auth access path and goes through the narrow function below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_invitations','partner_invitation_locations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

-- The runtime must never mutate role or location assignments directly. Existing login, reset,
-- session and MFA paths retain only the grants they need on their existing tables.
REVOKE INSERT, UPDATE, DELETE ON partner_user_roles FROM partner_runtime;
REVOKE INSERT, UPDATE, DELETE ON partner_user_locations FROM partner_runtime;
REVOKE ALL ON partner_invitations, partner_invitation_locations, partner_access_audit_events FROM partner_runtime;

-- The isolated no-login definer gains only the rows/functions required for atomic invitation
-- acceptance. It is not granted to the runtime; runtime gets EXECUTE on the one function only.
GRANT SELECT, INSERT, UPDATE ON partner_invitations TO partner_definer;
GRANT SELECT ON partner_invitation_locations TO partner_definer;
GRANT SELECT, INSERT, UPDATE ON partner_users TO partner_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_user_roles TO partner_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_user_locations TO partner_definer;
GRANT INSERT ON partner_access_audit_events TO partner_definer;

-- The complete acceptance transition is one PostgreSQL statement/transaction. The caller supplies
-- only a SHA-256 token hash, normalized email and bcrypt hash; tenant, role and locations always
-- come from the locked invitation row. No raw token is stored or written to audit metadata.
CREATE OR REPLACE FUNCTION public.partner_accept_invitation(
  p_token_hash text,
  p_email text,
  p_password_hash text,
  p_correlation_id text DEFAULT NULL
)
RETURNS TABLE (outcome text, accepted_user_id uuid, accepted_tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  inv public.partner_invitations%ROWTYPE;
  existing_user public.partner_users%ROWTYPE;
  resolved_user_id uuid;
BEGIN
  outcome := 'invalid';
  accepted_user_id := NULL;
  accepted_tenant_id := NULL;
  IF p_token_hash !~ '^[0-9a-f]{64}$' OR p_email IS NULL OR p_password_hash IS NULL
     OR length(p_password_hash) < 20 OR length(p_password_hash) > 200 THEN
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.* INTO inv
    FROM public.partner_invitations AS i
   WHERE i.token_hash = p_token_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;

  accepted_tenant_id := inv.tenant_id;
  IF inv.status <> 'PENDING' THEN
    -- Acceptance is a single-use capability. A second use must not silently mint a new session or
    -- re-run membership writes, even when the original browser still holds the token.
    outcome := CASE WHEN inv.status = 'ACCEPTED' THEN 'used' ELSE lower(inv.status) END;
    INSERT INTO public.partner_access_audit_events
      (tenant_id, actor_type, actor_email, target_type, target_id, action, correlation_id, metadata)
    VALUES (inv.tenant_id, 'SYSTEM', lower(btrim(p_email)), 'partner_invitation', inv.id,
            'invitation_acceptance_denied', p_correlation_id, jsonb_build_object('reason', 'not_pending'));
    RETURN NEXT;
    RETURN;
  END IF;
  IF inv.expires_at <= pg_catalog.now() THEN
    UPDATE public.partner_invitations SET status = 'EXPIRED', expired_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE id = inv.id;
    INSERT INTO public.partner_access_audit_events
      (tenant_id, actor_type, target_type, target_id, action, correlation_id, metadata)
    VALUES (inv.tenant_id, 'SYSTEM', 'partner_invitation', inv.id, 'invitation_expired', p_correlation_id, '{}'::jsonb);
    outcome := 'expired';
    RETURN NEXT;
    RETURN;
  END IF;
  IF lower(btrim(p_email)) <> inv.invited_email THEN
    INSERT INTO public.partner_access_audit_events
      (tenant_id, actor_type, actor_email, target_type, target_id, action, correlation_id, metadata)
    VALUES (inv.tenant_id, 'SYSTEM', lower(btrim(p_email)), 'partner_invitation', inv.id,
            'invitation_acceptance_denied', p_correlation_id, jsonb_build_object('reason', 'identity_mismatch'));
    outcome := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM 1
    FROM public.partner_invitation_locations AS il
   WHERE il.invitation_id = inv.id AND il.tenant_id = inv.tenant_id;
  IF NOT FOUND THEN
    INSERT INTO public.partner_access_audit_events
      (tenant_id, actor_type, actor_email, target_type, target_id, action, correlation_id, metadata)
    VALUES (inv.tenant_id, 'SYSTEM', inv.invited_email, 'partner_invitation', inv.id,
            'invitation_acceptance_denied', p_correlation_id, jsonb_build_object('reason', 'no_location_scope'));
    outcome := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT u.* INTO existing_user
    FROM public.partner_users AS u
   WHERE lower(u.email) = inv.invited_email
     AND u.tenant_id = inv.tenant_id
   FOR UPDATE;
  -- An email already bound to another Partner must never be linked or re-homed through an
  -- invitation. Lock the conflicting identity so concurrent cross-Partner attempts fail closed.
  IF NOT FOUND THEN
    PERFORM 1
      FROM public.partner_users AS u
     WHERE lower(u.email) = inv.invited_email
       AND u.tenant_id <> inv.tenant_id
     FOR UPDATE;
    IF FOUND THEN
      INSERT INTO public.partner_access_audit_events
        (tenant_id, actor_type, actor_email, target_type, target_id, action, correlation_id, metadata)
      VALUES (inv.tenant_id, 'SYSTEM', inv.invited_email, 'partner_invitation', inv.id,
              'invitation_acceptance_denied', p_correlation_id, jsonb_build_object('reason', 'identity_mismatch'));
      outcome := 'invalid';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  IF FOUND AND existing_user.status <> 'ACTIVE' THEN
    INSERT INTO public.partner_access_audit_events
      (tenant_id, actor_type, actor_email, target_type, target_id, action, correlation_id, metadata)
    VALUES (inv.tenant_id, 'SYSTEM', inv.invited_email, 'partner_invitation', inv.id,
            'invitation_acceptance_denied', p_correlation_id, jsonb_build_object('reason', 'membership_inactive'));
    outcome := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;

  IF FOUND THEN
    resolved_user_id := existing_user.id;
    UPDATE public.partner_users
       SET password_hash = p_password_hash, credential_version = credential_version + 1,
           invitation_id = inv.id, updated_at = pg_catalog.now()
     WHERE id = resolved_user_id;
    DELETE FROM public.partner_user_roles WHERE user_id = resolved_user_id;
    DELETE FROM public.partner_user_locations WHERE user_id = resolved_user_id;
  ELSE
    INSERT INTO public.partner_users
      (tenant_id, partner_id, email, password_hash, status, invitation_id)
    VALUES (inv.tenant_id, inv.tenant_id, inv.invited_email, p_password_hash, 'ACTIVE', inv.id)
    RETURNING id INTO resolved_user_id;
  END IF;

  INSERT INTO public.partner_user_roles (tenant_id, user_id, role_id)
  VALUES (inv.tenant_id, resolved_user_id, inv.role_id);
  INSERT INTO public.partner_user_locations (tenant_id, user_id, location_id)
  SELECT il.tenant_id, resolved_user_id, il.location_id
    FROM public.partner_invitation_locations AS il
   WHERE il.invitation_id = inv.id AND il.tenant_id = inv.tenant_id;

  UPDATE public.partner_invitations
     SET status = 'ACCEPTED', accepted_user_id = resolved_user_id, accepted_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE id = inv.id;
  INSERT INTO public.partner_access_audit_events
    (tenant_id, actor_type, actor_user_id, actor_email, target_type, target_id, action, correlation_id, after_value, metadata)
  VALUES
    (inv.tenant_id, 'PARTNER_USER', resolved_user_id, inv.invited_email, 'partner_invitation', inv.id,
     'invitation_accepted', p_correlation_id,
     jsonb_build_object('userId', resolved_user_id, 'roleId', inv.role_id), '{}'::jsonb),
    (inv.tenant_id, 'PARTNER_USER', resolved_user_id, inv.invited_email, 'partner_user', resolved_user_id,
     'membership_created', p_correlation_id,
     jsonb_build_object('roleId', inv.role_id), jsonb_build_object('invitationId', inv.id));

  outcome := 'accepted';
  accepted_user_id := resolved_user_id;
  RETURN NEXT;
END;
$fn$;

-- Ownership transfer follows the established 0006 definer model. CREATE is transient because
-- PostgreSQL requires it to transfer a function into the no-login role.
GRANT CREATE ON SCHEMA public TO partner_definer;
ALTER FUNCTION public.partner_accept_invitation(text, text, text, text) OWNER TO partner_definer;
REVOKE CREATE ON SCHEMA public FROM partner_definer;
REVOKE ALL ON FUNCTION public.partner_accept_invitation(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_accept_invitation(text, text, text, text) TO partner_runtime;
