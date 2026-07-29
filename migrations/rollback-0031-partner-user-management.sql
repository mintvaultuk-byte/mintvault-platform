-- rollback-0031-partner-user-management.sql
-- Roll back Partner User Management additions from 0031_partner_user_management.sql.
-- Intended for disposable/staging rollback verification only; do not run against production without
-- founder approval because it removes invitation evidence and user display-name columns.

ALTER TABLE partner_management_audit DROP CONSTRAINT IF EXISTS chk_partner_management_audit_action;
ALTER TABLE partner_management_audit ADD CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
  'partner_created','profile_updated','status_changed','contact_added','contact_updated',
  'contact_deactivated','branding_updated','note_added'
));

DROP TABLE IF EXISTS partner_invitations;

ALTER TABLE partner_users DROP COLUMN IF EXISTS first_name;
ALTER TABLE partner_users DROP COLUMN IF EXISTS last_name;
