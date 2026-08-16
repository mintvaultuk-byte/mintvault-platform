-- 0090 — FORWARD-ONLY LINEAGE CONVERGENCE: scanner persistence for staging-lineage hosts.
--
-- WHY THIS FILE EXISTS
-- =============================================================================================
-- The 2026-08-14 absorb of production v1078 brought production's applied scanner trio into this
-- release at its immutable numbers: 0045_partner_stations, 0046_scanner_processing_jobs,
-- 0047_scanner_evidence_staging (with the MFA pending lifecycle at production's 0044 identity).
-- Staging's journal holds a DIFFERENT lineage at 0044/0046/0047 (its old submission-lifecycle
-- identity — renumbered to 0074 for this release — plus its own MFA-at-0046 and
-- owner-invariant-at-0047 rows). The migration identity guard therefore refuses the colliding
-- release files on staging, permanently and correctly: applied history is immutable.
--
-- Per the guard's own remedy (and the 0073 precedent), those three files are EXCLUDED on such
-- hosts via migrations/lineage-exclusions.json, and THIS migration — at the next globally free
-- number across production (high-water 0073), staging (0073 + this release's 0074-0089) and
-- every reachable branch (0089) — delivers or verifies the excluded content:
--
--   * 0044 MFA pending lifecycle — staging applied the byte-identical body as its own 0046, so
--     the content is PRESENT there; production applied it at 0044; fresh estates apply 0044
--     normally (the exclusion never matches an empty journal). Here it is VERIFIED, not re-run:
--     re-running would be harmless for the DDL but this file must fail loudly if any host ever
--     reaches it without the MFA lifecycle in place.
--   * 0046 scanner_processing_jobs + 0047 scanner evidence staging — genuinely MISSING on
--     staging-lineage hosts. Their bodies are inlined VERBATIM below (both were written fully
--     idempotent: IF NOT EXISTS throughout, REVOKE is repeatable), so this file is a no-op on
--     production and on fresh estates where 0046/0047 already ran.
--
-- DESIGN RULES (same as 0073): introspection-driven, additive-only, idempotent, self-verifying.
-- No journal row is rewritten, renamed or deleted anywhere.

-- ── PRECONDITIONS — fail loudly rather than half-converge ────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION '0090 precondition failed: certificates table is missing';
  END IF;
  IF to_regclass('public.partner_stations') IS NULL THEN
    RAISE EXCEPTION '0090 precondition failed: partner_stations is missing — 0045_partner_stations must apply before 0090';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    RAISE EXCEPTION '0090 precondition failed: role partner_runtime is missing';
  END IF;
END$$;

-- ── VERIFY the excluded 0044 MFA pending lifecycle content is present ────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'partner_mfa_methods'
       AND column_name IN ('enrolment_session_id', 'expires_at', 'consumed_at')
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION '0090 verification failed: partner_mfa_methods lacks the pending-lifecycle columns (0044 content absent on this host)';
  END IF;
  IF to_regclass('public.uq_partner_mfa_one_pending') IS NULL THEN
    RAISE EXCEPTION '0090 verification failed: uq_partner_mfa_one_pending index is missing (0044 content absent on this host)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'partner_auth_lookup'
  ) THEN
    RAISE EXCEPTION '0090 verification failed: partner_auth_lookup() is missing (0044 content absent on this host)';
  END IF;
END$$;

-- ── 0046_scanner_processing_jobs.sql — body inlined VERBATIM ─────────────────────────────────
-- Durable, cross-replica derivative queue for immutable scanner evidence.
-- The master is accepted before derivative work; this table makes that work
-- restart-safe and claimable with SKIP LOCKED instead of retaining a FIFO only
-- in one Node process.

CREATE TABLE IF NOT EXISTS scanner_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id integer NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  station_id uuid REFERENCES partner_stations(id) ON DELETE RESTRICT,
  job_kind text NOT NULL DEFAULT 'scanner_derivatives' CHECK (job_kind = 'scanner_derivatives'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retry','complete','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  rerun_requested boolean NOT NULL DEFAULT false,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- One active request per certificate is enough: a recapture arriving while a
-- worker runs flips rerun_requested, then the worker processes the current
-- immutable evidence pointer once more. This avoids duplicate heavy jobs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_processing_active_certificate
  ON scanner_processing_jobs (certificate_id, job_kind)
  WHERE state IN ('queued','running','retry');

CREATE INDEX IF NOT EXISTS idx_scanner_processing_claim
  ON scanner_processing_jobs (available_at, created_at, id)
  WHERE state IN ('queued','retry');

CREATE INDEX IF NOT EXISTS idx_scanner_processing_expired_lease
  ON scanner_processing_jobs (lease_until, id)
  WHERE state = 'running';

CREATE INDEX IF NOT EXISTS idx_scanner_processing_station_created
  ON scanner_processing_jobs (station_id, created_at DESC)
  WHERE station_id IS NOT NULL;

-- ── 0047_scanner_evidence_staging.sql — body inlined VERBATIM ────────────────────────────────
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

-- ── FINAL VERIFICATION — the converged target must hold on EVERY lineage ─────────────────────
DO $$
DECLARE
  missing text := '';
BEGIN
  IF to_regclass('public.scanner_processing_jobs') IS NULL THEN missing := missing || ' scanner_processing_jobs'; END IF;
  IF to_regclass('public.certificate_image_evidence') IS NULL THEN missing := missing || ' certificate_image_evidence'; END IF;
  IF to_regclass('public.scanner_capture_sessions') IS NULL THEN missing := missing || ' scanner_capture_sessions'; END IF;
  IF to_regclass('public.scanner_evidence_staging') IS NULL THEN missing := missing || ' scanner_evidence_staging'; END IF;
  IF to_regclass('public.uq_scanner_processing_active_certificate') IS NULL THEN missing := missing || ' uq_scanner_processing_active_certificate'; END IF;
  IF to_regclass('public.uq_scanner_evidence_staging_active_session') IS NULL THEN missing := missing || ' uq_scanner_evidence_staging_active_session'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'certificates'
       AND column_name IN ('raw_uploaded', 'ingest_idempotency_key')
    HAVING count(*) = 2
  ) THEN missing := missing || ' certificates.raw_uploaded/ingest_idempotency_key'; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '0090 final verification failed — missing:%', missing;
  END IF;
END$$;
