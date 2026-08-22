-- Rollback 0069. Apply only through the reviewed migration rollback runner.
-- Historical commercial evidence is never discarded: this rollback is allowed only before any
-- checkout, payment, refund or fulfilment record exists and only after later migrations descend.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE later_migrations integer;
DECLARE evidence_rows integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 69$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0069 refused: % later migration journal row(s) exist. Resolve newer migrations first.', later_migrations;
    END IF;
  END IF;
  SELECT (SELECT count(*) FROM partner_supply_orders)
       + (SELECT count(*) FROM partner_supply_payments)
       + (SELECT count(*) FROM partner_supply_refunds)
       + (SELECT count(*) FROM partner_supply_order_events)
    INTO evidence_rows;
  IF evidence_rows > 0 THEN
    RAISE EXCEPTION 'rollback-0069 refused: % supply commerce evidence row(s) exist; retain history instead of dropping it.', evidence_rows;
  END IF;
END$$;

DROP TABLE IF EXISTS partner_supply_order_events;
DROP TABLE IF EXISTS partner_supply_refunds;
DROP TABLE IF EXISTS partner_supply_payments;
DROP TABLE IF EXISTS partner_supply_order_items;
DROP TABLE IF EXISTS partner_supply_orders;
DROP TABLE IF EXISTS partner_supply_tax_settings;
DROP TABLE IF EXISTS partner_supply_products;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0069_partner_supply_orders.sql';
  END IF;
END$$;
COMMIT;
