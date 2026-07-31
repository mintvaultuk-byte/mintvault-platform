-- rollback-0033-partner-audit-action-precision.sql
--
-- Restores chk_partner_management_audit_action to its 18-value (0031) form.
--
-- REFUSES TO RUN if any row already uses one of the four values 0033 added. Narrowing the constraint
-- underneath such a row would make ADD CONSTRAINT fail with an opaque violation, or — worse, if it
-- were ever run with NOT VALID — leave the ledger holding values the constraint claims are
-- impossible. The append-only audit ledger must never be put in that state, so this fails loudly and
-- early with an explanation instead.
--
-- House style: matches the fail-closed refusal used by the other partner rollback scripts.

BEGIN;

DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM partner_management_audit
   WHERE action_type IN (
     'partner_user_mfa_reset','partner_invitation_amended',
     'partner_legal_name_changed','partner_duplicate_override'
   );

  IF offending > 0 THEN
    RAISE EXCEPTION
      'rollback-0033 refuses to run: % audit row(s) already use an action type added by 0033. '
      'Narrowing the constraint would contradict the append-only ledger. '
      'Re-point those rows or keep 0033 applied.', offending;
  END IF;
END$$;

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

COMMIT;
