-- 0033_partner_audit_action_precision.sql
--
-- ADDITIVE ONLY. Extends chk_partner_management_audit_action with four precise action types so that
-- security-relevant admin operations are labelled honestly in the append-only management ledger.
--
-- WHY: the constraint (0015, re-issued 0031) permits 18 values, none of which describes an MFA reset,
-- an amended invitation, a company rename, or an acknowledged duplicate override. Those operations
-- currently either cannot be recorded at all, or are recorded under a NEIGHBOURING action:
--   * a company rename is written as `profile_updated`
--   * an amended invitation is written as `partner_user_invited`
-- Both are defensible descriptions of the physical write, but neither lets an auditor answer
-- "who reset this account's second factor?" or "which invitation was redirected, and to where?".
-- Mislabelling a security action is worse than a slightly noisier constraint.
--
-- SCOPE DISCIPLINE: this migration adds FOUR values and changes nothing else. It creates no table,
-- no column, no index, and no trigger. It does not touch force-password-change, address_county,
-- Draft mode, the Test Partner marker, or logo upload — all deliberately deferred.
--
-- SAFETY: every one of the existing 18 values is preserved verbatim. Because the new list is a strict
-- SUPERSET of the old one, no existing row can be invalidated — PostgreSQL revalidates the table on
-- ADD CONSTRAINT, and a superset cannot reject a row the subset already accepted. The DROP/ADD pair
-- is the same shape migration 0031 used to extend this identical constraint.
--
-- REVERSIBLE: migrations/rollback-0033-partner-audit-action-precision.sql restores the 18-value
-- version. That rollback is only safe while no row uses one of the four new values; the rollback
-- script checks for exactly that and refuses rather than silently failing.

BEGIN;

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
  -- ---- the original 18, preserved verbatim from 0031 ----
  'partner_created','profile_updated','status_changed','contact_added','contact_updated',
  'contact_deactivated','branding_updated','note_added',
  'partner_user_invited','partner_invitation_resent','partner_invitation_revoked',
  'partner_invitation_accepted','partner_user_role_changed','partner_user_suspended',
  'partner_user_reactivated','partner_user_password_reset_initiated',
  'partner_user_sessions_revoked','partner_user_membership_removed',
  -- ---- the four added by 0033 (owner-approved, Option B) ----
  'partner_user_mfa_reset',      -- second factor cleared; the user must re-enrol before signing in
  'partner_invitation_amended',  -- pending invitation corrected: old token revoked, new one issued
  'partner_legal_name_changed',  -- organisation renamed (previously recorded as profile_updated)
  'partner_duplicate_override'   -- admin acknowledged a soft duplicate warning and proceeded
));

COMMIT;
