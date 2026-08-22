-- Disposable/staging rollback for 0105_partner_first_shop_delivery_address.sql.
--
-- DESTRUCTIVE: dropping these columns destroys every structured delivery address
-- captured through first-shop onboarding. The legacy partner_locations.address string
-- is untouched, but a shop onboarded AFTER 0105 stored its address only in these
-- columns and will be left with no delivery address at all. Production use therefore
-- requires an explicit data-retention decision and, if any structured row exists, a
-- back-fill of the legacy string first.
ALTER TABLE partner_locations
  DROP COLUMN IF EXISTS address_line1,
  DROP COLUMN IF EXISTS address_line2,
  DROP COLUMN IF EXISTS address_city,
  DROP COLUMN IF EXISTS address_postcode,
  DROP COLUMN IF EXISTS address_country;

-- Restore the management-audit vocabulary to its pre-0105 (0096) state. Any audit row
-- already written as 'partner_first_shop_onboarded' would violate the narrowed
-- constraint, so it is retired to the closest surviving term first rather than deleted:
-- the ledger is append-only and losing rows is worse than losing precision.
UPDATE partner_management_audit
   SET action_type = 'partner_created'
 WHERE action_type = 'partner_first_shop_onboarded';

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
  'partner_card_job_voided'
));
