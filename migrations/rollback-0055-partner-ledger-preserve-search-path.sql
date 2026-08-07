-- rollback-0055-partner-ledger-preserve-search-path.sql
--
-- ⚠️ APPLYING THIS RE-OPENS THE DEFECT 0055 CLOSED. It restores
-- partner_credit_ledger_preserve_active_reservations() to 0017's body — no search_path pin, three
-- unqualified reads of partner_wallets / partner_credit_ledger / partner_credit_reservations — so
-- any session that can CREATE TEMP TABLE can shadow them and drive a wallet balance to zero while
-- an active reservation still exists, defeating the exact invariant the trigger enforces. Run it
-- only to unblock an incident, and re-apply 0055 immediately afterwards.
--
-- Not destructive to data: no row is read, written or removed — this file replaces one function
-- body and clears one proconfig entry.
--
-- JOURNAL HANDLING. The final block DELETEs this migration's own journal row. Without it
-- scripts/db/migrate.ts:planMigrations (migrate.ts:449-462) would still classify 0055 as
-- alreadyApplied and SKIP it on the next run, leaving the database shadowable behind a green
-- migration status. The filename there is DATA, not a comment — it must track any renumbering.
--
-- NO "LATER MIGRATIONS" REFUSAL, DELIBERATELY: this file drops nothing and changes one function
-- body, so nothing later can be structurally invalidated by it. Same reasoning as
-- rollback-0050/0051/0052/0054.
--
-- LOCK SAFETY. CREATE OR REPLACE FUNCTION and ALTER FUNCTION ... RESET ALL each take ACCESS
-- EXCLUSIVE on the pg_proc row, and because this function backs
-- trg_partner_credit_ledger_preserve_active_reservations, every partner_credit_ledger INSERT waits
-- behind them — that is the credit-settlement path. The numbered runner never executes rollback
-- files, so its lock_timeout machinery does not apply; bound the wait inside this file's own
-- transaction, before the first lock is taken.

BEGIN;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.partner_credit_ledger_preserve_active_reservations()') IS NULL THEN
    RAISE NOTICE 'rollback-0055: partner_credit_ledger_preserve_active_reservations() absent; nothing to do.';
  END IF;
END$$;

-- Verbatim 0017:193-225 body. Restored by CREATE OR REPLACE so the trigger is never dropped and
-- there is no window in which partner_credit_ledger INSERTs run unguarded.
CREATE OR REPLACE FUNCTION partner_credit_ledger_preserve_active_reservations() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  resulting_balance bigint;
  active_reserved bigint;
BEGIN
  IF NEW.amount >= 0 THEN
    RETURN NEW;
  END IF;

  -- Serialize direct ledger debits with reservation/service transitions for the same wallet.
  PERFORM 1
    FROM partner_wallets
   WHERE id = NEW.wallet_id AND tenant_id = NEW.tenant_id
   FOR UPDATE;

  SELECT COALESCE(SUM(amount), 0)::bigint + NEW.amount
    INTO resulting_balance
    FROM partner_credit_ledger
   WHERE wallet_id = NEW.wallet_id AND tenant_id = NEW.tenant_id;

  SELECT COALESCE(SUM(reserved_credits), 0)::bigint
    INTO active_reserved
    FROM partner_credit_reservations
   WHERE wallet_id = NEW.wallet_id AND tenant_id = NEW.tenant_id AND status = 'active';

  IF resulting_balance < active_reserved THEN
    RAISE EXCEPTION 'partner_credit_ledger debit would underfund active reservations'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ALTER ... RESET ALL is required: CREATE OR REPLACE FUNCTION does NOT clear a proconfig entry set
-- by a previous definition, so without this the search_path pin would silently survive and the
-- rollback would not actually be a rollback. Same defect rollback-0048 records.
ALTER FUNCTION partner_credit_ledger_preserve_active_reservations() RESET ALL;

DO $$
DECLARE
  cfg  text[];
  ntrg integer;
BEGIN
  SELECT p.proconfig INTO cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_credit_ledger_preserve_active_reservations';
  IF cfg IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0055: proconfig survives (%); the search_path pin was not reset', cfg;
  END IF;

  SELECT count(*) INTO ntrg
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname  = 'trg_partner_credit_ledger_preserve_active_reservations'
     AND tgrelid = 'public.partner_credit_ledger'::regclass;
  IF ntrg <> 1 THEN
    RAISE EXCEPTION 'rollback-0055: expected the ledger guard trigger to survive, found %', ntrg;
  END IF;
END$$;

-- De-journal, so the runner re-applies 0055 on its next run instead of skipping it as applied.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0055_partner_ledger_preserve_search_path.sql'$q$;
  END IF;
END$$;

COMMIT;
