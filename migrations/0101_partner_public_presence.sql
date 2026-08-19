-- 0101 — Public Partner publication and privacy consent.
--
-- This migration is deliberately independent from optional Google Business
-- integration. It stores public-only values; partner_locations.address remains
-- operational data and is never an implicit public source.

DO $$ BEGIN
  IF to_regclass('public.partner_locations') IS NULL
     OR to_regclass('public.partner_users') IS NULL
     OR to_regclass('public.partner_organisations') IS NULL THEN
    RAISE EXCEPTION '0101 requires the Partner foundation';
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
END$$;

CREATE TABLE IF NOT EXISTS partner_public_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  public_display_name text,
  version integer NOT NULL DEFAULT 0,
  consented_by uuid,
  consented_at timestamptz,
  approved_version integer,
  approved_by text,
  approved_at timestamptz,
  listed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_public_profile_consent FOREIGN KEY (tenant_id, consented_by)
    REFERENCES partner_users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_partner_public_profile_version CHECK (version >= 0),
  CONSTRAINT chk_partner_public_profile_name CHECK (
    public_display_name IS NULL OR length(trim(public_display_name)) BETWEEN 2 AND 160
  ),
  CONSTRAINT chk_partner_public_profile_approval CHECK (
    approved_version IS NULL OR (approved_version = version AND approved_at IS NOT NULL)
  ),
  CONSTRAINT chk_partner_public_profile_listing CHECK (
    listed = false OR (
      approved_version = version
      AND consented_at IS NOT NULL
      AND public_display_name IS NOT NULL
      AND length(trim(public_display_name)) BETWEEN 2 AND 160
    )
  )
);

CREATE TABLE IF NOT EXISTS partner_location_publications (
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  privacy_state text NOT NULL DEFAULT 'INCOMPLETE_UNVERIFIED',
  public_location_name text,
  public_street_address text,
  public_service_area text,
  public_website text,
  public_phone text,
  public_email text,
  maps_enabled boolean NOT NULL DEFAULT false,
  consented_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  version integer NOT NULL DEFAULT 0,
  consented_by uuid,
  consented_at timestamptz,
  approved_version integer,
  approved_by text,
  approved_at timestamptz,
  listed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, location_id),
  CONSTRAINT fk_partner_location_publication_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_location_publication_consent FOREIGN KEY (tenant_id, consented_by)
    REFERENCES partner_users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_partner_location_publication_state CHECK (
    privacy_state IN ('PUBLIC_STOREFRONT','SERVICE_AREA_PRIVATE_ADDRESS','NOT_PUBLIC','INCOMPLETE_UNVERIFIED')
  ),
  CONSTRAINT chk_partner_location_publication_version CHECK (version >= 0),
  CONSTRAINT chk_partner_location_publication_values CHECK (
    (public_location_name IS NULL OR length(trim(public_location_name)) BETWEEN 2 AND 120)
    AND (public_street_address IS NULL OR length(trim(public_street_address)) BETWEEN 5 AND 500)
    AND (public_service_area IS NULL OR length(trim(public_service_area)) BETWEEN 2 AND 160)
    AND (public_website IS NULL OR length(public_website) <= 2048)
    AND (public_phone IS NULL OR length(public_phone) <= 40)
    AND (public_email IS NULL OR length(public_email) <= 254)
  ),
  CONSTRAINT chk_partner_location_publication_consent_fields CHECK (
    consented_fields <@ ARRAY['public_location_name','public_street_address','public_service_area',
                               'public_website','public_phone','public_email','maps_enabled']::text[]
  ),
  CONSTRAINT chk_partner_location_publication_private_mode CHECK (
    privacy_state <> 'SERVICE_AREA_PRIVATE_ADDRESS'
    OR (public_street_address IS NULL AND maps_enabled = false)
  ),
  CONSTRAINT chk_partner_location_publication_maps CHECK (
    maps_enabled = false
    OR (privacy_state = 'PUBLIC_STOREFRONT' AND length(trim(public_street_address)) >= 5)
  ),
  CONSTRAINT chk_partner_location_publication_approval CHECK (
    approved_version IS NULL OR (approved_version = version AND approved_at IS NOT NULL)
  ),
  CONSTRAINT chk_partner_location_publication_listing CHECK (
    listed = false OR (
      approved_version = version
      AND consented_at IS NOT NULL
      AND 'public_location_name'=ANY(consented_fields)
      AND public_location_name IS NOT NULL
      AND length(trim(public_location_name)) BETWEEN 2 AND 120
      AND (
        (privacy_state = 'PUBLIC_STOREFRONT'
          AND 'public_street_address'=ANY(consented_fields)
          AND public_street_address IS NOT NULL
          AND length(trim(public_street_address)) BETWEEN 5 AND 500
          AND (maps_enabled=false OR 'maps_enabled'=ANY(consented_fields)))
        OR
        (privacy_state = 'SERVICE_AREA_PRIVATE_ADDRESS'
          AND 'public_service_area'=ANY(consented_fields)
          AND public_service_area IS NOT NULL
          AND length(trim(public_service_area)) BETWEEN 2 AND 160
          AND public_street_address IS NULL AND maps_enabled = false)
      )
      AND (public_website IS NULL OR 'public_website'=ANY(consented_fields))
      AND (public_phone IS NULL OR 'public_phone'=ANY(consented_fields))
      AND (public_email IS NULL OR 'public_email'=ANY(consented_fields))
      AND (maps_enabled=true OR public_website IS NOT NULL OR public_phone IS NOT NULL OR public_email IS NOT NULL)
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_partner_location_publications_listed
  ON partner_location_publications(tenant_id, listed, location_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_public_profiles','partner_location_publications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

REVOKE ALL ON partner_public_profiles, partner_location_publications FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON partner_public_profiles, partner_location_publications TO partner_runtime;

DO $$ BEGIN
  IF to_regclass('public.partner_public_profiles') IS NULL
     OR to_regclass('public.partner_location_publications') IS NULL THEN
    RAISE EXCEPTION '0101 public Partner publication schema is incomplete';
  END IF;
END$$;
