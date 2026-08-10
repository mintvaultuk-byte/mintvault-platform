-- 0067_certificate_immutable_evidence_ledger.sql
-- Additive, append-only scanner master and derivative lineage. This migration
-- intentionally does not alter historical certificate image columns.

CREATE TABLE certificate_image_masters (
  id BIGSERIAL PRIMARY KEY,
  certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  side VARCHAR(5) NOT NULL CHECK (side IN ('front', 'back')),
  object_key TEXT NOT NULL UNIQUE,
  sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length > 0),
  format VARCHAR(16) NOT NULL CHECK (format = 'tiff'),
  mime_type VARCHAR(64) NOT NULL CHECK (mime_type = 'image/tiff'),
  pixel_width INTEGER NOT NULL CHECK (pixel_width > 0),
  pixel_height INTEGER NOT NULL CHECK (pixel_height > 0),
  bit_depth INTEGER,
  capture_dpi INTEGER,
  capture_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_version INTEGER NOT NULL DEFAULT 1 CHECK (evidence_version > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (certificate_id, side, revision)
);

CREATE TABLE certificate_image_workings (
  id BIGSERIAL PRIMARY KEY,
  master_id BIGINT NOT NULL REFERENCES certificate_image_masters(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  pixel_width INTEGER NOT NULL CHECK (pixel_width > 0),
  pixel_height INTEGER NOT NULL CHECK (pixel_height > 0),
  format VARCHAR(16) NOT NULL CHECK (format = 'jpeg'),
  settings JSONB NOT NULL,
  derivative_version VARCHAR(32) NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE certificate_image_crops (
  id BIGSERIAL PRIMARY KEY,
  working_id BIGINT NOT NULL REFERENCES certificate_image_workings(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  geometry JSONB NOT NULL,
  pixel_width INTEGER NOT NULL CHECK (pixel_width > 0),
  pixel_height INTEGER NOT NULL CHECK (pixel_height > 0),
  format VARCHAR(16) NOT NULL CHECK (format = 'jpeg'),
  derivative_version VARCHAR(32) NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX certificate_image_masters_certificate_side_revision_idx
  ON certificate_image_masters (certificate_id, side, revision DESC);
CREATE INDEX certificate_image_workings_master_created_idx ON certificate_image_workings (master_id, created_at DESC);
CREATE INDEX certificate_image_crops_working_created_idx ON certificate_image_crops (working_id, created_at DESC);

CREATE FUNCTION reject_certificate_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'certificate evidence ledger is append-only';
END;
$$;

CREATE TRIGGER certificate_image_masters_append_only
  BEFORE UPDATE OR DELETE ON certificate_image_masters
  FOR EACH ROW EXECUTE FUNCTION reject_certificate_evidence_mutation();
CREATE TRIGGER certificate_image_workings_append_only
  BEFORE UPDATE OR DELETE ON certificate_image_workings
  FOR EACH ROW EXECUTE FUNCTION reject_certificate_evidence_mutation();
CREATE TRIGGER certificate_image_crops_append_only
  BEFORE UPDATE OR DELETE ON certificate_image_crops
  FOR EACH ROW EXECUTE FUNCTION reject_certificate_evidence_mutation();

-- These are internal evidence tables. The privileged admin pool remains the
-- only application access path; Partner runtime is given no table privilege.
ALTER TABLE certificate_image_masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate_image_masters FORCE ROW LEVEL SECURITY;
ALTER TABLE certificate_image_workings ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate_image_workings FORCE ROW LEVEL SECURITY;
ALTER TABLE certificate_image_crops ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate_image_crops FORCE ROW LEVEL SECURITY;
REVOKE ALL ON certificate_image_masters, certificate_image_workings, certificate_image_crops FROM PUBLIC;
REVOKE ALL ON certificate_image_masters, certificate_image_workings, certificate_image_crops FROM partner_runtime;

