-- rollback-partner-wallet-ledger.sql
-- Reverses migration 0016_partner_wallet_ledger.sql (G6A). NOT a numbered migration (never auto-applied).
--
-- Refuses to run if any LATER partner migration (0017+) is applied — a later migration may depend on
-- these objects. Roll the later one back first. FK-safe drop order (ledger references wallets).
-- Financial-safety note: this drops the wallet + ledger tables; it is only safe while they hold no
-- real partner financial data (G6A ships empty). Confirm emptiness before running in any real env.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE filename ~ '^001[7-9]_' OR filename ~ '^00[2-9][0-9]_') THEN
    RAISE EXCEPTION 'refusing G6A rollback: a later migration (0017+) is applied; roll it back first';
  END IF;
END$$;

DROP VIEW IF EXISTS partner_wallet_balances;
DROP TRIGGER IF EXISTS trg_partner_credit_ledger_no_row_mutate ON partner_credit_ledger;
DROP TRIGGER IF EXISTS trg_partner_credit_ledger_no_truncate ON partner_credit_ledger;
DROP TABLE IF EXISTS partner_credit_ledger CASCADE;
DROP TABLE IF EXISTS partner_wallets CASCADE;
DROP FUNCTION IF EXISTS partner_credit_ledger_no_mutate();

DELETE FROM schema_migrations WHERE filename = '0016_partner_wallet_ledger.sql';
