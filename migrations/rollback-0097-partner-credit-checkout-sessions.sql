-- rollback-0097-partner-credit-checkout-sessions.sql
-- Guarded rollback for 0097_partner_credit_checkout_sessions.sql.
--
-- This rollback is safe only before any Checkout provenance has been recorded. Once a row exists,
-- it is payment evidence and must be preserved with a forward fix instead.

DO $$
BEGIN
  IF to_regclass('public.partner_credit_checkout_sessions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM partner_credit_checkout_sessions LIMIT 1) THEN
    RAISE EXCEPTION 'refusing 0097 rollback: partner_credit_checkout_sessions contains payment provenance';
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('public.partner_credit_checkout_sessions') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_credit_checkout_session_identity_no_mutate'
         || ' ON partner_credit_checkout_sessions';
  END IF;
END$$;

DROP FUNCTION IF EXISTS partner_credit_checkout_session_identity_no_mutate();
DROP TABLE IF EXISTS partner_credit_checkout_sessions;
