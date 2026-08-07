-- 0054_partner_ledger_preserve_search_path.sql
-- SECURITY REPAIR — the pg_temp shadowing CLASS, not one more instance of it.
--
-- ============================================================================================
-- THE INSTANCE
-- ============================================================================================
-- 0017_partner_credit_reservations.sql:193-225 creates
-- partner_credit_ledger_preserve_active_reservations(). It is SECURITY INVOKER, has NO
-- `SET search_path`, and reads THREE tables UNQUALIFIED:
--
--     PERFORM 1 FROM partner_wallets              WHERE ... FOR UPDATE;
--     SELECT ... FROM partner_credit_ledger       WHERE ...;
--     SELECT ... FROM partner_credit_reservations WHERE ... AND status = 'active';
--
-- pg_temp is searched ahead of public by default and CREATE TEMP TABLE is a default PUBLIC
-- privilege on the database, so any role that reaches SQL can shadow all three. Reproduced on a
-- disposable PostgreSQL 17 cluster: with a temp `partner_credit_reservations` in place the trigger
-- computed active_reserved = 0, the underfunding check passed, and a debit drove the wallet balance
-- to 0 WHILE AN ACTIVE RESERVATION STILL EXISTED — the exact invariant this trigger exists to
-- protect, defeated by three CREATE TEMP TABLE statements.
--
-- This is byte-for-byte the defect 0048 repaired on 0044's location-snapshot trigger. 0006 has
-- documented the attack and pinned search_path on every definer function it creates since the
-- Partner Network began.
--
-- SEVERITY IS MEDIUM, HONESTLY. The trigger is BEFORE INSERT on partner_credit_ledger, and neither
-- restricted runtime role holds INSERT on that table — verified in the same catalogue sweep — so
-- today it is reachable only from the BYPASSRLS admin pool. It is not a live exploit chain. It is
-- the same latent primitive 0048 closed, one blanket GRANT or one injection away from mattering.
--
-- THE FIX. `SET search_path = pg_catalog, public, pg_temp` (pg_temp LAST, so temp objects stay
-- reachable for legitimate use but can never shadow a public table) AND schema-qualify all three
-- reads. Either alone closes the attack; both together mean the references stay correct if a future
-- edit drops the SET clause. The body is otherwise 0017's verbatim.
--
-- 0017 itself is NOT edited: it is already applied, and its checksum ratchet stays intact.
-- CREATE OR REPLACE preserves trg_partner_credit_ledger_preserve_active_reservations, so no trigger
-- is dropped and there is no window in which partner_credit_ledger INSERTs run unguarded.
--
-- ============================================================================================
-- THE CLASS — WHICH IS THE ACTUAL DEFECT
-- ============================================================================================
-- 0048 fixed ONE function and did not sweep. That is why this file exists at all: the same
-- primitive sat in 0017 the whole time, in a function guarding money rather than provenance, and
-- nothing in the repository would have noticed. server/partner/definer-guard.ts covers SECURITY
-- DEFINER functions only, and both offenders are SECURITY INVOKER.
--
-- So the post-flight below does not merely assert that THIS function is fixed. It asks the
-- CATALOGUE for every plpgsql function in `public` whose proconfig IS NULL and whose body contains
-- an unqualified FROM/JOIN against a relation, and refuses if the answer is anything but empty.
-- The same sweep runs on every CI run in tests/partner-rls-isolation.test.ts, against the full
-- migration chain, with a planted-offender mutation proving it goes red — a migration assertion
-- fires once, and once is not a ratchet.
--
-- `OLD` and `NEW` are excluded: `IS DISTINCT FROM OLD.x` matches a naive FROM regex and is not a
-- relation reference. That exclusion is the difference between a sweep and a false alarm, and it
-- was found by running the sweep before writing it — four of the five initial "offenders" were
-- this.
--
-- ROLLBACK: migrations/rollback-0054-partner-ledger-preserve-search-path.sql.

