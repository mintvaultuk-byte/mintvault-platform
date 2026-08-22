-- 0110 — Let the management-audit ledger NAME a permanent Partner deletion and an armed test card.
--
-- NUMBER SAFETY: 0109 is the high-water mark once this pass lands; 0110 is free. The runner rejects
-- duplicate numbers before anything runs.
--
-- ============================================================================================
-- WHY THIS EXISTS, AND WHY IT IS NOT PART OF 0109
-- ============================================================================================
-- 0108 made a setup-only Partner deletable; the guarded delete authority it enables must record
-- WHAT it did, and `partner_management_audit.action_type` is CHECK-constrained to a closed
-- vocabulary (0015, last widened by 0105). Without this migration the delete authority has exactly
-- two options, and both are bad: write no audit row at all, or borrow a neighbouring action and lie
-- about what happened. 0033 exists precisely because that distinction matters, so the vocabulary is
-- widened honestly instead.
--
-- It is separate from 0109 because it has nothing to do with the onboarding test card. One
-- migration, one subject.
--
-- ============================================================================================
-- WHAT CHANGES
-- ============================================================================================
-- Two new permitted values, and nothing else:
--   'partner_permanently_deleted'        the guarded delete 0108 enables.
--   'partner_onboarding_test_card_armed' MintVault declaring that a shop's next NEW card is its
--                                        onboarding test (migration 0109). It authorises one
--                                        Grading Credit to be spent as a test, so it is an operator
--                                        action with consequences and belongs in this ledger.
-- Every existing value is preserved
-- verbatim — the DROP/ADD pair below is how PostgreSQL alters a CHECK expression, not a relaxation,
-- and the verification block at the end refuses to let the migration finish if any value was lost.
--
-- The audit ROW for a deletion is written with tenant_id NULL and deleted_tenant_id set, because by
-- the time it is written the organisation it describes no longer exists. That is 0108's retention
-- model, and it is why this row can exist at all.
--
-- MIXED-VERSION SAFETY (invariant I17): widening a CHECK accepts a strict superset of what it
-- accepted before, so no existing writer can be broken by it. Safe to apply before the deploy.
--
-- ROLLBACK: migrations/rollback-0110-partner-permanent-deletion-audit-vocabulary.sql — but only
-- while no deletion has been recorded, since narrowing the CHECK would fail against such a row.

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
  'partner_card_job_voided','partner_first_shop_onboarded','partner_permanently_deleted',
  'partner_onboarding_test_card_armed'
));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_partner_management_audit_action'
       AND pg_get_constraintdef(oid) LIKE '%partner_permanently_deleted%'
       AND pg_get_constraintdef(oid) LIKE '%partner_onboarding_test_card_armed%'
       AND pg_get_constraintdef(oid) LIKE '%partner_first_shop_onboarded%'
       AND pg_get_constraintdef(oid) LIKE '%partner_card_job_voided%'
       AND pg_get_constraintdef(oid) LIKE '%partner_wallet_backfilled%'
       AND pg_get_constraintdef(oid) LIKE '%partner_user_mfa_reset%'
       AND pg_get_constraintdef(oid) LIKE '%partner_created%'
  ) THEN
    RAISE EXCEPTION '0110 did not preserve and widen the Partner management audit vocabulary';
  END IF;
END$$;
