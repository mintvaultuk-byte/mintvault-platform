-- rollback-0031-partner-user-management.sql
-- Roll back Partner User Management additions from 0031_partner_user_management.sql.
-- Intended for disposable/staging rollback verification only; do not run against production without
-- founder approval because it removes invitation rows and user display-name columns.
--
-- Audit rows are immutable evidence and may already contain 0031 action types. The rollback therefore
-- restores a constrained allowlist that still accepts those retained audit action values; otherwise a
-- real rollback after feature use would drop the constraint and then fail while re-adding the old one.

ALTER TABLE partner_management_audit DROP CONSTRAINT IF EXISTS chk_partner_management_audit_action;
ALTER TABLE partner_management_audit ADD CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
  'partner_created','profile_updated','status_changed','contact_added','contact_updated',
  'contact_deactivated','branding_updated','note_added',
  'partner_user_invited','partner_invitation_resent','partner_invitation_revoked',
  'partner_invitation_accepted','partner_user_role_changed','partner_user_suspended',
  'partner_user_reactivated','partner_user_password_reset_initiated',
  'partner_user_sessions_revoked','partner_user_membership_removed'
));

DROP TABLE IF EXISTS partner_invitations;

ALTER TABLE partner_users DROP COLUMN IF EXISTS first_name;
ALTER TABLE partner_users DROP COLUMN IF EXISTS last_name;
