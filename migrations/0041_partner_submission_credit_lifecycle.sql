-- 0041_partner_submission_credit_lifecycle.sql
-- Partner Network G6D: submission-credit lifecycle integration.
--
-- Prerequisites: connector imports plus the complete 0016/0017 accounting
-- model. Deploy 0016, 0017 and 0041 as one controlled set: a partial set is a
-- hard readiness failure, never a generic grading fallback. The connector
-- runtime has no direct credit-table capability; it only EXECUTEs the narrow
-- release function below.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    CREATE ROLE partner_connector_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname = 'partner_connector_runtime'
       AND (rolsuper OR rolbypassrls OR rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'partner_connector_runtime must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS before G6D grants are applied';
  END IF;

  IF to_regclass('public.partner_wallets') IS NULL
     OR to_regclass('public.partner_credit_ledger') IS NULL
     OR to_regclass('public.partner_credit_reservations') IS NULL
     OR to_regclass('public.partner_credit_reservation_events') IS NULL
     OR to_regclass('public.partner_connector_records') IS NULL
     OR to_regclass('public.partner_connector_imports') IS NULL
     OR to_regclass('public.partner_submissions') IS NULL
     OR to_regclass('public.submissions') IS NULL THEN
    RAISE EXCEPTION '0041_partner_submission_credit_lifecycle requires the complete connector-import and 0016/0017 credit migration set';
  END IF;
END$$;

-- A SECURITY DEFINER routine needs to cross FORCE RLS only after it has
-- authenticated the connector/import/source/reservation tuple itself. This
-- owner has no login and no standing schema-create authority. On managed
-- PostgreSQL an elevated operator may need to provision it once, just as 0006
-- provisions partner_definer; the assertions below fail closed if that did not
-- happen.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_credit_lifecycle_definer') THEN
    BEGIN
      CREATE ROLE partner_credit_lifecycle_definer
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'partner_credit_lifecycle_definer is absent and must be provisioned as NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS before applying 0041';
    END;
  ELSE
    BEGIN
      ALTER ROLE partner_credit_lifecycle_definer
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname = 'partner_credit_lifecycle_definer'
       AND rolbypassrls
       AND NOT rolcanlogin
       AND NOT rolsuper
       AND NOT rolcreaterole
       AND NOT rolcreatedb
       AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'partner_credit_lifecycle_definer must be NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS';
  END IF;
END$$;

-- Reset all historical experiments and deny PUBLIC. In particular, the
-- connector can neither read nor mutate wallets/ledger/reservations/events.
REVOKE ALL PRIVILEGES ON partner_wallets,
                         partner_credit_ledger,
                         partner_credit_reservations,
                         partner_credit_reservation_events
  FROM PUBLIC;

REVOKE ALL PRIVILEGES ON partner_wallets,
                         partner_credit_ledger,
                         partner_credit_reservations,
                         partner_credit_reservation_events
  FROM partner_connector_runtime;

-- Immutable G6D accounting-exception evidence. This deliberately is not an
-- audit_log alias: every row is protected against UPDATE/DELETE by database
-- triggers and has a stable idempotency key.
CREATE TABLE IF NOT EXISTS partner_credit_accounting_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  partner_submission_id uuid,
  destination_submission_id bigint,
  connector_record_id uuid,
  connector_import_id uuid,
  reservation_id uuid,
  event_type text NOT NULL,
  reason_code text NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_partner_credit_accounting_exceptions_idem UNIQUE (idempotency_key),
  CONSTRAINT chk_partner_credit_accounting_exceptions_event_type
    CHECK (event_type IN (
      'settlement_exception', 'connector_terminal_blocked',
      'destination_credit_hold', 'destination_credit_recovery'
    )),
  CONSTRAINT chk_partner_credit_accounting_exceptions_reason_code
    CHECK (length(btrim(reason_code)) > 0 AND length(reason_code) <= 120)
);
CREATE INDEX IF NOT EXISTS idx_partner_credit_accounting_exceptions_tenant_created
  ON partner_credit_accounting_exceptions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_credit_accounting_exceptions_submission
  ON partner_credit_accounting_exceptions(partner_submission_id, created_at DESC);

