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

-- ROLLBACK LEDGER — mint the reapply marker BEFORE retracting the journal row.
--
-- The numbered runner refuses a pending migration numbered below the highest applied, because that
-- is how a stale branch lands a schema change underneath later ones. A deliberate rollback creates
-- the same shape, so without this the runner cannot tell "the operator just backed this out" from
-- "a stale branch turned up", and re-applying what was just removed is impossible.
--
-- The checksum is copied FROM the journal row — what was genuinely applied to THIS database — never
-- hashed from disk, so a migration edited at any point after it was applied fails the comparison.
-- watermark_at_rollback pins the journal as it stands right now: the marker dies the moment any
-- other migration is applied, which keeps this an "undo, then immediately redo" window rather than
-- a standing licence.
--
-- Guarded on the ledger existing so this script still runs against a database built by an older
-- runner. A hand-deleted schema_migrations row mints nothing and stays refused.
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_rollbacks') IS NOT NULL THEN
    INSERT INTO schema_migration_rollbacks (filename, checksum, watermark_at_rollback, batch)
    SELECT m.filename, m.checksum, COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0), 'rollback-partner-wallet-ledger.sql'
      FROM schema_migrations m
     WHERE filename = '0016_partner_wallet_ledger.sql'
    ON CONFLICT DO NOTHING;
  END IF;
END $ledger$;

DELETE FROM schema_migrations WHERE filename = '0016_partner_wallet_ledger.sql';

COMMIT;
