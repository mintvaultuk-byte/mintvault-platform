-- rollback-0049-partner-grading-work-items.sql
-- Removes the Partner grading source-unit bridge, and ONLY when no live grading evidence exists.
--
-- ==================== WHY THIS FILE IS SHAPED LIKE THIS ====================
-- Four defects, all reproduced on a disposable PostgreSQL 17 database running as a NOSUPERUSER /
-- NOBYPASSRLS migrator that owns the schema — the role model partner-realistic-db.ts exists to
-- reproduce, and the one a deployed migrator should be held to.
--
-- D1 (critical) — the guard was BLIND. 0049 sets FORCE ROW LEVEL SECURITY, which applies the tenant
--   policy to the table OWNER too. With no app.tenant_id, partner_current_tenant() is NULL, every
--   row is filtered, and the linked-certificate count returned 0 with a linked row present. The
--   refusal never fired and the rollback dropped the table and COMMITTED. Proven: superuser saw 1
--   row, the migrator saw 0.
--
--   `SET LOCAL row_security = off` does NOT fix it: accepted, then the next query raises "query
--   would be affected by row-level security policy" — fail-closed but also fail-ALWAYS, so a
--   legitimate rollback could never complete. A SECURITY DEFINER helper does not fix it either —
--   created by the migrator it is owned by the migrator, and FORCE binds the owner; reassigning it
--   to a BYPASSRLS role needs CREATE ON SCHEMA plus a SELECT grant, widening exactly the definer
--   reachability the partner definer tests keep narrow.
--
--   What works: assert the executor is capable, then lift FORCE for this ONE table inside the
--   transaction. ENABLE ROW LEVEL SECURITY stays on, both runtime roles stay policy-bound, no GUC
--   is touched, and because it is transactional DDL any refusal below rolls FORCE straight back —
--   there is no window in which the table ships un-forced.
--
-- D2 (high) — uq_partner_grading_work_items_certificate_scope, created by 0049 on the PROTECTED
--   certificates table, was missing from the drop list and survived a "clean" rollback.
--
-- D3 (high) — 0049 grants SELECT/INSERT/UPDATE on cert_counter and USAGE/SELECT on
--   certificates_id_seq to partner_connector_runtime. Neither was revoked, so a rolled-back 0049
--   left the connector runtime able to mutate the certificate counter.
--
-- D4 (medium) — the journal probe read schema_migrations directly inside an IF. PL/pgSQL plans the
--   whole expression, so it did not short-circuit at parse time and raised 42P01 on any database
--   without the journal. Every journal reference now goes through EXECUTE.
--
-- D5 (medium) — privilege reversal was nested inside "IF the table EXISTS", so a partial or
--   repeated rollback left the connector runtime holding certificates privileges forever.

BEGIN;

DO $$
DECLARE
  later_migrations bigint := 0;
  total    bigint;
  linked   bigint;
  advanced bigint;
  assigned bigint;
  offending text;