-- --------------------------------------------------------------------------------------------
-- PRE-FLIGHT.
-- --------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.partner_credit_ledger_preserve_active_reservations()') IS NULL THEN
    RAISE EXCEPTION '0054: partner_credit_ledger_preserve_active_reservations() is missing; 0017 must be applied first';
  END IF;
  IF to_regclass('public.partner_wallets') IS NULL
     OR to_regclass('public.partner_credit_ledger') IS NULL
     OR to_regclass('public.partner_credit_reservations') IS NULL THEN
    RAISE EXCEPTION '0054: the credit tables 0017 creates are missing; 0016/0017 must be applied first';
  END IF;
END$$;

-- --------------------------------------------------------------------------------------------
-- 1) The instance. Body is 0017:193-225 verbatim apart from the three schema qualifications.
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION partner_credit_ledger_preserve_active_reservations() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  resulting_balance bigint;
  active_reserved bigint;
BEGIN
  IF NEW.amount >= 0 THEN
    RETURN NEW;
  END IF;

  -- Serialize direct ledger debits with reservation/service transitions for the same wallet.
  PERFORM 1
    FROM public.partner_wallets
   WHERE id = NEW.wallet_id AND tenant_id = NEW.tenant_id
   FOR UPDATE;

  SELECT COALESCE(SUM(amount), 0)::bigint + NEW.amount
    INTO resulting_balance
    FROM public.partner_credit_ledger
   WHERE wallet_id = NEW.wallet_id AND tenant_id = NEW.tenant_id;

  SELECT COALESCE(SUM(reserved_credits), 0)::bigint
    INTO active_reserved
    FROM public.partner_credit_reservations
   WHERE wallet_id = NEW.wallet_id AND tenant_id = NEW.tenant_id AND status = 'active';

  IF resulting_balance < active_reserved THEN
    RAISE EXCEPTION 'partner_credit_ledger debit would underfund active reservations'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- --------------------------------------------------------------------------------------------
-- POST-FLIGHT — the instance, then the CLASS.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  cfg      text[];
  body     text;
  ntrg     integer;
  offenders text;
BEGIN
  -- (a) The instance: pinned, pg_temp last, and no unqualified read survives.
  SELECT p.proconfig, p.prosrc INTO cfg, body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_credit_ledger_preserve_active_reservations';
  IF cfg IS NULL OR NOT (cfg @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION '0054: search_path is not pinned to "pg_catalog, public, pg_temp" (proconfig = %)', cfg;
  END IF;
  IF body ~* 'from\s+partner_(wallets|credit_ledger|credit_reservations)' THEN
    RAISE EXCEPTION '0054: an unqualified credit-table read survives in the function body';
  END IF;

  -- (b) The trigger survived CREATE OR REPLACE — no window in which ledger INSERTs ran unguarded.
  SELECT count(*) INTO ntrg
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname  = 'trg_partner_credit_ledger_preserve_active_reservations'
     AND tgrelid = 'public.partner_credit_ledger'::regclass;
  IF ntrg <> 1 THEN
    RAISE EXCEPTION '0054: expected trg_partner_credit_ledger_preserve_active_reservations, found %', ntrg;
  END IF;

  -- (c) THE CLASS. No plpgsql/sql function in `public` may combine proconfig IS NULL with an
  --     unqualified relation reference. OLD/NEW are excluded because `IS DISTINCT FROM OLD.x`
  --     matches the regex without being a relation reference.
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO offenders
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND l.lanname IN ('plpgsql', 'sql')
     AND p.proconfig IS NULL
     AND EXISTS (
       SELECT 1
         FROM regexp_matches(p.prosrc, '(?:from|join)\s+([a-z_][a-z0-9_]*)', 'gi') AS m
        WHERE lower(m[1]) NOT IN ('old', 'new')
     );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      '0054: function(s) with NO pinned search_path still read a relation unqualified and are '
      'therefore pg_temp-shadowable: %. Pin `SET search_path = pg_catalog, public, pg_temp` and '
      'schema-qualify every read, as 0048 and this file do.', offenders;
  END IF;
END$$;
