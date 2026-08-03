-- 0042_partner_per_card_credit_settlement.sql
-- Partner Network G6D: per-card credit settlement for the connector release path.
--
-- WHY: partner grading credits are sold and consumed PER CARD (owner directive, 2026-08-03).
-- An N-card submission therefore holds N reservations that share one `submission_reference`.
-- 0041's `partner_connector_release_submission_credit` hard-codes single-reservation linkage
-- (it treats `count(*) <> 1` as `corrupt_linkage`), so under the per-card model it would reject
-- every multi-card submission. This migration replaces that function body with an N-aware one.
--
-- 0041 IS NOT EDITED. It is applied and checksum-ratcheted on staging; this migration is purely
-- additive and forward-only.
--
-- ============================ HARD PREREQUISITE ============================
-- `CREATE OR REPLACE FUNCTION` performs an OWNERSHIP check, and these functions are owned by
-- `partner_credit_lifecycle_definer`. On managed PostgreSQL the deployment owner holds only an
-- ADMIN-option membership row, so `pg_has_role(current_user, ..., 'usage')` is FALSE and this
-- migration WILL FAIL until the owner-approved staging role repair has been executed:
--
--     GRANT partner_credit_lifecycle_definer TO <deployment owner> WITH INHERIT TRUE;
--
-- The assertion below fails fast with that instruction rather than erroring cryptically at the
-- first CREATE OR REPLACE.
-- ==========================================================================
--
-- ROLLBACK ORDERING: this migration must be rolled back BEFORE 0041. 0041's rollback script
-- refuses to run while any migration numbered > 41 is journalled, which enforces exactly that
-- order. Use rollback-0042-partner-per-card-credit-settlement.sql first.
--
-- NON-PARTNER BEHAVIOUR IS UNCHANGED: this migration creates no trigger, drops no trigger, and
-- touches no grading, certificate or label object. The three hold-guard triggers 0041 installed
-- on submissions/certificates/label_prints are left exactly as they are.

DO $$
BEGIN
  IF to_regprocedure('public.partner_connector_release_submission_credit(uuid,uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '0042 requires migration 0041 to be applied first';
  END IF;

  IF NOT pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'usage')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      '0042 cannot replace functions owned by partner_credit_lifecycle_definer: % lacks INHERIT membership. Execute the owner-approved repair first: GRANT partner_credit_lifecycle_definer TO %I WITH INHERIT TRUE;',
      current_user, current_user;
  END IF;
END$$;