BEGIN
  -- D4: reach the journal only through EXECUTE.
  -- D6 (high, A9-F1) — the threshold MUST track this file's own number. While the forward migration
  -- was numbered 0045 the guard refused whenever any journal row was numbered > 45, and staging had
  -- already applied 0046_partner_mfa_pending_lifecycle.sql. Applying 0045 there would therefore have
  -- been a ONE-WAY DOOR: the rollback refuses (correctly, fail-closed) with no exit. The forward
  -- migration and this file were renumbered to 0049 — above the applied 0046 and above the two
  -- security repairs 0047 (RLS) and 0048 (search_path), so that rolling this bridge back does NOT
  -- require rolling those two repairs back first. The threshold moved with the number: it is always
  -- this file's OWN number. If this file is ever renumbered again, this integer moves too.
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 49$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0049 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;

  IF to_regclass('public.partner_grading_work_items') IS NULL THEN
    RAISE NOTICE 'rollback-0049: partner_grading_work_items absent; nothing to do.';
    RETURN;
  END IF;

  -- D1 part 1 — capability assertion, then the scoped transactional FORCE lift.
  -- Fail CLOSED on inability to see, never on seeing zero.
  IF NOT COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) THEN
    IF pg_get_userbyid((SELECT relowner FROM pg_class
                         WHERE oid = 'public.partner_grading_work_items'::regclass)) <> current_user THEN
      RAISE EXCEPTION
        'rollback-0049 refused: executor % neither owns partner_grading_work_items nor holds BYPASSRLS, so the evidence guard cannot observe every row.',
        current_user;
    END IF;
    ALTER TABLE public.partner_grading_work_items NO FORCE ROW LEVEL SECURITY;
  END IF;

  -- D1 part 2 — post-condition: refuse rather than under-count.
  IF NOT COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
     AND EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.partner_grading_work_items'::regclass
                    AND relforcerowsecurity) THEN
    RAISE EXCEPTION
      'rollback-0049 refused: FORCE ROW LEVEL SECURITY is still in effect for executor %; the evidence guard would under-count.',
      current_user;
  END IF;

  -- Extended predicate. The old guard refused only on a linked certificate, so in-flight
  -- assignments and advanced statuses — real cards mid-workflow — were destroyed silently.
  SELECT count(*),
         count(*) FILTER (WHERE certificate_id IS NOT NULL),
         count(*) FILTER (WHERE status IS DISTINCT FROM 'ready_for_assignment'),
         count(*) FILTER (WHERE assigned_partner_grader_id IS NOT NULL)
    INTO total, linked, advanced, assigned
    FROM partner_grading_work_items;

  IF linked > 0 OR advanced > 0 OR assigned > 0 THEN
    -- Counts and at most 20 work-item ids. Deliberately no certificate_number, image key, partner
    -- name or email: a migration log must not become a customer-data sink.
    SELECT string_agg(id::text, ',' ORDER BY id)
      INTO offending
      FROM (SELECT id FROM partner_grading_work_items
             WHERE certificate_id IS NOT NULL
                OR status IS DISTINCT FROM 'ready_for_assignment'
                OR assigned_partner_grader_id IS NOT NULL
             ORDER BY id LIMIT 20) s;
    RAISE EXCEPTION
      'rollback-0049 refused: live grading evidence present in % of % partner_grading_work_items row(s) (certificate_linked=%, status_advanced=%, grader_assigned=%). First offending work item id(s): %. Preserve provenance or perform a supervised data migration first.',
      GREATEST(linked, advanced, assigned), total, linked, advanced, assigned, offending;
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('public.partner_grading_work_items') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
      REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM partner_connector_runtime;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
      REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM partner_runtime;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_credit_lifecycle_definer') THEN
      REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM partner_credit_lifecycle_definer;
    END IF;
    REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM PUBLIC;

    DROP POLICY IF EXISTS partner_grading_work_items_tenant_isolation ON partner_grading_work_items;

    DROP INDEX IF EXISTS idx_partner_grading_work_items_assigned;
    DROP INDEX IF EXISTS idx_partner_grading_work_items_partner_submission;
    DROP INDEX IF EXISTS idx_partner_grading_work_items_destination;
    DROP INDEX IF EXISTS uq_partner_grading_work_items_certificate;
    DROP INDEX IF EXISTS uq_partner_grading_work_items_source_unit;
    DROP INDEX IF EXISTS uq_partner_grading_work_items_submission_item;

    DROP TABLE partner_grading_work_items;
  END IF;
END$$;

DROP INDEX IF EXISTS uq_partner_grading_work_items_tenant_submission_card;
DROP INDEX IF EXISTS uq_partner_grading_work_items_submission_card;
DROP INDEX IF EXISTS uq_partner_grading_work_items_tenant_submission;
DROP INDEX IF EXISTS uq_partner_grading_work_items_tenant_location;
DROP INDEX IF EXISTS uq_partner_grading_work_items_import_scope;
DROP INDEX IF EXISTS uq_partner_grading_work_items_submission_item_destination;
DROP INDEX IF EXISTS uq_partner_grading_work_items_import_destination;
DROP INDEX IF EXISTS uq_partner_grading_work_items_validation_scope;
DROP INDEX IF EXISTS uq_partner_grading_work_items_connector_record_scope;
DROP INDEX IF EXISTS uq_partner_grading_work_items_handoff_scope;
-- D2: 0049 creates this on the PROTECTED certificates table. Must come after DROP TABLE, because
-- fk_partner_grading_work_items_certificate_scope depends on it.
DROP INDEX IF EXISTS uq_partner_grading_work_items_certificate_scope;

-- D3 + D5: unconditional privilege reversal, outside the table-exists branch so a partial or
-- repeated rollback still revokes. 0049 is the ONLY migration granting any of these three objects
-- to partner_connector_runtime, so a blanket revoke cannot clobber another migration's grant —
-- partner_credit_lifecycle_definer's certificates grant from 0041 survives untouched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    IF to_regclass('public.certificates') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.certificates FROM partner_connector_runtime';
    END IF;
    IF to_regclass('public.cert_counter') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.cert_counter FROM partner_connector_runtime';
    END IF;
    IF to_regclass('public.certificates_id_seq') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON SEQUENCE public.certificates_id_seq FROM partner_connector_runtime';
    END IF;
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations WHERE filename = '0049_partner_grading_work_items.sql'$q$;
  END IF;
END$$;

COMMIT;
