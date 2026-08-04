-- rollback-0044-partner-submission-lifecycle-and-location-snapshot.sql
--
-- Reverses 0044. Apply BEFORE rolling back 0043.
--
-- ⚠️ THIS ROLLBACK IS NOT UNCONDITIONALLY SAFE, AND IT REFUSES RATHER THAN GUESSING.
--
-- Narrowing the status domain back to three values is only possible if NO row currently sits in
-- one of the five states 0044 added. If any submission has reached 'received', 'grading',
-- 'graded', 'awaiting_settlement' or 'completed', re-adding the original constraint would fail on
-- validation anyway — so this script detects that first and raises a clear message naming the
-- offending states, instead of surfacing a bare check_violation.
--
-- Resolving that state is a BUSINESS decision, not a mechanical one: those submissions represent
-- real physical cards somewhere in the workflow, and silently rewriting them to
-- 'submitted_to_mintvault' would erase where they actually are. Do that deliberately, by hand,
-- with the owner's agreement, and only then re-run this script.
--
-- Dropping location_name_snapshot DISCARDS captured history. Once dropped, the original location
-- names as at submission time are not recoverable from the pointer alone.

DO $$
DECLARE
  blocking text;
BEGIN
  SELECT string_agg(DISTINCT status, ', ') INTO blocking
    FROM partner_submissions
   WHERE status IN ('received', 'grading', 'graded', 'awaiting_settlement', 'completed');
  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot roll back 0044: submissions exist in state(s) %. These are real cards in the workflow. Decide where each belongs before narrowing the status domain.',
      blocking;
  END IF;
END$$;

ALTER TABLE partner_submissions DROP CONSTRAINT chk_partner_submissions_status;

ALTER TABLE partner_submissions ADD CONSTRAINT chk_partner_submissions_status
  CHECK (status IN ('draft', 'submitted_to_mintvault', 'cancelled'));

DROP TRIGGER IF EXISTS trg_partner_submissions_location_snapshot ON partner_submissions;
DROP FUNCTION IF EXISTS partner_submissions_capture_location_snapshot();

ALTER TABLE partner_submissions DROP COLUMN IF EXISTS location_name_snapshot;

ALTER TABLE partner_management_audit DROP CONSTRAINT chk_partner_management_audit_action;

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
  'partner_duplicate_override'
));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'partner_submissions'::regclass
       AND conname = 'chk_partner_submissions_status'
       AND pg_get_constraintdef(oid) LIKE '%awaiting_settlement%'
  ) THEN
    RAISE EXCEPTION 'rollback-0044 assertion failed: widened constraint is still present';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'partner_management_audit'::regclass
       AND conname = 'chk_partner_management_audit_action'
       AND pg_get_constraintdef(oid) LIKE '%partner_wallet_backfilled%'
  ) THEN
    RAISE EXCEPTION 'rollback-0044 assertion failed: wallet backfill audit action is still present';
  END IF;
END$$;
