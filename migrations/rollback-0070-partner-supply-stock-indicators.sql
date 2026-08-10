-- Rollback 0070. Apply only through the reviewed migration rollback runner.
-- A recorded shop count is operational evidence; never discard it silently.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE later_migrations integer;
DECLARE evidence_rows integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 70$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0070 refused: % later migration journal row(s) exist. Resolve newer migrations first.', later_migrations;
    END IF;
  END IF;
  SELECT count(*) INTO evidence_rows FROM partner_supply_stock_counts;
  IF evidence_rows > 0 THEN
    RAISE EXCEPTION 'rollback-0070 refused: % supply stock count row(s) exist; retain operational history instead of dropping it.', evidence_rows;
  END IF;
END$$;

DROP TABLE IF EXISTS partner_supply_stock_counts;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0070_partner_supply_stock_indicators.sql';
  END IF;
END$$;
COMMIT;
