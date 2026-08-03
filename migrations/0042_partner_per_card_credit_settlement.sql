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
-- ============================ PAIRED WITH 0043 ============================
-- 0042 inserts ONE HOLD PER ACTIVE RESERVATION on a single destination (see the hold block below).
-- 0041's `uq_partner_submission_credit_holds_active_destination` — UNIQUE (destination_submission_id)
-- WHERE released_at IS NULL — permits only ONE unreleased hold per destination, so until 0043
-- re-keys that index the SECOND hold raises unique_violation and the whole connector terminal
-- transition aborts. The two must be applied together, 0042 then 0043; a staged apply that stops
-- after 0042 leaves multi-card connector cancellation broken.
--
-- This is NOT asserted here, deliberately: 0043 is numbered after 0042, so a precondition
-- requiring 0043's index would make 0042 unappliable. The numbered runner applies both in one
-- pass, so the exposed window is a deliberate partial apply only — do not stage 0042 alone.
-- =========================================================================
--
-- ROLLBACK ORDERING: roll back 0043 first, then this migration, then 0041. 0041's rollback script
-- refuses to run while any migration numbered > 41 is journalled, which enforces that order.
-- Use rollback-0043-partner-credit-hold-per-card.sql, then
-- rollback-0042-partner-per-card-credit-settlement.sql.
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
    -- NOTE: plpgsql RAISE supports only `%` as a placeholder — there is no `%I` specifier (that is
    -- format()). Writing `%I` here consumed the second argument at the `%` and left a literal "I"
    -- glued to the role name, so the message told the operator to run
    -- `GRANT ... TO pn_migratorI`, naming a role that does not exist. The remediation instruction
    -- in a fail-fast assertion has to be copy-pasteable, so the identifier is quoted with
    -- quote_ident() and interpolated through a single `%`.
    RAISE EXCEPTION
      '0042 cannot replace functions owned by partner_credit_lifecycle_definer: % lacks INHERIT membership. Execute the owner-approved repair first: GRANT partner_credit_lifecycle_definer TO % WITH INHERIT TRUE;',
      current_user, quote_ident(current_user);
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
  -- EXPLICIT LIFECYCLE PARTITION. 0017's CHECK constraint allows exactly
  -- ('active','consumed','released','expired'), so a filter naming all four is the WHOLE domain
  -- and therefore no filter at all. The three counts below are disjoint and sum to v_total_count,
  -- which is what makes every mixed-state case decidable instead of silently collapsing into
  -- "nothing is active, so this must be a replay".
  --   ACTIVE           = active                     (entitlement still outstanding)
  --   CONSUMED         = consumed                   (settled BY GRADING — MintVault was paid)
  --   RELEASE_TERMINAL = released | expired         (settled BY CANCELLATION — credit returned)
  v_active_count integer;
  v_consumed_count integer;
  v_terminal_count integer;
  v_total_count integer;
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

  SELECT count(*) FILTER (WHERE status = 'active')::integer,
         count(*) FILTER (WHERE status = 'consumed')::integer,
         count(*) FILTER (WHERE status IN ('released', 'expired'))::integer,
         count(*)::integer
    INTO v_active_count, v_consumed_count, v_terminal_count, v_total_count
    FROM public.partner_credit_reservations
   WHERE tenant_id = p_tenant_id AND source = 'portal'
     AND submission_reference = p_partner_submission_id::text;

  IF v_total_count = 0 THEN
    -- No entitlement at all. With a destination mapping present that is corrupt; without one
    -- it is an ordinary pre-G6D submission.
    IF v_destination_count = 1 THEN
      RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    ELSE
      RETURN QUERY SELECT 'legacy_no_reservation'::text, NULL::uuid;
    END IF;
    RETURN;
  END IF;

  -- Every reservation must belong to this tenant/submission at the same location, and card
  -- references must be distinct (proving the per-card unique index was not bypassed).
  IF EXISTS (
       SELECT 1 FROM public.partner_credit_reservations r
        WHERE r.tenant_id = p_tenant_id AND r.source = 'portal'
          AND r.submission_reference = p_partner_submission_id::text
          AND r.location_id IS DISTINCT FROM v_source.location_id
     )
     OR (
       SELECT count(DISTINCT card_reference) FROM public.partner_credit_reservations
        WHERE tenant_id = p_tenant_id AND source = 'portal'
          AND submission_reference = p_partner_submission_id::text
     ) <> v_total_count THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT id INTO v_anchor_id
    FROM public.partner_credit_reservations
   WHERE tenant_id = p_tenant_id AND source = 'portal'
     AND submission_reference = p_partner_submission_id::text
   ORDER BY created_at ASC, id ASC
   LIMIT 1;

  /**
   * MIXED-STATE GATE — evaluated BEFORE anything is written.
   *
   * The three lifecycle partitions are mutually exclusive for a healthy submission: a submission is
   * outstanding, or it was settled by grading, or it was settled by cancellation. Any two of them
   * present together means a previous settlement ran partially, or the rows were edited by hand.
   *
   * This is the case 0042 previously waved through. Because the old `v_live_count` filter spanned
   * the entire status domain, a {consumed, released} set had v_active_count = 0, fell into the
   * "fully settled already" branch, found one matching terminal event per reservation — which is
   * true of both statuses — and returned 'already_settled'. The caller then completed a connector
   * cancellation for a submission that had ALREADY BEEN GRADED AND CHARGED on some of its cards.
   */
  IF (v_active_count > 0 AND v_consumed_count > 0)
     OR (v_consumed_count > 0 AND v_terminal_count > 0)
     OR (v_active_count > 0 AND v_terminal_count > 0) THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, v_anchor_id;
    RETURN;
  END IF;

  -- From here the set is UNIFORM: exactly one partition is non-empty.

  -- Credits must reconcile to card units exactly. This replaces 0041's `count(*) <> 1` check with
  -- the per-card equivalent, so a collapsed or over-counted set is still corrupt linkage.
  SELECT COALESCE(SUM(quantity), 0)::integer INTO v_expected_units
    FROM public.partner_submission_cards
   WHERE submission_id = p_partner_submission_id
     AND tenant_id = p_tenant_id
     AND removed_at IS NULL;

  IF v_expected_units > 0 AND v_total_count <> v_expected_units THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  /**
   * A released/expired entitlement with a pre-arrival destination leaves that destination
   * non-gradable, so it must be held pending authorised recovery.
   *
   * ONE HOLD PER CARD (0043 re-keys the active-hold unique index to
   * (destination_submission_id, reservation_id) to permit this). Anchoring all N cards to the
   * first reservation made an N-card recovery unrepresentable: recovery links each hold to its
   * replacement, and settlement requires EVERY released predecessor to carry such a link, so N-1
   * of them could never be authorised and the submission could never be graded again.
   *
   * The destination GATE is unchanged — every guard asks whether ANY unreleased hold exists for
   * the destination, which is equally true for one hold or N.
   */
  IF v_destination_count = 1 AND v_active_count > 0 THEN
    INSERT INTO public.partner_submission_credit_holds
      (tenant_id, partner_submission_id, destination_submission_id, reservation_id,
       connector_record_id, connector_import_id, reason_code)
    SELECT p_tenant_id, p_partner_submission_id, v_destination.destination_submission_id, r.id,
           p_connector_id, v_destination.connector_import_id, 'connector_terminal_credit_release'
      FROM public.partner_credit_reservations r
     WHERE r.tenant_id = p_tenant_id AND r.source = 'portal'
       AND r.submission_reference = p_partner_submission_id::text
       AND r.status = 'active'
       -- Idempotent: a replay must not attempt a second unreleased hold for the same reservation
       -- (0043's uq_..._active_reservation would reject it outright).
       AND NOT EXISTS (
         SELECT 1 FROM public.partner_submission_credit_holds h
          WHERE h.reservation_id = r.id AND h.released_at IS NULL
       );
  END IF;

  IF v_active_count = 0 THEN
    -- Uniformly settled — either wholly CONSUMED (graded) or wholly RELEASE_TERMINAL (cancelled).
    -- Both are legitimate replays and both report 'already_settled', which preserves 0041's
    -- single-reservation behaviour exactly. Every reservation must still carry exactly one terminal
    -- event matching its own status, or the set is inconsistent.
    FOR v_reservation IN
      SELECT id, status FROM public.partner_credit_reservations
       WHERE tenant_id = p_tenant_id AND source = 'portal'
         AND submission_reference = p_partner_submission_id::text
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
