-- rollback-partner-shop-launch.sql
-- Guarded rollback for 0021_partner_shop_launch.sql.
--
-- Refuses to remove any financial, Stripe, origin, correction, readiness, pilot or audit evidence.
-- Intended only for an empty failed deploy attempt in a disposable/staging database.

BEGIN;

DO $$
DECLARE
  evidence_count bigint := 0;
  later_count bigint := 0;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM schema_migrations
       WHERE filename ~ '^[0-9]{4}_'
         AND substring(filename from 1 for 4)::int > 21
    $q$ INTO later_count;
    IF later_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: later migrations are recorded';
    END IF;
  END IF;

  IF to_regclass('public.partner_credit_purchases') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_credit_purchases' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: partner_credit_purchases contains payment history';
    END IF;
  END IF;
  IF to_regclass('public.partner_stripe_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_stripe_events' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: partner_stripe_events contains webhook history';
    END IF;
  END IF;
  IF to_regclass('public.partner_payment_reconciliation_cases') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_payment_reconciliation_cases' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: reconciliation cases exist';
    END IF;
  END IF;
  IF to_regclass('public.partner_grading_origin_snapshots') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_grading_origin_snapshots' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: grading-origin snapshots exist';
    END IF;
  END IF;
  IF to_regclass('public.partner_correction_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_correction_requests' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: correction requests exist';
    END IF;
  END IF;
  IF to_regclass('public.partner_correction_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_correction_events' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: correction events exist';
    END IF;
  END IF;
  IF to_regclass('public.partner_readiness_checks') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_readiness_checks' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: readiness evidence exists';
    END IF;
  END IF;
  IF to_regclass('public.partner_pilot_authorisations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_pilot_authorisations' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: pilot authorisations exist';
    END IF;
  END IF;
  IF to_regclass('public.partner_launch_audit_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM partner_launch_audit_events' INTO evidence_count;
    IF evidence_count > 0 THEN
      RAISE EXCEPTION 'refusing 0021 rollback: launch audit evidence exists';
    END IF;
  END IF;
END$$;

ALTER TABLE IF EXISTS partner_grading_origin_snapshots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_launch_audit_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_pilot_authorisations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_readiness_checks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_correction_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_correction_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_payment_reconciliation_cases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_stripe_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_credit_purchases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_credit_package_eligibility NO FORCE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS partner_launch_audit_events;
DROP TABLE IF EXISTS partner_pilot_authorisations;
DROP TABLE IF EXISTS partner_readiness_checks;
DROP TABLE IF EXISTS partner_correction_events;
DROP TABLE IF EXISTS partner_correction_requests;
DROP TABLE IF EXISTS partner_grading_origin_snapshots;
DROP TABLE IF EXISTS partner_payment_reconciliation_cases;
DROP TABLE IF EXISTS partner_stripe_events;
DROP TABLE IF EXISTS partner_credit_purchases;
DROP TABLE IF EXISTS partner_credit_package_eligibility;
DROP TABLE IF EXISTS partner_credit_packages;
DROP FUNCTION IF EXISTS partner_shop_launch_append_only();

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM schema_migrations WHERE filename = ''0021_partner_shop_launch.sql''';
  END IF;
END$$;

COMMIT;

