-- Rollback 0067. Apply only through the reviewed migration rollback runner.
-- The order guard and journal delete keep a descending rollback reversible:
-- without them this migration would strand its applied row and block 0066.
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 67$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0067 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

DROP TRIGGER IF EXISTS certificate_image_crops_append_only ON certificate_image_crops;
DROP TRIGGER IF EXISTS certificate_image_workings_append_only ON certificate_image_workings;
DROP TRIGGER IF EXISTS certificate_image_masters_append_only ON certificate_image_masters;
DROP TABLE IF EXISTS certificate_image_crops;
DROP TABLE IF EXISTS certificate_image_workings;
DROP TABLE IF EXISTS certificate_image_masters;
DROP FUNCTION IF EXISTS reject_certificate_evidence_mutation();

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0067_certificate_immutable_evidence_ledger.sql';
  END IF;
END$$;

COMMIT;
