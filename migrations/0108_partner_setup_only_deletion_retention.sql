-- 0108 — Retain Partner audit/security history WITHOUT letting it block setup-only deletion.
--
-- WHY. Every Partner on staging was undeletable, including genuinely empty ones: creating a shop
-- through the admin UI necessarily writes partner_management_audit rows, and partner_profiles is
-- created with the organisation. Both FKs were ON DELETE RESTRICT, so "sophie pokemon" — zero
-- users, locations, stations, Card Jobs, credits — was blocked purely by 4 audit rows and 1 profile
-- row. The schema was enforcing "never destroy audit", which is right, by means of "never delete a
-- Partner", which is not the same thing.
--
-- WHAT CHANGES. The three retained-history tables move to ON DELETE SET NULL: the audit row
-- SURVIVES the Partner it describes. Nothing is cascade-deleted from them, ever.
--
-- ATTRIBUTION AFTER DELETION. A retained row whose tenant_id is now NULL would be unattributable,
-- which would make retention worthless. Two additions prevent that:
--   * `deleted_tenant_id` — the original tenant id, copied on the retained row before the FK nulls
--     tenant_id. Deliberately carries NO foreign key, so it can never block a future deletion.
--   * `partner_deleted_tombstones` — ONE row per deleted Partner holding the identity snapshot.
--     Stored once rather than duplicated onto every retained audit row, and reachable by joining
--     `deleted_tenant_id`. This is the smallest representation that keeps retained history
--     meaningful; the per-event payloads (before/after_state, detail) are left exactly as they are.
--
-- partner_profiles moves to ON DELETE CASCADE. Confirmed derivative setup state: trading name,
-- organisation kind, company/VAT number, website, contact, address, onboarding date, internal tier,
-- health note. It holds no independently retained legal, financial, grading or security history —
-- all of which live in the tables that deliberately remain RESTRICT.
--
-- DELIBERATELY NOT CHANGED. Every other RESTRICT FK stays a blocker: partner_card_jobs,
-- partner_submissions, partner_submission_cards, partner_wallets, partner_credit_checkout_sessions,
-- partner_stations, partner_station_events, partner_station_calibrations, partner_supplies_orders,
-- partner_connector_*, partner_contacts, partner_branding, partner_invitations, partner_customers,
-- partner_internal_notes, partner_grading_leases, partner_location_publications, partner_google_*.
-- A Partner with any of those keeps failing closed at the database, which is the intended last line.
--
-- Each DROP CONSTRAINT below is paired with an immediately following ADD CONSTRAINT for the same
-- table and name; the destructive linter verifies that pairing rather than trusting a flag.

-- One identity snapshot per deleted Partner. No FK to partner_organisations: the row it describes
-- is gone by design, and a reference here would recreate the blocker this migration removes.
CREATE TABLE IF NOT EXISTS partner_deleted_tombstones (
  tenant_id            uuid PRIMARY KEY,
  legal_name           text NOT NULL,
  public_ref           uuid,
  organisation_status  text,
  organisation_created_at timestamptz,
  deleted_at           timestamptz NOT NULL DEFAULT now(),
  deleted_by_user_id   uuid,
  deleted_by_email     text,
  deletion_reason      text NOT NULL,
  environment          text,
  snapshot             jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE partner_deleted_tombstones IS
  'Identity context for permanently deleted setup-only Partners. Retained audit/security rows keep deleted_tenant_id and join here.';

-- Retained-history tables: allow NULL, add the durable join key, and switch to SET NULL.
ALTER TABLE partner_management_audit ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE partner_management_audit ADD COLUMN IF NOT EXISTS deleted_tenant_id uuid;
ALTER TABLE partner_management_audit DROP CONSTRAINT IF EXISTS partner_management_audit_tenant_id_fkey;
ALTER TABLE partner_management_audit ADD CONSTRAINT partner_management_audit_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES partner_organisations(id) ON DELETE SET NULL;

ALTER TABLE partner_audit_events ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE partner_audit_events ADD COLUMN IF NOT EXISTS deleted_tenant_id uuid;
ALTER TABLE partner_audit_events DROP CONSTRAINT IF EXISTS partner_audit_events_tenant_id_fkey;
ALTER TABLE partner_audit_events ADD CONSTRAINT partner_audit_events_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES partner_organisations(id) ON DELETE SET NULL;

ALTER TABLE partner_security_events ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE partner_security_events ADD COLUMN IF NOT EXISTS deleted_tenant_id uuid;
ALTER TABLE partner_security_events DROP CONSTRAINT IF EXISTS partner_security_events_tenant_id_fkey;
ALTER TABLE partner_security_events ADD CONSTRAINT partner_security_events_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES partner_organisations(id) ON DELETE SET NULL;

-- Retained rows are queried by the deleted Partner they describe.
CREATE INDEX IF NOT EXISTS idx_partner_management_audit_deleted_tenant ON partner_management_audit (deleted_tenant_id) WHERE deleted_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_audit_events_deleted_tenant   ON partner_audit_events   (deleted_tenant_id) WHERE deleted_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_security_events_deleted_tenant ON partner_security_events (deleted_tenant_id) WHERE deleted_tenant_id IS NOT NULL;

-- Derivative Partner profile state follows the organisation.
ALTER TABLE partner_profiles DROP CONSTRAINT IF EXISTS partner_profiles_tenant_id_fkey;
ALTER TABLE partner_profiles ADD CONSTRAINT partner_profiles_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES partner_organisations(id) ON DELETE CASCADE;
