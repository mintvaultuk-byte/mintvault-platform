-- rollback-0096-partner-card-job-void-management-audit.sql
--
-- Narrows chk_partner_management_audit_action back to the 0084 vocabulary. This rollback refuses if
-- any real audit row already records `partner_card_job_voided`, because narrowing the constraint
-- after history exists would orphan immutable management evidence.

DO $$
DECLARE
  used_count integer;
BEGIN
  SELECT count(*) INTO used_count
    FROM partner_management_audit
   WHERE action_type = 'partner_card_job_voided';
  IF used_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 0096: % management-audit row(s) record partner_card_job_voided.',
      used_count;
  END IF;
END$$;

ALTER TABLE partner_management_audit DROP CONSTRAINT IF EXISTS chk_partner_management_audit_action;

ALTER TABLE partner_management_audit ADD CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
  'partner_created','profile_updated','status_changed','contact_added','contact_updated',
  'contact_deactivated','branding_updated','note_added',
  'partner_user_invited','partner_invitation_resent','partner_invitation_revoked',
  'partner_invitation_accepted','partner_user_role_changed','partner_user_suspended',
  'partner_user_reactivated','partner_user_password_reset_initiated',
  'partner_user_sessions_revoked','partner_user_membership_removed',
  'partner_user_mfa_reset',
  'partner_invitation_amended',
  'partner_legal_name_changed',
  'partner_duplicate_override',
  'partner_wallet_backfilled',
  'partner_location_created',
  'partner_location_updated',
  'partner_location_status_changed',
  'partner_user_locations_changed'
));
