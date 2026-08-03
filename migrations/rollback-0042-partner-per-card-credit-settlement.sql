-- Rollback for 0042_partner_per_card_credit_settlement.sql. NOT a numbered migration.
--
-- ORDERING: run this BEFORE any rollback of 0041. 0041's own rollback refuses to execute while a
-- migration numbered > 41 is journalled, which enforces that order for you.
--
-- PREREQUISITE: the same INHERIT membership 0042 required. CREATE OR REPLACE FUNCTION performs an
-- ownership check, and this function is owned by partner_credit_lifecycle_definer.
--
-- WHAT THIS DOES: restores 0041's single-reservation function body verbatim. It does NOT touch
-- reservations, ledger rows, events or holds — those are immutable accounting history and are
-- deliberately preserved. Note that after this rollback, any submission holding more than one
-- live reservation (i.e. any genuine multi-card submission) will again be reported as
-- `corrupt_linkage` by the connector release path. Roll back the application code with it.

BEGIN;

DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'usage')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'rollback of 0042 cannot replace functions owned by partner_credit_lifecycle_definer: % lacks INHERIT membership',
      current_user;
  END IF;
END$$;

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
  v_reservation record;
  v_destination_count integer;
  v_destination record;
  v_hold record;
  v_terminal_event_count integer;
  v_terminal_event_type text;
  v_now timestamptz := clock_timestamp();
  v_event_type text;
  v_event_source text;
  v_key text;
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

  SELECT id, tenant_id, partner_submission_id, state INTO v_connector
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
    FROM public.partner_connector_imports WHERE connector_record_id = p_connector_id;
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

  SELECT id, wallet_id, tenant_id, location_id, submission_reference, status,
         expires_at, external_ref
    INTO v_reservation
   FROM public.partner_credit_reservations
   WHERE tenant_id = p_tenant_id AND source = 'portal'
     AND submission_reference = p_partner_submission_id::text
   ORDER BY created_at DESC, id DESC
   LIMIT 2
   FOR UPDATE;
  IF NOT FOUND THEN
    IF v_destination_count = 1 THEN
      RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'legacy_no_reservation'::text, NULL::uuid;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.partner_credit_reservations
       WHERE tenant_id = p_tenant_id AND source = 'portal'
         AND submission_reference = p_partner_submission_id::text) <> 1
     OR v_reservation.location_id IS DISTINCT FROM v_source.location_id
     OR v_reservation.tenant_id IS DISTINCT FROM p_tenant_id
     OR v_reservation.submission_reference IS DISTINCT FROM p_partner_submission_id::text THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, v_reservation.id;
    RETURN;
  END IF;

  IF v_destination_count = 1 AND v_reservation.status IN ('active', 'released', 'expired') THEN
    SELECT h.id, h.reservation_id INTO v_hold
      FROM public.partner_submission_credit_holds h
     WHERE h.destination_submission_id = v_destination.destination_submission_id
       AND h.released_at IS NULL;
    IF FOUND THEN
      IF v_hold.reservation_id IS DISTINCT FROM v_reservation.id THEN
        RETURN QUERY SELECT 'corrupt_linkage'::text, v_reservation.id;
        RETURN;
      END IF;
    ELSE
      INSERT INTO public.partner_submission_credit_holds
        (tenant_id, partner_submission_id, destination_submission_id, reservation_id,
         connector_record_id, connector_import_id, reason_code)
      VALUES
        (p_tenant_id, p_partner_submission_id, v_destination.destination_submission_id, v_reservation.id,
         p_connector_id, v_destination.connector_import_id, 'connector_terminal_credit_release');
    END IF;
  END IF;

  IF v_reservation.status <> 'active' THEN
    SELECT count(*)::integer, min(event_type)
      INTO v_terminal_event_count, v_terminal_event_type
      FROM public.partner_credit_reservation_events e
     WHERE e.reservation_id = v_reservation.id
       AND e.event_type IN ('consumed', 'released', 'expired');
    IF v_terminal_event_count <> 1 OR v_terminal_event_type <> v_reservation.status THEN
      RETURN QUERY SELECT 'corrupt_linkage'::text, v_reservation.id;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'already_settled'::text, v_reservation.id;
    RETURN;
  END IF;

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
    RETURN QUERY SELECT 'already_settled'::text, v_reservation.id;
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
       'g6d_settlement', true
     ), NULL);

  RETURN QUERY SELECT v_event_type::text, v_reservation.id;
END;
$$;

ALTER FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  OWNER TO partner_credit_lifecycle_definer;
ALTER FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  TO partner_connector_runtime;

REVOKE SELECT ON partner_submission_cards FROM partner_credit_lifecycle_definer;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0042_partner_per_card_credit_settlement.sql';
  END IF;
END$$;

COMMIT;
