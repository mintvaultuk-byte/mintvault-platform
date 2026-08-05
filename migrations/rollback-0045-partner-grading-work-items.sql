-- rollback-0045-partner-grading-work-items.sql
-- Removes the Partner grading source-unit bridge only when it has no linked certificate evidence.

BEGIN;

DO $$
DECLARE
  linked bigint;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM schema_migrations
        WHERE filename ~ '^[0-9]{4}_'
          AND left(filename, 4)::integer > 45
     ) THEN
    RAISE EXCEPTION 'rollback-0045 refused: later migration journal rows exist. Resolve newer migrations first.';
  END IF;

  IF to_regclass('public.partner_grading_work_items') IS NULL THEN
    RAISE NOTICE 'rollback-0045: partner_grading_work_items absent; nothing to do.';
    RETURN;
  END IF;

  SELECT count(*) INTO linked
    FROM partner_grading_work_items
   WHERE certificate_id IS NOT NULL;

  IF linked > 0 THEN
    RAISE EXCEPTION
      'rollback-0045 refused: % partner_grading_work_items row(s) are linked to certificates. Preserve provenance or perform a supervised data migration first.',
      linked;
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('public.partner_grading_work_items') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
      REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM partner_connector_runtime;
      REVOKE ALL PRIVILEGES ON certificates FROM partner_connector_runtime;
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

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0045_partner_grading_work_items.sql';
  END IF;
END$$;

COMMIT;
