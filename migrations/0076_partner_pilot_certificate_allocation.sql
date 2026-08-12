-- 0076_partner_pilot_certificate_allocation.sql
--
-- Partner Pilot: allocate one immutable, origin-stamped MintVault certificate
-- for each imported Partner submission item when (and only when) the scoped
-- `partner_grading_enabled` flag is on.  The connector itself keeps no direct
-- INSERT/UPDATE privilege on certificates or cert_counter: this narrow definer
-- routine derives every value from the already-locked connector mapping.
--
-- Operational ordering:
--   1. Reconcile the production migration journal immediately before apply.
--   2. Confirm 0035, 0041--0043, 0045, 0047 and the core certificate schema.
--   3. Apply this migration before enabling partner_grading_enabled anywhere.
--
-- This migration is intentionally source-only until that owner-authorised
-- journal check.  A missing routine while the flag is enabled fails the import
-- transaction closed; it must never produce a generic, unassigned certificate.

DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL
     OR to_regclass('public.cert_counter') IS NULL
     OR to_regclass('public.submission_items') IS NULL
     OR to_regclass('public.partner_connector_imports') IS NULL
     OR to_regclass('public.partner_connector_records') IS NULL
     OR to_regclass('public.partner_submissions') IS NULL
     OR to_regclass('public.partner_credit_reservations') IS NULL
     OR to_regclass('public.partner_organisations') IS NULL
     OR to_regclass('public.partner_locations') IS NULL
     OR to_regclass('public.partner_feature_flags') IS NULL THEN
    RAISE EXCEPTION '0076 requires the core certificate allocator and complete Partner connector schema';
  END IF;
  IF to_regprocedure('public.partner_connector_release_submission_credit(uuid,uuid,uuid,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_credit_lifecycle_definer')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_connector_runtime') THEN
    RAISE EXCEPTION '0076 requires hardened 0041/0042 Partner lifecycle roles and release function';
  END IF;
END$$;

-- A submission item may be a certificate's immutable Partner intake identity at
-- most once.  Fail loudly on historic duplicates rather than selecting one and
-- allowing a second physical card to inherit the same paid item.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.certificates
     WHERE submission_item_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY submission_item_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0076 refuses to add a Partner item uniqueness guard while live duplicate certificate links exist';
  END IF;
END$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_live_submission_item
  ON public.certificates (submission_item_id)
  WHERE submission_item_id IS NOT NULL AND deleted_at IS NULL;

-- The definer receives only the allocator's two writes and the exact relation
-- reads required to derive a trusted snapshot.  No wallet, grade, print or
-- arbitrary certificate update capability is granted.
GRANT USAGE ON SCHEMA public TO partner_credit_lifecycle_definer;
GRANT SELECT ON public.partner_connector_records,
                public.partner_connector_imports,
                public.partner_submissions,
                public.partner_organisations,
                public.partner_locations,
                public.partner_feature_flags,
                public.submission_items,
                public.certificates
  TO partner_credit_lifecycle_definer;
GRANT INSERT ON public.certificates TO partner_credit_lifecycle_definer;
GRANT SELECT, INSERT, UPDATE (last_issued, updated_at) ON public.cert_counter
  TO partner_credit_lifecycle_definer;

-- Same short-lived ownership-transfer discipline as 0041.  It must be run by
-- the release owner so no migration account retains a SET ROLE path afterwards.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'set') THEN
    BEGIN
      EXECUTE format('GRANT partner_credit_lifecycle_definer TO %I WITH SET TRUE', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0076 ownership transfer must be run by the deployment owner';
    END;
  END IF;
  IF NOT pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'set') THEN
    RAISE EXCEPTION '0076 ownership transfer requires temporary SET ROLE permission';
  END IF;
END$$;
GRANT CREATE ON SCHEMA public TO partner_credit_lifecycle_definer;

