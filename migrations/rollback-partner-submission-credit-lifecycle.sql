-- Rollback for 0027_partner_submission_credit_lifecycle.sql. NOT a numbered migration.
--
-- Owner-controlled recovery only. Do not use this to repair an edited applied
-- migration checksum: first obtain owner approval, preserve evidence, execute
-- this rollback, then have the owner reconcile the 0019 journal row before a
-- corrected controlled deployment. Never automate journal deletion.
BEGIN;

-- Do not tear down a capability that a later migration may depend on, and do
-- not remove the hold trigger while an active destination is still protected.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM schema_migrations
        WHERE status = 'applied'
          AND filename ~ '^[0-9]+_'
          AND substring(filename FROM '^([0-9]+)_')::integer > 19
     ) THEN
    RAISE EXCEPTION 'cannot roll back 0019 while a later numbered migration is applied';
  END IF;
  IF to_regclass('public.partner_submission_credit_holds') IS NOT NULL
     AND EXISTS (SELECT 1 FROM partner_submission_credit_holds WHERE released_at IS NULL) THEN
    RAISE EXCEPTION 'cannot roll back 0019 while active Partner destination credit holds exist';
  END IF;
END$$;

-- Remove every executable path before dropping the owner. Evidence, credit
-- reservations/events and released hold history deliberately remain intact.
DO $$
BEGIN
  IF to_regprocedure('public.partner_connector_release_submission_credit(uuid,uuid,uuid,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.partner_connector_release_submission_credit(uuid, uuid, uuid, text) FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_connector_runtime') THEN
      EXECUTE 'REVOKE ALL ON FUNCTION public.partner_connector_release_submission_credit(uuid, uuid, uuid, text) FROM partner_connector_runtime';
    END IF;
  END IF;
  IF to_regprocedure('public.partner_destination_credit_hold_guard()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.partner_destination_credit_hold_guard() FROM PUBLIC';
  END IF;
  IF to_regprocedure('public.partner_certificate_destination_submission_id(integer,integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.partner_certificate_destination_submission_id(integer, integer) FROM PUBLIC';
  END IF;
  IF to_regprocedure('public.partner_certificate_credit_hold_guard()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.partner_certificate_credit_hold_guard() FROM PUBLIC';
  END IF;
  IF to_regprocedure('public.partner_label_print_credit_hold_guard()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.partner_label_print_credit_hold_guard() FROM PUBLIC';
  END IF;
  IF to_regclass('public.submissions') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_destination_credit_hold_guard ON public.submissions';
  END IF;
  IF to_regclass('public.certificates') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_certificate_credit_hold_guard ON public.certificates';
  END IF;
  IF to_regclass('public.label_prints') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_label_print_credit_hold_guard ON public.label_prints';
  END IF;
END$$;

DROP FUNCTION IF EXISTS public.partner_connector_release_submission_credit(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.partner_destination_credit_hold_guard();
DROP FUNCTION IF EXISTS public.partner_certificate_destination_submission_id(integer, integer);
DROP FUNCTION IF EXISTS public.partner_certificate_credit_hold_guard();
DROP FUNCTION IF EXISTS public.partner_label_print_credit_hold_guard();

-- Revoke grants and every membership of the dedicated no-login owner, then
-- drop it. Dynamic relation checks keep this safe for a partially applied or
-- already-rolled-back environment.
DO $$
DECLARE
  member_name text;
  relation_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_credit_lifecycle_definer') THEN
    RETURN;
  END IF;

  FOR member_name IN
    SELECT member.rolname
      FROM pg_auth_members membership
      JOIN pg_roles role ON role.oid=membership.roleid
      JOIN pg_roles member ON member.oid=membership.member
     WHERE role.rolname='partner_credit_lifecycle_definer'
  LOOP
    EXECUTE format('REVOKE partner_credit_lifecycle_definer FROM %I', member_name);
  END LOOP;

  EXECUTE 'REVOKE ALL ON SCHEMA public FROM partner_credit_lifecycle_definer';
  FOREACH relation_name IN ARRAY ARRAY[
    'partner_connector_records',
    'partner_connector_imports',
    'partner_submissions',
    'submissions',
    'cards',
    'submission_items',
    'certificates',
    'label_prints',
    'partner_credit_reservations',
    'partner_credit_reservation_events',
    'partner_submission_credit_holds'
  ]
  LOOP
    IF to_regclass('public.' || relation_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM partner_credit_lifecycle_definer', relation_name);
    END IF;
  END LOOP;
  DROP ROLE partner_credit_lifecycle_definer;
END$$;

-- The numbered runner will re-apply 0019 only after the owner-approved
-- remediation described above. This deletion is intentionally the final
-- rollback operation, after all privileged objects are gone.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0027_partner_submission_credit_lifecycle.sql';
  END IF;
END$$;

COMMIT;
