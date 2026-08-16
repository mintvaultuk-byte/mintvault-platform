-- P3 — BIND CERTIFICATE ALLOCATION TO THE CANONICAL CARD JOB.
--
-- NUMBER SAFETY: 0081 follows 0078/0079/0080 from this pass, all above the global high-water mark of
-- 0077 discovered across every ref in the repository. The runner rejects duplicate numbers.
--
-- DEPENDS ON 0080 (partner_card_jobs). They ship together and 0081 is numbered after it, so the
-- runner's ordering guarantees the table exists. No conditional guard is used here on purpose: if
-- 0080 were somehow absent this SHOULD fail loudly rather than silently skip the binding and leave
-- Card Jobs permanently without an identity.
--
-- ============================================================================================
-- WHAT THIS CLOSES
-- ============================================================================================
-- 0080 gave a Card Job somewhere to record its permanent identity (certificate_id + mv_number) and
-- made that identity immutable once written. But NOTHING WROTE IT. The connector allocated a
-- certificate and an MV number against the destination `submission_items`, and the Card Job stayed
-- at certificate_id = NULL forever — so the invariant "one Card Job <-> one MV forever" had a table
-- to live in and no value in it, and a job could never legally reach READY_TO_GRADE (0080's
-- transition trigger refuses that without an allocated certificate).
--
-- This replaces public.partner_allocate_import_certificates() so that, in the SAME transaction and
-- the same loop iteration that mints an MV and inserts a certificate, the corresponding Card Job is
-- stamped with exactly that certificate and that number.
--
-- ============================================================================================
-- HOW SOURCE CARD JOBS ARE PAIRED WITH DESTINATION ITEMS
-- ============================================================================================
-- The loop walks destination `submission_items` in (card_index, id) order. The source Card Jobs are
-- ordered by (partner_submission_cards.sequence_number, card id, ordinal) — which is EXACTLY the
-- deterministic expansion server/partner/submission-service.ts uses to build credit units, and
-- therefore exactly the order in which the Card Jobs were created. The Nth destination item is
-- consequently the Nth source unit.
--
-- That positional pairing is not a new assumption: the pre-existing guard
-- `v_created <> v_mapping.card_count` already depends on the two sequences having the same length
-- and the same meaning. What is new is that a mismatch is now caught PER ROW rather than only in
-- aggregate — if any position fails to stamp exactly one job, the whole allocation aborts.
--
-- ============================================================================================
-- WHY THIS CANNOT DOUBLE-ALLOCATE
-- ============================================================================================
--  * The pre-existing guard refuses outright if ANY live certificate already exists for the
--    destination, so the function is not re-runnable after a successful allocation.
--  * The stamping UPDATE matches only `certificate_id IS NULL`, so an already-identified Card Job is
--    never re-pointed even if that guard were somehow bypassed.
--  * 0080's ENABLE ALWAYS immutability trigger rejects any change to a non-null certificate_id or
--    mv_number, so a second binding raises rather than overwrites.
--  * uq_partner_card_jobs_certificate and uq_partner_card_jobs_mv_number make one certificate or one
--    MV number reachable from at most one job, in both directions.
--  * The whole function runs inside the connector's transaction under FOR UPDATE on the mapping and
--    on submission_items, so two concurrent allocations serialise; the loser then hits the
--    live-certificate guard.
--
-- MIXED-VERSION SAFETY (I17): CREATE OR REPLACE of a function body only. No table altered, no column
-- added or dropped. An OLD application version calls the same signature and simply gets the extra
-- (harmless) stamping; a NEW one relies on it. Safe to apply before the deploy.
--
-- ROLLBACK / DOWN-PATH: re-apply 0076's function body to restore the previous behaviour. Card Jobs
-- already stamped keep their identity — which is correct, because an MV number is permanent.

