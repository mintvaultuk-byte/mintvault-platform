-- ============================================================================================
-- ROLLBACK 0084 — PARTNER LOCATION MANAGEMENT
--
-- Narrows the management-audit action vocabulary back to the 0074 set and drops the two indexes
-- 0084 added. Forward-fix is preferred; this exists for the release rollback path.
--
-- SAFE ONLY WHILE NO ROW CARRIES A 0084 ACTION TYPE. Narrowing a CHECK against existing rows fails,
-- which is the correct outcome — it refuses rather than silently discarding audit history. The
-- guard below turns that into a message an operator can act on.
--
-- Dropping the unique index cannot lose data; it only stops future duplicate-name prevention.
-- ============================================================================================

DO $$
DECLARE
  v_offending bigint;
BEGIN
  SELECT count(*) INTO v_offending
    FROM partner_management_audit
   WHERE action_type IN (
     'partner_location_created','partner_location_updated',
     'partner_location_status_changed','partner_user_locations_changed'
   );
  IF v_offending > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 0084: % management-audit row(s) record location actions. Narrowing the constraint would orphan real audit history — resolve deliberately, do not force.',
      v_offending;
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
  'partner_wallet_backfilled'
));

DROP INDEX IF EXISTS uq_partner_locations_tenant_name_live;
DROP INDEX IF EXISTS idx_partner_locations_tenant_status;
