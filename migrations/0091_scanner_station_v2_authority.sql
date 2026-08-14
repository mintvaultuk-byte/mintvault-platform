-- Scanner SOL convergence: station protocol v2, durable semantic mutations,
-- immutable profile revisions and exact capture/evidence authority.
--
-- Expand-only.  The frozen Partner P14 application can continue using every
-- v1 column and table while the Scanner release begins using these contracts.

ALTER TABLE partner_stations
  ADD COLUMN IF NOT EXISTS request_epoch bigint NOT NULL DEFAULT 1 CHECK (request_epoch > 0),
  ADD COLUMN IF NOT EXISTS last_request_sequence bigint NOT NULL DEFAULT 0 CHECK (last_request_sequence >= 0),
  ADD COLUMN IF NOT EXISTS current_profile_revision_id uuid,
  ADD COLUMN IF NOT EXISTS scanner_update_policy jsonb,
  ADD COLUMN IF NOT EXISTS enrolment_expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  ADD COLUMN IF NOT EXISTS replaces_station_id uuid REFERENCES partner_stations(id) ON DELETE RESTRICT;

-- Scanner human sessions use a short access bearer and a separate refresh
-- authority that is useless without the exact station private key.  Existing
-- browser sessions remain WEB and retain their established twelve-hour
-- absolute lifetime; only the dedicated Scanner login/refresh flow writes the
-- SCANNER kind.
ALTER TABLE partner_sessions
  ADD COLUMN IF NOT EXISTS session_kind text NOT NULL DEFAULT 'WEB',
  ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES partner_stations(id) ON DELETE RESTRICT;
ALTER TABLE partner_sessions DROP CONSTRAINT IF EXISTS partner_sessions_session_kind_check;
ALTER TABLE partner_sessions ADD CONSTRAINT partner_sessions_session_kind_check
  CHECK (session_kind IN ('WEB','SCANNER'));