-- 0076 handed this function to partner_credit_lifecycle_definer, and CREATE OR REPLACE requires
-- OWNERSHIP, not just privileges. A local test cluster applies migrations as a superuser and never
-- notices; a managed host (Neon) applies them as a plain role and fails with "must be owner of
-- function". Borrow the definer role for the replace, exactly as 0044 does for partner_definer —
-- the membership grant is idempotent and the ALTER OWNER below puts ownership straight back.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_credit_lifecycle_definer') THEN
    BEGIN
      EXECUTE format('GRANT partner_credit_lifecycle_definer TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
      NULL;
    END;
  END IF;
END$$;

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
  v_certificate_id integer;
  v_stamped integer;
BEGIN
  IF p_connector_id IS NULL OR p_destination_submission_id IS NULL OR p_destination_submission_id <= 0 THEN
    RAISE EXCEPTION 'Partner pilot allocation requires a connector and destination submission'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT pg_has_role(session_user, 'partner_connector_runtime', 'member') THEN
    RAISE EXCEPTION 'Partner pilot allocation may only be invoked by partner_connector_runtime'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

  -- Lock the Card Jobs for this submission alongside the destination items, so a concurrent
  -- allocation cannot interleave and stamp the same job from another transaction.
  PERFORM 1 FROM public.partner_card_jobs
   WHERE tenant_id=v_mapping.tenant_id AND submission_id=v_mapping.partner_submission_id
   FOR UPDATE;

  PERFORM 1 FROM public.submission_items WHERE submission_id=p_destination_submission_id FOR UPDATE;
  FOR v_item IN
    SELECT id, game, card_set, card_name, card_number, year
      FROM public.submission_items
     WHERE submission_id=p_destination_submission_id
     ORDER BY card_index ASC, id ASC
  LOOP
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
    )
    RETURNING id INTO v_certificate_id;

    v_created := v_created + 1;

    -- ---------------------------------------------------------------------------------------
    -- Stamp the Nth Card Job with exactly this certificate and this MV number.
    -- ---------------------------------------------------------------------------------------
    -- `certificate_id IS NULL` in the predicate is deliberate belt-and-braces: an already-stamped
    -- job is never re-pointed, so even a bypass of the live-certificate guard above cannot rebind
    -- an existing identity. 0080's immutability trigger is the third layer.
    WITH ordered AS (
      SELECT cj.id,
             row_number() OVER (ORDER BY sc.sequence_number, sc.id, cj.ordinal) AS pos
        FROM public.partner_card_jobs cj
        JOIN public.partner_submission_cards sc ON sc.id = cj.card_id
       WHERE cj.tenant_id = v_mapping.tenant_id
         AND cj.submission_id = v_mapping.partner_submission_id
    )
    UPDATE public.partner_card_jobs j
       SET certificate_id = v_certificate_id,
           mv_number = 'MV' || v_last_issued::text
      FROM ordered
     WHERE j.id = ordered.id
       AND ordered.pos = v_created
       AND j.certificate_id IS NULL;
    GET DIAGNOSTICS v_stamped = ROW_COUNT;

    IF v_stamped <> 1 THEN
      -- Abort the WHOLE allocation. A minted MV number with no Card Job to own it would be an
      -- orphaned permanent identity — precisely the condition the canonical Card Job exists to make
      -- impossible — and a partially-bound submission is worse than a failed one.
      RAISE EXCEPTION
        'Partner allocation could not bind certificate % (MV%) to source Card Job position %: % rows stamped',
        v_certificate_id, v_last_issued, v_created, v_stamped
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF v_created = 0 THEN
    RAISE EXCEPTION 'Partner pilot allocation destination has no submission items'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_created <> v_mapping.card_count THEN
    RAISE EXCEPTION 'Partner pilot allocation count does not match the reserved source-card count'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every source Card Job for this submission must now carry an identity. This catches the
  -- asymmetric case the per-row check cannot: MORE source jobs than destination items, where every
  -- stamp succeeded but some jobs were never reached by the loop.
  IF EXISTS (
    SELECT 1 FROM public.partner_card_jobs
     WHERE tenant_id=v_mapping.tenant_id
       AND submission_id=v_mapping.partner_submission_id
       AND certificate_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Partner allocation left a source Card Job without a certificate identity'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_created;
END;
$$;

ALTER FUNCTION public.partner_allocate_import_certificates(uuid, integer)
  OWNER TO partner_credit_lifecycle_definer;

-- The definer role owns the function and must be able to write the binding. No grant is given to
-- partner_connector_runtime itself: it reaches this table only THROUGH the definer, never directly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_credit_lifecycle_definer') THEN
    GRANT SELECT, UPDATE (certificate_id, mv_number, updated_at) ON public.partner_card_jobs
      TO partner_credit_lifecycle_definer;
    GRANT SELECT ON public.partner_submission_cards TO partner_credit_lifecycle_definer;
  END IF;
END$$;