CREATE OR REPLACE FUNCTION public.partner_allocate_import_certificates(
  p_connector_id uuid,
  p_destination_submission_id integer
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_mapping record;
  v_item record;
  v_last_issued integer;
  v_created integer := 0;
  v_active_reservations integer := 0;
  v_enabled boolean := false;
BEGIN
  IF p_connector_id IS NULL OR p_destination_submission_id IS NULL OR p_destination_submission_id <= 0 THEN
    RAISE EXCEPTION 'Partner pilot allocation requires a connector and destination submission'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT pg_has_role(session_user, 'partner_connector_runtime', 'member') THEN
    RAISE EXCEPTION 'Partner pilot allocation may only be invoked by partner_connector_runtime'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The connector transaction sets this LOCAL GUC from the record it locked;
  -- do not allow a caller to manufacture a cross-tenant allocation tuple.
  SELECT i.id, i.partner_organisation_id AS tenant_id, i.partner_location_id AS location_id,
         i.partner_submission_id, ps.created_by AS partner_user_id, ps.card_count,
         o.public_ref AS partner_public_ref, o.legal_name AS partner_legal_name,
         l.public_ref AS location_public_ref, l.name AS location_name, l.address AS location_address
    INTO v_mapping
    FROM public.partner_connector_imports i
    JOIN public.partner_connector_records r
      ON r.id=i.connector_record_id
     AND r.tenant_id=i.partner_organisation_id
     AND r.partner_submission_id=i.partner_submission_id
     AND r.handoff_id=i.partner_handoff_id
    JOIN public.partner_submissions ps
      ON ps.id=i.partner_submission_id
     AND ps.tenant_id=i.partner_organisation_id
     AND ps.location_id=i.partner_location_id
    JOIN public.partner_organisations o ON o.id=i.partner_organisation_id
    JOIN public.partner_locations l ON l.id=i.partner_location_id AND l.tenant_id=i.partner_organisation_id
   WHERE i.connector_record_id=p_connector_id
     AND i.destination_submission_id=p_destination_submission_id
     AND i.state='reserved'
     AND r.state='ready_for_import'
     AND public.partner_current_tenant() IS NOT DISTINCT FROM i.partner_organisation_id
   FOR UPDATE OF i, r, ps;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Partner pilot allocation connector lineage is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Match the runtime flag resolution: location-specific wins, then tenant,
  -- then global.  A missing row is OFF.  The function repeats the check so a
  -- flag change between TypeScript's read and this privileged write is closed.
  SELECT f.enabled INTO v_enabled
    FROM public.partner_feature_flags f
   WHERE f.flag='partner_grading_enabled'
     AND (f.tenant_id IS NULL OR f.tenant_id=v_mapping.tenant_id)
     AND (f.location_id IS NULL OR f.location_id=v_mapping.location_id)
   ORDER BY CASE WHEN f.location_id IS NOT NULL THEN 2 WHEN f.tenant_id IS NOT NULL THEN 1 ELSE 0 END DESC,
            f.updated_at DESC, f.id DESC
   LIMIT 1;
  IF COALESCE(v_enabled, false) IS NOT TRUE THEN
    RETURN 0;
  END IF;

  -- A certificate identity is never a free entitlement. The Partner submit
  -- path creates one active portal reservation per card before the connector
  -- can reach ready_for_import; repeat that invariant inside the privileged
  -- allocator so a manual/import-path regression cannot issue a targetable MV
  -- identity without the exact credit hold.
  SELECT count(*)::integer INTO v_active_reservations
    FROM public.partner_credit_reservations reservation
   WHERE reservation.tenant_id=v_mapping.tenant_id
     AND reservation.source='portal'
     AND reservation.submission_reference=v_mapping.partner_submission_id::text
     AND reservation.status='active';
  IF v_mapping.card_count <= 0 OR v_active_reservations <> v_mapping.card_count THEN
    RAISE EXCEPTION 'Partner pilot allocation requires one active credit reservation per source card'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.certificates c
      JOIN public.submission_items si ON si.id=c.submission_item_id
     WHERE si.submission_id=p_destination_submission_id
       AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Partner pilot allocation found an existing live certificate for this destination'
      USING ERRCODE = 'unique_violation';
  END IF;

  PERFORM 1 FROM public.submission_items WHERE submission_id=p_destination_submission_id FOR UPDATE;
  FOR v_item IN
    SELECT id, game, card_set, card_name, card_number, year
      FROM public.submission_items
     WHERE submission_id=p_destination_submission_id
     ORDER BY card_index ASC, id ASC
  LOOP
    -- Same row-locked global allocator contract as storage.getNextCertId().
    -- Keep the same bounded global allocator lock as storage.getNextCertId(),
    -- but spell it as a function call so this remains valid PL/pgSQL on every
    -- supported PostgreSQL minor version.
    PERFORM set_config('lock_timeout', '5s', true);
    UPDATE public.cert_counter
       SET last_issued=last_issued+1, updated_at=clock_timestamp()
     WHERE id=1
     RETURNING last_issued INTO v_last_issued;
    IF NOT FOUND THEN
      INSERT INTO public.cert_counter (id,last_issued) VALUES (1,0) ON CONFLICT (id) DO NOTHING;
      UPDATE public.cert_counter
         SET last_issued=last_issued+1, updated_at=clock_timestamp()
       WHERE id=1
       RETURNING last_issued INTO v_last_issued;
    END IF;
    IF v_last_issued IS NULL OR v_last_issued <= 0 THEN
      RAISE EXCEPTION 'Partner pilot certificate allocator returned an invalid identity';
    END IF;

    INSERT INTO public.certificates (
      certificate_number, submission_item_id, status, label_type, grade_type, language,
      card_game, set_name, card_name, card_number_display, year_text,
      created_by, issued_at, updated_at, assigned_grader_id, grader_status, assigned_at,
      origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
      origin_location_id, origin_location_public_ref, origin_location_name, origin_location_address,
      origin_captured_at, origin_snapshot_version
    ) VALUES (
      'MV' || v_last_issued::text, v_item.id, 'active', 'Standard', 'numeric', 'English',
      v_item.game, v_item.card_set, v_item.card_name, v_item.card_number, v_item.year,
      'partner_connector', clock_timestamp(), clock_timestamp(), v_mapping.partner_user_id::text, 'assigned', clock_timestamp(),
      'PARTNER', v_mapping.tenant_id, v_mapping.partner_public_ref, v_mapping.partner_legal_name,
      v_mapping.location_id, v_mapping.location_public_ref, v_mapping.location_name, v_mapping.location_address,
      clock_timestamp(), 1
    );
    v_created := v_created + 1;
  END LOOP;
  IF v_created = 0 THEN
    RAISE EXCEPTION 'Partner pilot allocation destination has no submission items'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_created <> v_mapping.card_count THEN
    RAISE EXCEPTION 'Partner pilot allocation count does not match the reserved source-card count'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_created;
END;
$$;

ALTER FUNCTION public.partner_allocate_import_certificates(uuid, integer)
  OWNER TO partner_credit_lifecycle_definer;
ALTER FUNCTION public.partner_allocate_import_certificates(uuid, integer)
  SET search_path = pg_catalog, public, pg_temp;
REVOKE CREATE ON SCHEMA public FROM partner_credit_lifecycle_definer;
REVOKE ALL ON FUNCTION public.partner_allocate_import_certificates(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_allocate_import_certificates(uuid, integer)
  TO partner_connector_runtime;

DO $$
BEGIN
  EXECUTE format('REVOKE partner_credit_lifecycle_definer FROM %I', current_user);
  EXECUTE format('REVOKE ADMIN OPTION FOR partner_credit_lifecycle_definer FROM %I', current_user);
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
     AND (pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'set')
          OR pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'usage')) THEN
    RAISE EXCEPTION '0076 must not leave migration user % able to use partner_credit_lifecycle_definer', current_user;
  END IF;
END$$;
