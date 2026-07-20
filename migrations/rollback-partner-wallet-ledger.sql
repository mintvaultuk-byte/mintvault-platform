-- rollback-partner-wallet-ledger.sql
-- Reverses migration 0016_partner_wallet_ledger.sql (G6A). NOT a numbered migration (never auto-applied).
--
-- This script is transactional and refuses before any destructive statement if financial data or a
-- later numbered migration exists. It is safe only for an empty, dependency-free G6A installation.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE CASE WHEN filename ~ '^[0-9]+_' THEN substring(filename FROM '^([0-9]+)_')::integer > 16 ELSE false END
  ) THEN
    RAISE EXCEPTION 'refusing G6A rollback: a later migration (0017+) is applied; roll it back first';
  END IF;
END$$;

-- The migration owner is subject to FORCE RLS and would otherwise see populated tables as empty.
-- These DDL changes and the checks are in one transaction: any refusal restores FORCE RLS atomically.
ALTER TABLE partner_credit_ledger NO FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_wallets NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public.partner_credit_ledger') IS NOT NULL
     AND EXISTS (SELECT FROM partner_credit_ledger LIMIT 1) THEN
    RAISE EXCEPTION 'refusing G6A rollback: partner_credit_ledger contains financial history';
  END IF;

  IF to_regclass('public.partner_wallets') IS NOT NULL
     AND EXISTS (SELECT FROM partner_wallets LIMIT 1) THEN
    RAISE EXCEPTION 'refusing G6A rollback: partner_wallets contains wallet data';
  END IF;
END$$;

DROP VIEW IF EXISTS partner_wallet_balances;
DROP TRIGGER IF EXISTS trg_partner_wallet_identity_no_mutate ON partner_wallets;
DROP TRIGGER IF EXISTS trg_partner_credit_ledger_no_row_mutate ON partner_credit_ledger;
DROP TRIGGER IF EXISTS trg_partner_credit_ledger_no_truncate ON partner_credit_ledger;
DROP TABLE IF EXISTS partner_credit_ledger;
DROP TABLE IF EXISTS partner_wallets;
DROP FUNCTION IF EXISTS partner_credit_ledger_no_mutate();
DROP FUNCTION IF EXISTS partner_wallet_identity_no_mutate();

DELETE FROM schema_migrations WHERE filename = '0016_partner_wallet_ledger.sql';

COMMIT;
