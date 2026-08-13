-- ============================================================================================
-- 0084 — PARTNER LOCATION MANAGEMENT (AG-1)
--
-- WHY THIS EXISTS
--
-- partner_locations has been multi-location-capable since 0001: tenant-scoped rows, a status
-- ladder, per-user assignment through partner_user_locations, and a station binding that already
-- carries (tenant_id, location_id). What has never existed is any way to CREATE a second one.
-- createPartner() inserts exactly one row named 'Main location' and there is no other INSERT into
-- partner_locations anywhere in the server tree.
--
-- The consequence is not cosmetic. It silently caps stations to one shop floor, makes the Scanner's
-- location selector dead code (it self-hides at <=1 permitted location), and means a partner with
-- two shops cannot be represented at all.
--
-- WHAT THIS MIGRATION DOES, AND DELIBERATELY DOES NOT DO
--
-- It does NOT create a second location model. partner_locations is already correct and is reused
-- exactly as it stands — no new table, no new column, no backfill, no rename. The ONLY thing
-- missing at the DB level is that partner_management_audit.action_type is CHECK-constrained to an
-- enumerated list, so the new administrative actions could not be recorded honestly. Recording a
-- location rename as 'profile_updated' is precisely the "borrowing a neighbouring action type"
-- that 0033 was written to stop.
--
-- ADDITIVE ONLY. Every previously-permitted action_type is preserved verbatim; this widens the
-- constraint and changes no row. Applying it to a database with no location work yet is a no-op
-- beyond the constraint swap, so an older app version continues to run against it unchanged
-- (invariant I17: the old code simply never emits the new values).
--
-- ROLLBACK: rollback-0084-partner-location-management.sql narrows the constraint back, and is safe
-- to apply only while no rows carry the new action types. Forward-fix is preferred.
-- ============================================================================================

-- ---------------------------------------------------------------------------------------------
-- PART 1 — widen the management-audit action vocabulary
-- ---------------------------------------------------------------------------------------------
ALTER TABLE partner_management_audit DROP CONSTRAINT IF EXISTS chk_partner_management_audit_action;

ALTER TABLE partner_management_audit ADD CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (
  -- ---- preserved verbatim from 0031 / 0033 / 0074 ----
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
  -- ---- added by 0084 (AG-1 multi-location) ----
  'partner_location_created',        -- a new shop floor was added to this organisation
  'partner_location_updated',        -- name/address corrected; identity and history unchanged
  'partner_location_status_changed', -- ACTIVE <-> SUSPENDED; never a delete
  'partner_user_locations_changed'   -- which shop floors a named user may operate at
));

-- ---------------------------------------------------------------------------------------------
-- PART 2 — one ACTIVE location name per tenant
--
-- Two shop floors called "Rochester" in one organisation is an operator-error generator: the
-- Scanner selector, the station list and every audit line become ambiguous at exactly the moment
-- someone is trying to work out which Mac did what. Scoped to non-suspended rows so a closed shop
-- can be reopened under its old name, and so renaming away from a clash is always possible.
--
-- Case-insensitive and whitespace-insensitive, because "Rochester" and "rochester " are the same
-- shop to everybody except a byte comparison.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_locations_tenant_name_live
  ON partner_locations (tenant_id, lower(btrim(name)))
  WHERE status <> 'SUSPENDED';

-- Multi-location makes this the hot path: "every location of this tenant, active first".
CREATE INDEX IF NOT EXISTS idx_partner_locations_tenant_status
  ON partner_locations (tenant_id, status, name);

-- ---------------------------------------------------------------------------------------------
-- PART 3 — fail-closed assertions, in the same transaction as the change
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_partner_management_audit_action'
       AND pg_get_constraintdef(oid) LIKE '%partner_location_created%'
  ) THEN
    RAISE EXCEPTION '0084 did not widen chk_partner_management_audit_action';
  END IF;

  -- The pre-existing vocabulary must still be permitted. A migration that widens a constraint by
  -- accidentally replacing it would pass the check above and silently break every older action.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_partner_management_audit_action'
       AND pg_get_constraintdef(oid) LIKE '%partner_wallet_backfilled%'
       AND pg_get_constraintdef(oid) LIKE '%partner_created%'
  ) THEN
    RAISE EXCEPTION '0084 dropped previously-permitted management audit actions';
  END IF;

  IF to_regclass('public.uq_partner_locations_tenant_name_live') IS NULL THEN
    RAISE EXCEPTION '0084 did not create uq_partner_locations_tenant_name_live';
  END IF;
END$$;
