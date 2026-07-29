-- 0031_partner_user_management.sql
-- Partner Network — Super Admin partner-user management + invitation acceptance.
--
-- Additive only. No MintVault grading, certificate, payment, credit, label or auth/RBAC tables outside
-- the partner_* family are modified. Existing partner_users remains the membership/login table; this
-- migration adds user display-name fields and a tenant-bound, single-use invitation table.

ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS last_name text;

CREATE TABLE IF NOT EXISTS partner_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  email text NOT NULL,
  role_code text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING',
  superseded_by uuid REFERENCES partner_invitations(id) ON DELETE SET NULL,
  invited_by_user_id uuid,
  invited_by_email text,
  delivered_at timestamptz,
  delivery_error text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_invitations_status CHECK (status IN ('PENDING','SENT','DELIVERY_FAILED','CONSUMED','REVOKED','EXPIRED'))
);

CREATE INDEX IF NOT EXISTS idx_partner_invitations_tenant ON partner_invitations(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_partner_invitations_user ON partner_invitations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_partner_invitations_active_user
  ON partner_invitations(user_id) WHERE status IN ('PENDING','SENT','DELIVERY_FAILED');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_partner_management_audit_action'
       AND conrelid = 'partner_management_audit'::regclass
  ) THEN
    ALTER TABLE partner_management_audit DROP CONSTRAINT chk_partner_management_audit_action;
  END IF;
END$$;

ALTER TABLE partner_management_audit ADD CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
  'partner_created','profile_updated','status_changed','contact_added','contact_updated',
  'contact_deactivated','branding_updated','note_added',
  'partner_user_invited','partner_invitation_resent','partner_invitation_revoked',
  'partner_invitation_accepted','partner_user_role_changed','partner_user_suspended',
  'partner_user_reactivated','partner_user_password_reset_initiated',
  'partner_user_sessions_revoked','partner_user_membership_removed'
));

DO $$
BEGIN
  ALTER TABLE partner_invitations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE partner_invitations FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS partner_invitations_tenant_isolation ON partner_invitations;
  CREATE POLICY partner_invitations_tenant_isolation ON partner_invitations
    USING (tenant_id = partner_current_tenant())
    WITH CHECK (tenant_id = partner_current_tenant());
END$$;

GRANT SELECT, INSERT, UPDATE ON partner_invitations TO partner_runtime;
