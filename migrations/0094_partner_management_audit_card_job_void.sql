-- 0094_partner_management_audit_card_job_void.sql
--
-- Forward-only contract repair for the already-committed Partner Card Job void workflow.
--
-- `voidPartnerCardJob()` writes the precise append-only management-audit action
-- `partner_card_job_voided`.  The latest CHECK vocabulary (0084) predates that workflow, so
-- PostgreSQL currently rejects the otherwise-valid audit insert.  This migration changes no
-- table shape and no data: it atomically replaces the named CHECK with the exact 0084 vocabulary
-- plus that one canonical action.  It deliberately does not allow arbitrary text.
--
-- scripts/db/migrate.ts wraps transaction-safe migrations and their journal rows in one
-- transaction.  Do not add BEGIN/COMMIT here: doing so would split this constraint replacement
-- from the migration journal entry.

ALTER TABLE partner_management_audit DROP CONSTRAINT chk_partner_management_audit_action;

ALTER TABLE partner_management_audit ADD CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
  -- ---- preserved verbatim from 0031 / 0033 / 0074 / 0084 ----
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
  -- ---- added by 0094: exact event emitted by voidPartnerCardJob() ----
  'partner_card_job_voided'
));

-- Fail closed if either the exact new event or a representative older vocabulary entry was lost.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'partner_management_audit'::regclass
       AND conname = 'chk_partner_management_audit_action'
       AND pg_get_constraintdef(oid) LIKE '%partner_card_job_voided%'
       AND pg_get_constraintdef(oid) LIKE '%partner_created%'
       AND pg_get_constraintdef(oid) LIKE '%partner_wallet_backfilled%'
       AND pg_get_constraintdef(oid) LIKE '%partner_location_created%'
  ) THEN
    RAISE EXCEPTION '0094 assertion failed: partner management audit vocabulary was not preserved and extended';
  END IF;
END$$;
