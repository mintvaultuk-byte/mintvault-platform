-- 0102 — Partner Google Business Profile presence (OPTIONAL, PARTNER scope).
--
-- Additive foundation only. Google is not a Partner authority and these tables
-- are deliberately absent from the whole-portal schema contract. Applying this
-- migration cannot enable the feature: the independent global flag and complete
-- Google environment are both required at the route boundary.

DO $$ BEGIN
  IF to_regclass('public.partner_locations') IS NULL THEN
    RAISE EXCEPTION '0102 requires partner_locations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='partner_locations'::regclass AND conname='uq_partner_locations_tenant_id'
  ) THEN
    ALTER TABLE partner_locations
      ADD CONSTRAINT uq_partner_locations_tenant_id UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='partner_users'::regclass AND conname='uq_partner_users_tenant_id'
  ) THEN
    ALTER TABLE partner_users
      ADD CONSTRAINT uq_partner_users_tenant_id UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='partner_sessions'::regclass AND conname='uq_partner_sessions_tenant_user_id'
  ) THEN
    ALTER TABLE partner_sessions
      ADD CONSTRAINT uq_partner_sessions_tenant_user_id UNIQUE (tenant_id, user_id, id);
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS partner_google_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  state_hash char(64) NOT NULL UNIQUE,
  code_verifier_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_google_oauth_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_google_oauth_session FOREIGN KEY (tenant_id, actor_user_id, session_id)
    REFERENCES partner_sessions(tenant_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_partner_google_oauth_expiry CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_partner_google_oauth_state_tenant
  ON partner_google_oauth_states(tenant_id, actor_user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS partner_google_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  google_account_name text,
  google_location_name text,
  google_place_id text,
  google_maps_uri text,
  business_name text,
  business_address text,
  connection_status text NOT NULL DEFAULT 'PENDING_SELECTION',
  connected_by uuid NOT NULL,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_google_connection_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_google_connection_actor FOREIGN KEY (tenant_id, connected_by)
    REFERENCES partner_users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_partner_google_connection_binding UNIQUE (tenant_id, location_id, id),
  CONSTRAINT chk_partner_google_connection_status CHECK (
    connection_status IN ('PENDING_SELECTION','CONNECTED','ACTION_REQUIRED','REVOKED','ERROR','DISCONNECTED')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_google_current_location
  ON partner_google_connections(location_id)
  WHERE connection_status IN ('PENDING_SELECTION','CONNECTED','ACTION_REQUIRED','REVOKED','ERROR');
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_google_current_resource
  ON partner_google_connections(lower(google_location_name))
  WHERE google_location_name IS NOT NULL
    AND connection_status IN ('CONNECTED','ACTION_REQUIRED','REVOKED','ERROR');
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_google_current_place
  ON partner_google_connections(lower(google_place_id))
  WHERE google_place_id IS NOT NULL
    AND connection_status IN ('CONNECTED','ACTION_REQUIRED','REVOKED','ERROR');

CREATE TABLE IF NOT EXISTS partner_google_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  connection_id uuid NOT NULL UNIQUE,
  refresh_token_ciphertext text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_google_credential_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_google_credential_connection FOREIGN KEY (tenant_id, location_id, connection_id)
    REFERENCES partner_google_connections(tenant_id, location_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS partner_google_location_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  candidate_handle text NOT NULL UNIQUE,
  google_account_name text NOT NULL,
  google_location_name text NOT NULL,
  google_place_id text,
  google_maps_uri text,
  business_name text NOT NULL,
  business_address text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_google_candidate_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES partner_locations(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_partner_google_candidate_connection FOREIGN KEY (tenant_id, location_id, connection_id)
    REFERENCES partner_google_connections(tenant_id, location_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_partner_google_candidates_connection
  ON partner_google_location_candidates(connection_id, expires_at);

CREATE TABLE IF NOT EXISTS partner_google_profile_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  connection_id uuid NOT NULL UNIQUE,
  business_name text NOT NULL,
  business_address text,
  google_place_id text,
  google_maps_uri text,
  source_updated_at timestamptz,
  cached_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT fk_partner_google_cache_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_google_cache_connection FOREIGN KEY (tenant_id, location_id, connection_id)
    REFERENCES partner_google_connections(tenant_id, location_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_google_oauth_states','partner_google_connections','partner_google_credentials',
    'partner_google_location_candidates','partner_google_profile_cache'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  partner_google_oauth_states, partner_google_connections, partner_google_credentials,
  partner_google_location_candidates, partner_google_profile_cache
TO partner_runtime;

DO $$ BEGIN
  IF to_regclass('public.partner_google_connections') IS NULL
     OR to_regclass('public.partner_google_credentials') IS NULL
     OR to_regclass('public.partner_google_profile_cache') IS NULL THEN
    RAISE EXCEPTION '0102 Google presence schema is incomplete';
  END IF;
END$$;
