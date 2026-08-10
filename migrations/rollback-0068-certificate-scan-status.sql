-- Rollback 0068. Apply only through the reviewed migration rollback runner.
-- scan_status is recovery-state evidence. Refuse to discard a live status and
-- require every later numbered migration to be resolved first.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 68$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0068 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM certificates WHERE scan_status IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback-0068 refused: certificates carry scan recovery state; clear or preserve it before rollback.';
  END IF;
END$$;

ALTER TABLE certificates DROP COLUMN IF EXISTS scan_status;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0068_certificate_scan_status.sql';
  END IF;
END$$;

COMMIT;