-- Connector mappings are never discarded as a way to make a Partner-origin
-- destination look generic. A soft-deleted mapping remains authoritative and
-- therefore forces reconciliation in settlement/cancellation paths.
ALTER TABLE partner_connector_imports
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- A released/expired reservation must stop its linked MintVault destination
-- from entering grading. This is a small G6D-only hold, rather than a broad
-- new submission status, and is enforced by a database trigger on every
-- status write. It is only cleared after a controlled re-reservation flow.
CREATE TABLE IF NOT EXISTS partner_submission_credit_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE RESTRICT,
  destination_submission_id integer NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES partner_credit_reservations(id) ON DELETE RESTRICT,
  connector_record_id uuid REFERENCES partner_connector_records(id) ON DELETE RESTRICT,
  connector_import_id uuid REFERENCES partner_connector_imports(id) ON DELETE RESTRICT,
  reason_code text NOT NULL,
  blocked_by_user_id uuid,
  blocked_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  recovered_by_user_id uuid,
  recovered_by_email text,
  recovery_reservation_id uuid REFERENCES partner_credit_reservations(id) ON DELETE RESTRICT,
  recovery_idempotency_key text,
  CONSTRAINT chk_partner_submission_credit_holds_reason CHECK (length(btrim(reason_code)) > 0 AND length(reason_code) <= 120),
  CONSTRAINT chk_partner_submission_credit_holds_recovery CHECK (
    (released_at IS NULL AND recovery_reservation_id IS NULL AND recovery_idempotency_key IS NULL)
    OR (released_at IS NOT NULL AND recovery_reservation_id IS NOT NULL AND recovery_idempotency_key IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_submission_credit_holds_active_destination
  ON partner_submission_credit_holds(destination_submission_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_submission_credit_holds_recovery_idempotency
  ON partner_submission_credit_holds(tenant_id, recovery_idempotency_key)
  WHERE recovery_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_submission_credit_holds_submission
  ON partner_submission_credit_holds(tenant_id, partner_submission_id, created_at DESC);

CREATE OR REPLACE FUNCTION partner_destination_credit_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_new jsonb := to_jsonb(NEW);
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.partner_submission_credit_holds h
        WHERE h.destination_submission_id = NEW.id AND h.released_at IS NULL
     )
     AND (
       v_new->>'status' IS DISTINCT FROM v_old->>'status'
       OR v_new->>'grading_status' IS DISTINCT FROM v_old->>'grading_status'
       OR v_new->>'assigned_grader_id' IS DISTINCT FROM v_old->>'assigned_grader_id'
       OR v_new->>'scan_status' IS DISTINCT FROM v_old->>'scan_status'
       OR v_new->>'scan_assigned_to' IS DISTINCT FROM v_old->>'scan_assigned_to'
       OR v_new->>'shipped_at' IS DISTINCT FROM v_old->>'shipped_at'
       OR v_new->>'delivered_at' IS DISTINCT FROM v_old->>'delivered_at'
       OR v_new->>'completed_at' IS DISTINCT FROM v_old->>'completed_at'
       OR v_new->>'return_tracking' IS DISTINCT FROM v_old->>'return_tracking'
       OR v_new->>'return_carrier' IS DISTINCT FROM v_old->>'return_carrier'
       OR v_new->>'return_service' IS DISTINCT FROM v_old->>'return_service'
     ) THEN
    RAISE EXCEPTION 'Partner destination is blocked pending authorised credit recovery'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION partner_certificate_destination_submission_id(
  p_card_id integer,
  p_submission_item_id integer
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_destination_id integer;
BEGIN
  IF p_card_id IS NOT NULL AND to_regclass('public.cards') IS NOT NULL THEN
    SELECT c.submission_id INTO v_destination_id
      FROM public.cards c
     WHERE c.id = p_card_id
     LIMIT 1;
  END IF;
  IF v_destination_id IS NULL AND p_submission_item_id IS NOT NULL AND to_regclass('public.submission_items') IS NOT NULL THEN
    SELECT si.submission_id INTO v_destination_id
      FROM public.submission_items si
     WHERE si.id = p_submission_item_id
     LIMIT 1;
  END IF;
  RETURN v_destination_id;
END;
$$;

CREATE OR REPLACE FUNCTION partner_certificate_credit_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_destination_id integer;
BEGIN
  v_destination_id := public.partner_certificate_destination_submission_id(NEW.card_id, NEW.submission_item_id);
  IF v_destination_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.partner_submission_credit_holds h
        WHERE h.destination_submission_id = v_destination_id AND h.released_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Partner destination is blocked pending authorised credit recovery'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION partner_label_print_credit_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_destination_id integer;
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT public.partner_certificate_destination_submission_id(c.card_id, c.submission_item_id)
    INTO v_destination_id
    FROM public.certificates c
   WHERE c.certificate_number = NEW.cert_id
   LIMIT 1;
  IF v_destination_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.partner_submission_credit_holds h
        WHERE h.destination_submission_id = v_destination_id AND h.released_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Partner destination is blocked pending authorised credit recovery'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_destination_credit_hold_guard ON public.submissions';
  EXECUTE 'CREATE TRIGGER trg_partner_destination_credit_hold_guard'
       || ' BEFORE UPDATE ON public.submissions'
       || ' FOR EACH ROW EXECUTE FUNCTION public.partner_destination_credit_hold_guard()';

  IF to_regclass('public.certificates') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_certificate_credit_hold_guard ON public.certificates';
    EXECUTE 'CREATE TRIGGER trg_partner_certificate_credit_hold_guard'
         || ' BEFORE INSERT OR UPDATE ON public.certificates'
         || ' FOR EACH ROW EXECUTE FUNCTION public.partner_certificate_credit_hold_guard()';
  END IF;

  IF to_regclass('public.label_prints') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_label_print_credit_hold_guard ON public.label_prints';
    EXECUTE 'CREATE TRIGGER trg_partner_label_print_credit_hold_guard'
         || ' BEFORE INSERT OR UPDATE ON public.label_prints'
         || ' FOR EACH ROW EXECUTE FUNCTION public.partner_label_print_credit_hold_guard()';
  END IF;
END$$;

CREATE OR REPLACE FUNCTION partner_credit_accounting_exceptions_no_mutate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner_credit_accounting_exceptions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_partner_credit_accounting_exceptions_no_row_mutate'
       AND tgrelid = 'partner_credit_accounting_exceptions'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_accounting_exceptions_no_row_mutate'
         || ' BEFORE UPDATE OR DELETE ON partner_credit_accounting_exceptions'
         || ' FOR EACH ROW EXECUTE FUNCTION partner_credit_accounting_exceptions_no_mutate()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_partner_credit_accounting_exceptions_no_truncate'
       AND tgrelid = 'partner_credit_accounting_exceptions'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_accounting_exceptions_no_truncate'
         || ' BEFORE TRUNCATE ON partner_credit_accounting_exceptions'
         || ' FOR EACH STATEMENT EXECUTE FUNCTION partner_credit_accounting_exceptions_no_mutate()';
  END IF;
END$$;

ALTER TABLE partner_credit_accounting_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_credit_accounting_exceptions FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS partner_credit_accounting_exceptions_tenant_isolation ON partner_credit_accounting_exceptions';
  EXECUTE 'CREATE POLICY partner_credit_accounting_exceptions_tenant_isolation ON partner_credit_accounting_exceptions
    USING (tenant_id = partner_current_tenant())
    WITH CHECK (tenant_id = partner_current_tenant())';
END$$;

REVOKE ALL PRIVILEGES ON partner_credit_accounting_exceptions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_credit_accounting_exceptions FROM partner_runtime;
REVOKE ALL PRIVILEGES ON partner_credit_accounting_exceptions FROM partner_connector_runtime;
REVOKE ALL PRIVILEGES ON partner_submission_credit_holds FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_submission_credit_holds FROM partner_runtime;
REVOKE ALL PRIVILEGES ON partner_submission_credit_holds FROM partner_connector_runtime;

-- The definer receives only the minimum relations needed to validate and
-- atomically settle a release. It intentionally has no wallet or ledger grant.
GRANT USAGE ON SCHEMA public TO partner_credit_lifecycle_definer;
GRANT SELECT ON partner_connector_records TO partner_credit_lifecycle_definer;
GRANT SELECT ON partner_connector_imports,
                partner_submissions,
                submissions
  TO partner_credit_lifecycle_definer;
DO $$
BEGIN
  IF to_regclass('public.cards') IS NOT NULL THEN
    GRANT SELECT ON public.cards TO partner_credit_lifecycle_definer;
  END IF;
  IF to_regclass('public.submission_items') IS NOT NULL THEN
    GRANT SELECT ON public.submission_items TO partner_credit_lifecycle_definer;
  END IF;
  IF to_regclass('public.certificates') IS NOT NULL THEN
    GRANT SELECT ON public.certificates TO partner_credit_lifecycle_definer;
  END IF;
  IF to_regclass('public.label_prints') IS NOT NULL THEN
    GRANT SELECT ON public.label_prints TO partner_credit_lifecycle_definer;
  END IF;
END$$;
GRANT SELECT, UPDATE (status, released_at, expired_at, updated_at)
  ON partner_credit_reservations TO partner_credit_lifecycle_definer;
GRANT SELECT ON partner_credit_reservation_events TO partner_credit_lifecycle_definer;
GRANT INSERT (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
              request_fingerprint, source, reason, actor_type, actor_user_id, actor_email,
              external_ref, metadata, ledger_entry_id)
  ON partner_credit_reservation_events TO partner_credit_lifecycle_definer;
GRANT SELECT, INSERT ON partner_submission_credit_holds TO partner_credit_lifecycle_definer;

-- PostgreSQL requires temporary membership and CREATE on the schema for an
-- ownership transfer. PostgreSQL 16+ tracks the membership grantor, so this
-- must be executed by the deployment owner (not a restricted migration login
-- carrying an operator-granted membership it cannot revoke). Both privileges
-- are removed immediately after the functions are owned by the no-login
-- definer; migration users retain no SET ROLE path.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'set') THEN
    BEGIN
      EXECUTE format('GRANT partner_credit_lifecycle_definer TO %I WITH SET TRUE', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        '0041 ownership transfer must run as the deployment owner so its temporary partner_credit_lifecycle_definer membership can be revoked atomically';
    END;
  END IF;
  IF NOT pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'set') THEN
    RAISE EXCEPTION
      '0041 ownership transfer requires temporary SET ROLE permission for partner_credit_lifecycle_definer';
  END IF;
END$$;
GRANT CREATE ON SCHEMA public TO partner_credit_lifecycle_definer;

-- The connector supplies a connector id, its already-established tenant and
-- source submission, plus one closed-set terminal reason. No reservation id,
-- wallet id, event payload, timestamp, table name, or identifier is caller
-- controlled. The routine locks both connector and reservation, revalidates
-- every relationship, and writes the terminal row + immutable evidence in the
-- same transaction as the caller's connector-state transition.
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
    'connector_rejected',
    'connector_cancelled',
    'validation_rejected',
    'validation_cancelled',
    'reconciliation_cancelled',
    'permanent_failure_cancelled'
  ) THEN
    RAISE EXCEPTION 'connector release terminal reason is not approved'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT pg_has_role(session_user, 'partner_connector_runtime', 'member') THEN
    RAISE EXCEPTION 'connector release may only be invoked by partner_connector_runtime'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Connector paths set this LOCAL value from the record they just locked. It
  -- prevents a cross-tenant tuple from being accepted accidentally by a caller.
  IF public.partner_current_tenant() IS DISTINCT FROM p_tenant_id THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT id, tenant_id, partner_submission_id, state
    INTO v_connector
   FROM public.partner_connector_records
   WHERE id = p_connector_id
     AND tenant_id = p_tenant_id
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

  SELECT id, tenant_id, location_id
    INTO v_source
    FROM public.partner_submissions
   WHERE id = p_partner_submission_id
     AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, NULL::uuid;
    RETURN;
  END IF;

  -- A destination mapping means a MintVault-side intake exists. Lock the import
  -- and destination before releasing credit; they are committed atomically with
  -- a persisted non-gradable hold below.
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

  SELECT id, wallet_id, tenant_id, location_id, submission_reference, status,
         expires_at, external_ref
    INTO v_reservation
   FROM public.partner_credit_reservations
   WHERE tenant_id = p_tenant_id
     AND source = 'portal'
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
  -- LIMIT 2 deliberately makes duplicate reservation linkage an exception,
  -- rather than silently selecting one history row.
  IF (SELECT count(*) FROM public.partner_credit_reservations
       WHERE tenant_id = p_tenant_id AND source = 'portal' AND submission_reference = p_partner_submission_id::text) <> 1
     OR v_reservation.location_id IS DISTINCT FROM v_source.location_id
     OR v_reservation.tenant_id IS DISTINCT FROM p_tenant_id
     OR v_reservation.submission_reference IS DISTINCT FROM p_partner_submission_id::text THEN
    RETURN QUERY SELECT 'corrupt_linkage'::text, v_reservation.id;
    RETURN;
  END IF;

  -- A released/expired entitlement with a pre-arrival destination must leave
  -- that destination non-gradable. Replays repair an older terminal row which
  -- may have been recorded before the hold existed, but a consumed entitlement
  -- never gains a cancellation hold.
  IF v_destination_count = 1 AND v_reservation.status IN ('active', 'released', 'expired') THEN
    SELECT h.id, h.reservation_id
      INTO v_hold
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
     WHERE id = v_reservation.id
       AND tenant_id = p_tenant_id
       AND status = 'active';
  ELSE
    v_event_type := 'released';
    v_event_source := 'connector';
    v_key := 'g6d-release:' || p_connector_id::text || ':' || v_reservation.id::text;
    UPDATE public.partner_credit_reservations
       SET status = 'released', released_at = v_now, updated_at = v_now
     WHERE id = v_reservation.id
       AND tenant_id = p_tenant_id
       AND status = 'active';
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
ALTER FUNCTION partner_destination_credit_hold_guard()
  OWNER TO partner_credit_lifecycle_definer;
ALTER FUNCTION partner_certificate_destination_submission_id(integer, integer)
  OWNER TO partner_credit_lifecycle_definer;
ALTER FUNCTION partner_certificate_credit_hold_guard()
  OWNER TO partner_credit_lifecycle_definer;
ALTER FUNCTION partner_label_print_credit_hold_guard()
  OWNER TO partner_credit_lifecycle_definer;
REVOKE CREATE ON SCHEMA public FROM partner_credit_lifecycle_definer;
ALTER FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION partner_destination_credit_hold_guard()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION partner_certificate_destination_submission_id(integer, integer)
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION partner_certificate_credit_hold_guard()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION partner_label_print_credit_hold_guard()
  SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION partner_destination_credit_hold_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION partner_certificate_destination_submission_id(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION partner_certificate_credit_hold_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION partner_label_print_credit_hold_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_connector_release_submission_credit(uuid, uuid, uuid, text)
  TO partner_connector_runtime;

DO $$
BEGIN
  EXECUTE format('REVOKE partner_credit_lifecycle_definer FROM %I', current_user);
  -- PostgreSQL 16+ automatically gives a CREATEROLE role ADMIN OPTION on roles it
  -- creates. Plain REVOKE removes SET/INHERIT but intentionally leaves that
  -- administration option behind, so remove it explicitly before asserting
  -- that the deployment owner has no remaining path back into the definer.
  EXECUTE format('REVOKE ADMIN OPTION FOR partner_credit_lifecycle_definer FROM %I', current_user);
  IF EXISTS (
    SELECT 1
      FROM pg_auth_members m
      JOIN pg_roles role ON role.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
     WHERE role.rolname = 'partner_credit_lifecycle_definer'
       AND member.rolname = current_user
  ) THEN
    RAISE EXCEPTION
      '0041 must not leave migration user % as a member of partner_credit_lifecycle_definer (session user: %)',
      current_user,
      session_user;
  END IF;
END$$;