-- The signature is UNCHANGED so no DROP is required and the TypeScript caller is unaffected:
-- it still reads a single row of (outcome, reservation_id). Under the per-card model `outcome`
-- describes the submission as a whole and `reservation_id` names the anchor reservation.
CREATE OR REPLACE FUNCTION partner_connector_release_submission_credit(
  p_connector_id uuid,
  p_tenant_id uuid,
  p_partner_submission_id uuid,
  p_terminal_reason text
) RETURNS TABLE(outcome text, reservation_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_connector record;
  v_source record;
  v_destination_count integer;
  v_destination record;
  v_hold record;
  v_reservation record;
  v_anchor_id uuid;
  v_live_count integer;
  v_active_count integer;
  v_expected_units integer;
  v_terminal_event_count integer;
  v_terminal_event_type text;
  v_now timestamptz := clock_timestamp();
  v_event_type text;
  v_event_source text;
  v_key text;
  v_aggregate_outcome text := NULL;
BEGIN
  IF p_connector_id IS NULL OR p_tenant_id IS NULL OR p_partner_submission_id IS NULL THEN
    RAISE EXCEPTION 'connector release requires connector, tenant and Partner submission identifiers'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_terminal_reason NOT IN (
    'connector_rejected', 'connector_cancelled', 'validation_rejected',
    'validation_cancelled', 'reconciliation_cancelled', 'permanent_failure_cancelled'
  ) THEN
    RAISE EXCEPTION 'connector release terminal reason is not approved'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT pg_has_role(session_user, 'partner_connector_runtime', 'member') THEN
    RAISE EXCEPTION 'connector release may only be invoked by partner_connector_runtime'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF public.partner_current_tenant() IS DISTINCT FROM p_tenant_id THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT id, tenant_id, partner_submission_id, state
    INTO v_connector
   FROM public.partner_connector_records
   WHERE id = p_connector_id AND tenant_id = p_tenant_id
     AND partner_submission_id = p_partner_submission_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  IF (p_terminal_reason IN ('connector_rejected', 'validation_rejected') AND v_connector.state <> 'validating')
     OR (p_terminal_reason = 'validation_cancelled' AND v_connector.state <> 'validating')
     OR (p_terminal_reason = 'connector_cancelled' AND v_connector.state NOT IN ('queued', 'claimed', 'validating', 'ready_for_import', 'reconciliation_required'))
     OR (p_terminal_reason = 'reconciliation_cancelled' AND v_connector.state <> 'manual_review')
     OR (p_terminal_reason = 'permanent_failure_cancelled' AND v_connector.state <> 'failed') THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT id, tenant_id, location_id INTO v_source
    FROM public.partner_submissions
   WHERE id = p_partner_submission_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_destination_count
    FROM public.partner_connector_imports
   WHERE connector_record_id = p_connector_id;
  IF v_destination_count > 1 THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_destination_count = 1 THEN
    SELECT i.id AS connector_import_id, i.destination_submission_id, i.state,
           i.deleted_at AS mapping_deleted_at, s.status, s.deleted_at
      INTO v_destination
      FROM public.partner_connector_imports i
     JOIN public.submissions s ON s.id = i.destination_submission_id
     WHERE i.connector_record_id = p_connector_id
       AND i.partner_organisation_id = p_tenant_id
       AND i.partner_submission_id = p_partner_submission_id;
    IF v_destination.destination_submission_id IS NULL
       OR v_destination.mapping_deleted_at IS NOT NULL
       OR v_destination.status IS NULL
       OR v_destination.deleted_at IS NOT NULL
       OR lower(v_destination.status) NOT IN ('draft', 'new', 'paid')
       OR v_destination.state <> 'completed' THEN
      RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
      RETURN;
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------------
  -- PER-CARD CHANGE. 0041 required exactly one reservation. We now lock the whole live
  -- set and reconcile it against the submission's expanded card units.
  -- ---------------------------------------------------------------------------------
  PERFORM 1 FROM public.partner_credit_reservations
    WHERE tenant_id = p_tenant_id AND source = 'portal'
      AND submission_reference = p_partner_submission_id::text
    FOR UPDATE;

  SELECT count(*)::integer INTO v_live_count
    FROM public.partner_credit_reservations
   WHERE tenant_id = p_tenant_id AND source = 'portal'
     AND submission_reference = p_partner_submission_id::text
     AND status IN ('active', 'consumed', 'released', 'expired');

  IF v_live_count = 0 THEN
    -- No entitlement at all. With a destination mapping present that is corrupt; without one
    -- it is an ordinary pre-G6D submission.
    IF v_destination_count = 1 THEN
      RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    ELSE
      RETURN QUERY SELECT 'legacy_no_reservation'::text, NULL::uuid;
    END IF;
    RETURN;
  END IF;

  -- Credits must reconcile to card units exactly. This replaces 0041's `count(*) <> 1` check
  -- with the per-card equivalent, so a collapsed or over-counted set is still corrupt linkage.
  SELECT COALESCE(SUM(quantity), 0)::integer INTO v_expected_units
    FROM public.partner_submission_cards
   WHERE submission_id = p_partner_submission_id
     AND tenant_id = p_tenant_id
     AND removed_at IS NULL;

  IF v_expected_units > 0 AND v_live_count <> v_expected_units THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  -- Every live reservation must belong to this tenant/submission at the same location, and
  -- card references must be distinct (proving the per-card unique index was not bypassed).
  IF EXISTS (
       SELECT 1 FROM public.partner_credit_reservations r
        WHERE r.tenant_id = p_tenant_id AND r.source = 'portal'
          AND r.submission_reference = p_partner_submission_id::text
          AND r.status IN ('active', 'consumed', 'released', 'expired')
          AND r.location_id IS DISTINCT FROM v_source.location_id
     )
     OR (
       SELECT count(DISTINCT card_reference) FROM public.partner_credit_reservations
        WHERE tenant_id = p_tenant_id AND source = 'portal'
          AND submission_reference = p_partner_submission_id::text
          AND status IN ('active', 'consumed', 'released', 'expired')
     ) <> v_live_count THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT id INTO v_anchor_id
    FROM public.partner_credit_reservations
   WHERE tenant_id = p_tenant_id AND source = 'portal'
     AND submission_reference = p_partner_submission_id::text
     AND status IN ('active', 'consumed', 'released', 'expired')
   ORDER BY created_at ASC, id ASC
   LIMIT 1;

  SELECT count(*)::integer INTO v_active_count
    FROM public.partner_credit_reservations
   WHERE tenant_id = p_tenant_id AND source = 'portal'
     AND submission_reference = p_partner_submission_id::text
     AND status = 'active';

  -- Mixed active/terminal sets are never an ordinary replay. They indicate a previous partial
  -- settlement attempt or manual corruption, so refuse before writing any additional events.
  IF v_active_count > 0 AND v_active_count <> v_live_count THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, v_anchor_id;
    RETURN;
  END IF;

  -- A released/expired entitlement with a pre-arrival destination leaves that destination
  -- non-gradable. One hold per destination, anchored to the first reservation.
  IF v_destination_count = 1 AND v_active_count > 0 THEN
    SELECT h.id, h.reservation_id INTO v_hold
      FROM public.partner_submission_credit_holds h
     WHERE h.destination_submission_id = v_destination.destination_submission_id
       AND h.released_at IS NULL;
    IF NOT FOUND THEN
      INSERT INTO public.partner_submission_credit_holds
        (tenant_id, partner_submission_id, destination_submission_id, reservation_id,
         connector_record_id, connector_import_id, reason_code)
      VALUES
        (p_tenant_id, p_partner_submission_id, v_destination.destination_submission_id, v_anchor_id,
         p_connector_id, v_destination.connector_import_id, 'connector_terminal_credit_release');
    END IF;
  END IF;

  IF v_active_count = 0 THEN
    -- Fully settled already. Every live reservation must carry exactly one terminal event
    -- matching its own status, or the set is inconsistent.
    FOR v_reservation IN
      SELECT id, status FROM public.partner_credit_reservations
       WHERE tenant_id = p_tenant_id AND source = 'portal'
         AND submission_reference = p_partner_submission_id::text
         AND status IN ('active', 'consumed', 'released', 'expired')
    LOOP
      SELECT count(*)::integer, min(event_type)
        INTO v_terminal_event_count, v_terminal_event_type
        FROM public.partner_credit_reservation_events e
       WHERE e.reservation_id = v_reservation.id
         AND e.event_type IN ('consumed', 'released', 'expired');
      IF v_terminal_event_count <> 1 OR v_terminal_event_type <> v_reservation.status THEN
        RETURN QUERY SELECT 'corrupt_linkage'::text, v_anchor_id;
        RETURN;
      END IF;
    END LOOP;
    RETURN QUERY SELECT 'already_settled'::text, v_anchor_id;
    RETURN;
  END IF;

  -- Release or expire EVERY active reservation. All of it happens in the caller's transaction,
  -- so the submission is settled as a unit. Idempotency keys are per reservation, so a replay
  -- is a per-card no-op rather than a duplicate ledger event.
  FOR v_reservation IN
    SELECT id, wallet_id, expires_at, external_ref
      FROM public.partner_credit_reservations
     WHERE tenant_id = p_tenant_id AND source = 'portal'
       AND submission_reference = p_partner_submission_id::text
       AND status = 'active'
     ORDER BY created_at ASC, id ASC
  LOOP
    IF v_reservation.expires_at <= v_now THEN
      v_event_type := 'expired';
      v_event_source := 'system';
      v_key := 'g6d-expire:' || p_connector_id::text || ':' || v_reservation.id::text;
      UPDATE public.partner_credit_reservations
         SET status = 'expired', expired_at = v_now, updated_at = v_now
       WHERE id = v_reservation.id AND tenant_id = p_tenant_id AND status = 'active';
    ELSE
      v_event_type := 'released';
      v_event_source := 'connector';
      v_key := 'g6d-release:' || p_connector_id::text || ':' || v_reservation.id::text;
      UPDATE public.partner_credit_reservations
         SET status = 'released', released_at = v_now, updated_at = v_now
       WHERE id = v_reservation.id AND tenant_id = p_tenant_id AND status = 'active';
    END IF;
    IF NOT FOUND THEN
      -- Lost a race for this row despite the lock: refuse rather than write a mismatched event.
      RETURN QUERY SELECT 'corrupt_linkage'::text, v_anchor_id;
      RETURN;
    END IF;

    INSERT INTO public.partner_credit_reservation_events
      (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
       request_fingerprint, source, reason, actor_type, external_ref, metadata, ledger_entry_id)
    VALUES
      (v_reservation.id, v_reservation.wallet_id, p_tenant_id, v_event_type, 1, v_key,
       pg_catalog.md5(v_key) || pg_catalog.md5(v_key || ':fingerprint'), v_event_source,
       'Partner connector terminal release before MintVault physical receipt.', 'system',
       v_reservation.external_ref,
       pg_catalog.jsonb_build_object(
         'connector_record_id', p_connector_id,
         'partner_submission_id', p_partner_submission_id,
         'terminal_reason', p_terminal_reason,
         'g6d_settlement', true,
         'per_card_settlement', true
       ), NULL);

    -- A mixed set (some expired, some released) reports 'expired' so the caller never treats an
    -- expiry as a clean release.
    IF v_aggregate_outcome IS NULL OR v_event_type = 'expired' THEN
      v_aggregate_outcome := v_event_type;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_aggregate_outcome::text, v_anchor_id;
END;
$$;

-- Ownership and hardening must be re-asserted: CREATE OR REPLACE preserves the existing owner,
-- but these are idempotent and make the migration safe to re-run.
ALTER FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  OWNER TO partner_credit_lifecycle_definer;
ALTER FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  TO partner_connector_runtime;

-- The definer needs to read card rows to reconcile credits against card units. SELECT only.
GRANT SELECT ON partner_submission_cards TO partner_credit_lifecycle_definer;
