-- rollback-partner-credit-reservations.sql
-- Reverses migration 0017_partner_credit_reservations.sql (G6B). NOT a numbered migration (never auto-applied).
--
-- This script is transactional and refuses before any destructive statement if reservation data,
-- reservation event evidence, or a later numbered migration exists. It is safe only for an empty,
-- dependency-free G6B installation.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE CASE WHEN filename ~ '^[0-9]+_' THEN substring(filename FROM '^([0-9]+)_')::integer > 17 ELSE false END
  ) THEN
    RAISE EXCEPTION 'refusing G6B rollback: a later migration (0018+) is applied; roll it back first';
  END IF;
END$$;

-- The migration owner is subject to FORCE RLS and would otherwise see populated tables as empty.
-- These DDL changes and the checks are in one transaction: any refusal restores FORCE RLS atomically.
ALTER TABLE IF EXISTS partner_credit_reservation_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_credit_reservations NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public.partner_credit_reservation_events') IS NOT NULL
     AND EXISTS (SELECT FROM partner_credit_reservation_events LIMIT 1) THEN
    RAISE EXCEPTION 'refusing G6B rollback: partner_credit_reservation_events contains lifecycle evidence';
  END IF;

  IF to_regclass('public.partner_credit_reservations') IS NOT NULL
     AND EXISTS (SELECT FROM partner_credit_reservations LIMIT 1) THEN
    RAISE EXCEPTION 'refusing G6B rollback: partner_credit_reservations contains reservation data';
  END IF;
END$$;

DROP VIEW IF EXISTS partner_credit_availability;
DROP TRIGGER IF EXISTS trg_partner_credit_ledger_preserve_active_reservations ON partner_credit_ledger;
DROP TRIGGER IF EXISTS trg_partner_credit_reservation_identity_no_mutate ON partner_credit_reservations;
DROP TRIGGER IF EXISTS trg_partner_credit_reservation_events_no_row_mutate ON partner_credit_reservation_events;
DROP TRIGGER IF EXISTS trg_partner_credit_reservation_events_no_truncate ON partner_credit_reservation_events;
DROP TABLE IF EXISTS partner_credit_reservation_events;
DROP TABLE IF EXISTS partner_credit_reservations;
DROP FUNCTION IF EXISTS partner_credit_ledger_preserve_active_reservations();
DROP FUNCTION IF EXISTS partner_credit_reservation_events_no_mutate();
DROP FUNCTION IF EXISTS partner_credit_reservation_identity_no_mutate();
DROP INDEX IF EXISTS uq_partner_locations_identity;

DELETE FROM schema_migrations WHERE filename = '0017_partner_credit_reservations.sql';

COMMIT;
