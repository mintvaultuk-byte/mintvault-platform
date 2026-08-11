-- Scanner persistence required by the signed-station staged TIFF path.
--
-- This migration is intentionally self-sufficient: this production release
-- must not rely on application-startup DDL. Every statement is additive and
-- idempotent; no historical certificate, evidence, or object is deleted.

-- Legacy scanner ingestion prerequisite. Production already has these fields,
-- but a fresh production-shaped estate must receive the same atomic replay
-- gate before the matching application release is started.
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS raw_uploaded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ingest_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_ingest_idem
  ON certificates (ingest_idempotency_key);

-- Immutable evidence revision ledger. A current pointer is explicit so a
-- controlled recapture appends history rather than replacing or deleting a
-- prior master. This is required before any capture session can be armed.
CREATE TABLE IF NOT EXISTS certificate_image_evidence (
  id serial PRIMARY KEY,
  certificate_id integer NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  side varchar(5) NOT NULL CHECK (side IN ('front', 'back')),
  evidence_class varchar(32) NOT NULL CHECK (evidence_class IN ('NEW_IMMUTABLE_MASTER', 'LEGACY_DERIVED_ONLY')),
  evidence_version varchar(32) NOT NULL DEFAULT 'v1',
  object_key text NOT NULL UNIQUE,
  sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  pixel_width integer NOT NULL CHECK (pixel_width > 0),
  pixel_height integer NOT NULL CHECK (pixel_height > 0),
  bit_depth integer,
  dpi integer,
  format varchar(16) NOT NULL,
  capture_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  working_object_key text,
  working_sha256 varchar(64),
  working_width integer,
  working_height integer,
  working_format varchar(16),
  working_settings jsonb,
  is_current boolean NOT NULL DEFAULT true,
  superseded_at timestamptz,
  superseded_by_id integer REFERENCES certificate_image_evidence(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_certificate_image_evidence_current_side
  ON certificate_image_evidence (certificate_id, side)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_certificate_image_evidence_sha
  ON certificate_image_evidence (sha256);

-- Server-owned temporary object-store namespace for direct scanner TIFF PUTs.
-- The station receives only an opaque, short-lived URL for the row created
-- here. Finalisation re-reads, validates and promotes bytes to the immutable
-- content-addressed evidence namespace; staging is never authoritative.

-- Legacy development installations historically bootstrapped this table at
-- application startup. A numbered migration must also be self-sufficient on a
-- fresh estate: otherwise applying 0047 before the first app boot would fail.
CREATE TABLE IF NOT EXISTS scanner_capture_sessions (
  id text PRIMARY KEY,
  certificate_id integer NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  card_id integer,
  submission_item_id integer,
  submission_id integer,
  side varchar(5) NOT NULL CHECK (side IN ('front','back')),
  workstation_id text NOT NULL,
  station_id uuid REFERENCES partner_stations(id) ON DELETE RESTRICT,
  scanner_profile_version text NOT NULL,
  actor_id text,
  state varchar(16) NOT NULL CHECK (state IN ('armed','claimed','capturing','captured','failed','expired','cancelled')),
  claimed_by_device_id text,
  recapture boolean NOT NULL DEFAULT false,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  captured_at timestamptz,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scanner_capture_station_claim
  ON scanner_capture_sessions (station_id, created_at)
  WHERE state = 'armed';

CREATE INDEX IF NOT EXISTS idx_scanner_capture_expiry
  ON scanner_capture_sessions (expires_at, id)
  WHERE state IN ('armed','claimed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_one_active_target
  ON scanner_capture_sessions (certificate_id, side)
  WHERE state IN ('armed', 'claimed', 'capturing');

CREATE TABLE IF NOT EXISTS scanner_evidence_staging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_session_id text NOT NULL REFERENCES scanner_capture_sessions(id) ON DELETE RESTRICT,
  station_id uuid REFERENCES partner_stations(id) ON DELETE RESTRICT,
  object_key text NOT NULL UNIQUE,
  expected_sha256 char(64) NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_bytes bigint NOT NULL CHECK (expected_bytes > 0 AND expected_bytes <= 134217728),
  capture_provenance jsonb NOT NULL,
  state text NOT NULL DEFAULT 'granted' CHECK (state IN ('granted','finalizing','accepted','failed','expired')),
  expires_at timestamptz NOT NULL,
  finalizing_at timestamptz,
  accepted_at timestamptz,
  failure_reason text,
  staging_deleted_at timestamptz,
  cleanup_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scanner_evidence_staging
  ADD COLUMN IF NOT EXISTS staging_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_claimed_at timestamptz;

-- A session can have one live candidate only. The scanner may retry that same
-- staging key safely; it cannot obtain a second candidate for a stale target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_evidence_staging_active_session
  ON scanner_evidence_staging (capture_session_id)
  WHERE state IN ('granted','finalizing');

CREATE INDEX IF NOT EXISTS idx_scanner_evidence_staging_expiry
  ON scanner_evidence_staging (expires_at, id)
  WHERE state IN ('granted','finalizing');

CREATE INDEX IF NOT EXISTS idx_scanner_evidence_staging_station_created
  ON scanner_evidence_staging (station_id, created_at DESC)
  WHERE station_id IS NOT NULL;

REVOKE ALL ON scanner_evidence_staging FROM PUBLIC;
REVOKE ALL ON scanner_evidence_staging FROM partner_runtime;
