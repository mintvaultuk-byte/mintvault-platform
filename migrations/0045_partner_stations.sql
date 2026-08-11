-- Distributed grading network — canonical Mac/station foundation.
--
-- This is additive. It deliberately extends the existing Partner tenancy model
-- instead of creating a second organisation/device hierarchy. A station is the
-- durable Mac identity; scanner hardware is replaceable provenance.

CREATE TABLE IF NOT EXISTS partner_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_code text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','REVOKED')),
  public_key_pem text NOT NULL,
  public_key_fingerprint char(64) NOT NULL UNIQUE,
  installation_fingerprint char(64),
  credential_epoch integer NOT NULL DEFAULT 1 CHECK (credential_epoch > 0),
  last_request_nonce bigint NOT NULL DEFAULT 0 CHECK (last_request_nonce >= 0),
  app_version text,
  update_channel text NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable','pilot','internal')),
  minimum_supported_version text,
  scanner_connected boolean NOT NULL DEFAULT false,
  scanner_hardware jsonb NOT NULL DEFAULT '{}'::jsonb,
  scanner_hardware_fingerprint char(64),
  scanner_profile_version text,
  calibration_status text NOT NULL DEFAULT 'UNPROVISIONED'
    CHECK (calibration_status IN ('UNPROVISIONED','VALID','INVALID','EXPIRED')),
  current_calibration_id uuid,
  pending_upload_count integer NOT NULL DEFAULT 0 CHECK (pending_upload_count >= 0 AND pending_upload_count <= 1000),
  capture_state text NOT NULL DEFAULT 'IDLE',
  last_failure_code text,
  last_seen_at timestamptz,
  approved_at timestamptz,
  approved_by uuid,
  suspended_at timestamptz,
  suspended_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_station_code CHECK (station_code ~ '^MV-STN-[A-Z2-7]{10,24}$')
);

-- Every real fleet path is tenant/location scoped and bounded by a current
-- status/last-seen filter; these indexes match those access paths.
CREATE INDEX IF NOT EXISTS idx_partner_stations_tenant_location_health
  ON partner_stations (tenant_id, location_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_stations_fleet_status_seen
  ON partner_stations (status, last_seen_at DESC, station_code);
CREATE INDEX IF NOT EXISTS idx_partner_stations_hardware
  ON partner_stations (scanner_hardware_fingerprint) WHERE scanner_hardware_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS partner_station_calibrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  calibration_fingerprint char(64) NOT NULL,
  scanner_hardware_fingerprint char(64) NOT NULL,
  scanner_hardware jsonb NOT NULL,
  scanner_profile_version text NOT NULL,
  acquisition_region jsonb NOT NULL,
  working_region jsonb NOT NULL DEFAULT '{}'::jsonb,
  placement_tolerance_mm jsonb NOT NULL DEFAULT '{}'::jsonb,
  calibration_version text NOT NULL,
  health_status text NOT NULL CHECK (health_status IN ('VALID','INVALID','EXPIRED')),
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (station_id, calibration_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_partner_station_calibrations_station_created
  ON partner_station_calibrations (station_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_station_calibrations_tenant_location
  ON partner_station_calibrations (tenant_id, location_id, created_at DESC);

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_partner_station_current_calibration'
       AND conrelid = 'partner_stations'::regclass
  ) THEN
    ALTER TABLE partner_stations
      ADD CONSTRAINT fk_partner_station_current_calibration
      FOREIGN KEY (current_calibration_id) REFERENCES partner_station_calibrations(id) ON DELETE RESTRICT;
  END IF;
END;
$constraint$;

CREATE TABLE IF NOT EXISTS partner_station_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  actor_user_id uuid,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_station_events_station_created
  ON partner_station_events (station_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_station_events_tenant_created
  ON partner_station_events (tenant_id, created_at DESC);

-- The database enforces cross-table tenant/location consistency. Separate FKs
-- alone would allow a station under tenant A to reference a location in B.
CREATE OR REPLACE FUNCTION partner_station_assert_location_tenant() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE actual_tenant uuid;
BEGIN
  SELECT tenant_id INTO actual_tenant FROM partner_locations WHERE id = NEW.location_id;
  IF actual_tenant IS NULL OR actual_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'partner station location must belong to its tenant';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_partner_station_location_tenant ON partner_stations;
CREATE TRIGGER trg_partner_station_location_tenant
  BEFORE INSERT OR UPDATE OF tenant_id, location_id ON partner_stations
  FOR EACH ROW EXECUTE FUNCTION partner_station_assert_location_tenant();

CREATE OR REPLACE FUNCTION partner_station_calibration_assert_scope() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE station_tenant uuid; station_location uuid;
BEGIN
  SELECT tenant_id, location_id INTO station_tenant, station_location FROM partner_stations WHERE id = NEW.station_id;
  IF station_tenant IS NULL OR station_tenant <> NEW.tenant_id OR station_location <> NEW.location_id THEN
    RAISE EXCEPTION 'station calibration scope must match its station';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_partner_station_calibration_scope ON partner_station_calibrations;
CREATE TRIGGER trg_partner_station_calibration_scope
  BEFORE INSERT ON partner_station_calibrations
  FOR EACH ROW EXECUTE FUNCTION partner_station_calibration_assert_scope();

CREATE OR REPLACE FUNCTION partner_station_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'partner_station_events are append-only';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_partner_station_event_immutable ON partner_station_events;
CREATE TRIGGER trg_partner_station_event_immutable
  BEFORE UPDATE OR DELETE ON partner_station_events
  FOR EACH ROW EXECUTE FUNCTION partner_station_event_immutable();

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_stations','partner_station_calibrations','partner_station_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END;
$rls$;

-- Station rows and calibration are intentionally accessed through the audited
-- server service on the privileged application path. The restricted Partner
-- runtime receives no mutation grant, so a portal SQL mistake cannot approve,
-- revoke, rotate a station key, or alter telemetry directly.
REVOKE ALL ON partner_stations, partner_station_calibrations, partner_station_events FROM PUBLIC;
REVOKE ALL ON partner_stations, partner_station_calibrations, partner_station_events FROM partner_runtime;

-- Scanner capture sessions pre-date the Partner station model. When present,
-- link them to the canonical station UUID and give the claim predicate a
-- station-first index. Fresh estates receive the complete table in 0047.
DO $scanner_sessions$
BEGIN
  IF to_regclass('public.scanner_capture_sessions') IS NOT NULL THEN
    ALTER TABLE scanner_capture_sessions
      ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES partner_stations(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_scanner_capture_station_claim
      ON scanner_capture_sessions (station_id, created_at)
      WHERE state = 'armed';
  END IF;
END;
$scanner_sessions$;
