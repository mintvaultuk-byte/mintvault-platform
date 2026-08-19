-- ============================================================================================
-- 0096 — PARTNER CARD JOB VOID MANAGEMENT AUDIT ACTION
--
-- WHY THIS EXISTS
--
-- `voidPartnerCardJob()` writes a Super-Admin management audit envelope with action_type
-- `partner_card_job_voided`. The service union already declared that action, but the newest
-- `partner_management_audit.action_type` CHECK constraint (0084) did not permit it. That means the
-- protected void path could complete its domain work and then fail at its audit boundary — exactly
-- the kind of "fix exists but cannot be recorded" failure the management-audit constraint is meant
-- to prevent.
--
-- WHAT THIS MIGRATION DOES
--
-- Widen the existing CHECK constraint by one explicit action. No rows are deleted or updated. Every
-- previously permitted value from 0084 is preserved verbatim. The DROP/ADD is transactional and is
-- approved only for this named CHECK widen.
--
-- SCOPE: PARTNER. Touches only partner_management_audit and depends only on partner-management
-- tables already created by 0015/0033/0084 lineages.
-- ============================================================================================

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
  'partner_user_locations_changed',
  'partner_card_job_voided'
));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_partner_management_audit_action'
       AND pg_get_constraintdef(oid) LIKE '%partner_card_job_voided%'
       AND pg_get_constraintdef(oid) LIKE '%partner_location_created%'
       AND pg_get_constraintdef(oid) LIKE '%partner_user_mfa_reset%'
       AND pg_get_constraintdef(oid) LIKE '%partner_created%'
  ) THEN
    RAISE EXCEPTION '0096 did not widen chk_partner_management_audit_action safely';
  END IF;
END$$;
