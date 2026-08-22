-- ROLLBACK for 0110 — narrow the management-audit vocabulary back to the 0105 set.
--
-- ONLY safe while NO permanent deletion has been recorded. A single existing
-- 'partner_permanently_deleted' row makes this ALTER fail, which is the correct outcome: the audit
-- ledger is append-only and a rollback must never be allowed to delete evidence to fit a constraint.

ALTER TABLE partner_management_audit DROP CONSTRAINT IF EXISTS chk_partner_management_audit_action;

ALTER TABLE partner_management_audit ADD CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
  'partner_created','profile_updated','status_changed','contact_added','contact_updated',
  'contact_deactivated','branding_updated','note_added',
  'partner_user_invited','partner_invitation_resent','partner_invitation_revoked',
  'partner_invitation_accepted','partner_user_role_changed','partner_user_suspended',
  'partner_user_reactivated','partner_user_password_reset_initiated',
  'partner_user_sessions_revoked','partner_user_membership_removed',
  'partner_user_mfa_reset','partner_invitation_amended','partner_legal_name_changed',
  'partner_duplicate_override','partner_wallet_backfilled','partner_location_created',
  'partner_location_updated','partner_location_status_changed','partner_user_locations_changed',
  'partner_card_job_voided','partner_first_shop_onboarded'
));