CREATE TABLE IF NOT EXISTS partner_scanner_refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES partner_users(id) ON DELETE RESTRICT,
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  source_session_id uuid NOT NULL REFERENCES partner_sessions(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  credential_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (absolute_expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_partner_scanner_refresh_scope
  ON partner_scanner_refresh_sessions (station_id, user_id, absolute_expires_at DESC);

ALTER TABLE partner_sessions
  ADD COLUMN IF NOT EXISTS scanner_refresh_id uuid REFERENCES partner_scanner_refresh_sessions(id) ON DELETE SET NULL;

-- The SECURITY DEFINER lookup remains the sole pre-tenant session resolver.
-- Project the server-owned session kind/station binding so the application can
-- enforce Scanner-only refresh issuance without trusting a request body.
DROP FUNCTION IF EXISTS partner_session_lookup(text);
CREATE FUNCTION partner_session_lookup(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid, location_id uuid, session_cred_version integer,
  mfa_passed boolean, absolute_expires_at timestamptz, revoked_at timestamptz, last_seen_at timestamptz,
  user_status text, user_cred_version integer, org_status text, location_status text,
  session_kind text, station_id uuid
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $fn$
  SELECT s.id, s.tenant_id, s.user_id, s.location_id, s.credential_version, s.mfa_passed,
         s.absolute_expires_at, s.revoked_at, s.last_seen_at,
         u.status, u.credential_version, o.status, l.status,
         s.session_kind, s.station_id
    FROM partner_sessions s
    JOIN partner_users u ON u.id = s.user_id
    JOIN partner_organisations o ON o.id = s.tenant_id
    LEFT JOIN partner_locations l ON l.id = s.location_id
   WHERE s.token_hash = p_token_hash
$fn$;
GRANT CREATE ON SCHEMA public TO partner_definer;
ALTER FUNCTION partner_session_lookup(text) OWNER TO partner_definer;
REVOKE CREATE ON SCHEMA public FROM partner_definer;
REVOKE ALL ON FUNCTION partner_session_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_session_lookup(text) TO partner_runtime;

-- PENDING enrolments have distinct terminal outcomes.  REJECTED/CANCELLED/
-- EXPIRED are deliberately not aliases for REVOKED: the Scanner uses those
-- exact, fingerprint-bound projections to retire the rejected local key and
-- permit a genuinely fresh enrolment.  REVOKED remains a durable fleet state
-- for an identity that must never silently become a new station.
ALTER TABLE partner_stations DROP CONSTRAINT IF EXISTS partner_stations_status_check;
ALTER TABLE partner_stations ADD CONSTRAINT partner_stations_status_check
  CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','REVOKED','REJECTED','CANCELLED','EXPIRED'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_station_replacement
  ON partner_stations (replaces_station_id) WHERE replaces_station_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scanner_station_semantic_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  semantic_operation_id uuid NOT NULL,
  operation_type text NOT NULL,
  endpoint text NOT NULL,
  actor_user_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','COMPLETED','REFUSED')),
  http_status integer CHECK (http_status BETWEEN 200 AND 599),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (semantic_operation_id),
  CHECK ((state='PENDING' AND http_status IS NULL AND result IS NULL AND completed_at IS NULL)
      OR (state<>'PENDING' AND http_status IS NOT NULL AND result IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_scanner_station_semantic_scope
  ON scanner_station_semantic_operations (tenant_id, location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_station_resync_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  challenge text NOT NULL CHECK (length(challenge) BETWEEN 32 AND 512),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_station_resync_live
  ON partner_station_resync_challenges (station_id) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS partner_station_enrolment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  client_op_id uuid NOT NULL,
  public_key_fingerprint char(64) NOT NULL CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_op_id),
  UNIQUE (station_id)
);

CREATE TABLE IF NOT EXISTS partner_station_profile_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  semantic_operation_id uuid NOT NULL,
  candidate_digest_sha256 char(64) NOT NULL CHECK (candidate_digest_sha256 ~ '^[0-9a-f]{64}$'),
  profile_digest_sha256 char(64) NOT NULL CHECK (profile_digest_sha256 ~ '^[0-9a-f]{64}$'),
  profile jsonb NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semantic_operation_id),
  UNIQUE (station_id, profile_digest_sha256)
);

DO $profile_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_partner_station_current_profile_revision') THEN
    ALTER TABLE partner_stations ADD CONSTRAINT fk_partner_station_current_profile_revision
      FOREIGN KEY (current_profile_revision_id) REFERENCES partner_station_profile_revisions(id) ON DELETE RESTRICT;
  END IF;
END;
$profile_fk$;

ALTER TABLE scanner_capture_sessions
  ADD COLUMN IF NOT EXISTS capture_authorisation_id uuid,
  ADD COLUMN IF NOT EXISTS semantic_operation_id uuid,
  ADD COLUMN IF NOT EXISTS card_job_id uuid REFERENCES partner_card_jobs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS profile_revision_id uuid REFERENCES partner_station_profile_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS profile_digest_sha256 char(64),
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES partner_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS original_operator_id uuid,
  ADD COLUMN IF NOT EXISTS original_operator_role text,
  ADD COLUMN IF NOT EXISTS capture_purpose text,
  ADD COLUMN IF NOT EXISTS evidence_revision integer,
  ADD COLUMN IF NOT EXISTS authorisation_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS authorisation_expires_at timestamptz;

ALTER TABLE partner_card_jobs
  ADD COLUMN IF NOT EXISTS scanner_cancel_operation_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_jobs_scanner_cancel_operation
  ON partner_card_jobs (scanner_cancel_operation_id) WHERE scanner_cancel_operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_authorisation
  ON scanner_capture_sessions (capture_authorisation_id) WHERE capture_authorisation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_semantic_operation
  ON scanner_capture_sessions (semantic_operation_id) WHERE semantic_operation_id IS NOT NULL;

-- A semantic UUID names one business mutation globally.  Reusing it under a
-- different station/tenant must conflict rather than create a second paid job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_job_op_keys_global_client_op
  ON partner_card_job_op_keys (client_op_id);

CREATE TABLE IF NOT EXISTS scanner_capture_rescan_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_session_id text NOT NULL REFERENCES scanner_capture_sessions(id) ON DELETE RESTRICT,
  station_id uuid NOT NULL REFERENCES partner_stations(id) ON DELETE RESTRICT,
  request_operation_id uuid NOT NULL,
  prior_capture_authorisation_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_operation_id),
  UNIQUE (capture_session_id, prior_capture_authorisation_id)
);

ALTER TABLE scanner_evidence_staging
  ADD COLUMN IF NOT EXISTS immutable_binding jsonb;

-- The runtime role is intentionally mutation-limited.  Semantic operations
-- need SELECT/INSERT/UPDATE only to move PENDING to one terminal result.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON scanner_station_semantic_operations TO partner_runtime;
    GRANT SELECT, INSERT ON partner_station_enrolment_operations TO partner_runtime;
    GRANT SELECT, INSERT ON partner_station_profile_revisions TO partner_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_admin') THEN
    GRANT SELECT, INSERT, UPDATE ON partner_scanner_refresh_sessions TO partner_admin;
  END IF;
END$$;

ALTER TABLE scanner_station_semantic_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_station_semantic_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scanner_station_semantic_tenant_isolation ON scanner_station_semantic_operations;
CREATE POLICY scanner_station_semantic_tenant_isolation ON scanner_station_semantic_operations
  USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());

ALTER TABLE partner_station_enrolment_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_station_enrolment_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_station_enrolment_ops_tenant_isolation ON partner_station_enrolment_operations;
CREATE POLICY partner_station_enrolment_ops_tenant_isolation ON partner_station_enrolment_operations
  USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());

ALTER TABLE partner_station_profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_station_profile_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_station_profile_revisions_tenant_isolation ON partner_station_profile_revisions;
CREATE POLICY partner_station_profile_revisions_tenant_isolation ON partner_station_profile_revisions
  USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());

ALTER TABLE partner_station_resync_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_station_resync_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_station_resync_challenges_tenant_isolation ON partner_station_resync_challenges;
CREATE POLICY partner_station_resync_challenges_tenant_isolation ON partner_station_resync_challenges
  USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());
