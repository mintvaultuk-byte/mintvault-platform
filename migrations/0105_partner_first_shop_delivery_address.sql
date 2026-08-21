-- 0105 — Canonical structured delivery address for first-shop onboarding
--
-- A Partner's delivery location has always been `partner_locations`, but the
-- original model had only a display string. Supplies then had to borrow postcode
-- and country from the company profile, making one real shop look incomplete
-- when a different tenant's profile happened to contain an address. These
-- additive fields make the selected shop location the authoritative delivery
-- record for new onboarding. The legacy string remains untouched for existing
-- partners and is used only as an explicit compatibility fallback by the service.

ALTER TABLE partner_locations
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS address_city text,
  ADD COLUMN IF NOT EXISTS address_postcode text,
  ADD COLUMN IF NOT EXISTS address_country text;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_locations' AND column_name='address_postcode'
  ) THEN
    RAISE EXCEPTION '0105 did not add partner_locations.address_postcode';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname='chk_partner_management_audit_action'
       AND pg_get_constraintdef(oid) LIKE '%partner_first_shop_onboarded%'
       AND pg_get_constraintdef(oid) LIKE '%partner_card_job_voided%'
       AND pg_get_constraintdef(oid) LIKE '%partner_created%'
  ) THEN
    RAISE EXCEPTION '0105 did not preserve and widen the Partner management audit vocabulary';
  END IF;
END$$;
