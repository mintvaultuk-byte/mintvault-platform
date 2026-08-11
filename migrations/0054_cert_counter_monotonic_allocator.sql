-- 0054_cert_counter_monotonic_allocator.sql
-- SECURITY REPAIR — A8-F5 (HIGH), the half 0052's column-level grant does NOT close.
--
-- ============================================================================================
-- WHAT IS STILL WRONG AFTER 0052
-- ============================================================================================
-- 0052 replaced 0049's table-level `GRANT SELECT, INSERT, UPDATE ON cert_counter` with column
-- grants that exclude UPDATE(id), specifically to stop the connector RE-POINTING the allocator row
-- (`UPDATE cert_counter SET id = 2`, then insert a fresh id=1 at last_issued=0). Its post-flight
-- asserts exactly that one case:
--     IF has_column_privilege(... 'id', 'UPDATE') THEN RAISE ...
--
-- But `last_issued` MUST keep UPDATE — it is the increment, and the allocator cannot work without
-- it. RE-SEEDING therefore survives untouched, and it produces the IDENTICAL outcome:
--
--     UPDATE cert_counter SET last_issued = 0 WHERE id = 1;                       -- re-seed
--     UPDATE cert_counter SET last_issued = last_issued - 500 WHERE id = 1;       -- rewind
--     INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)
--       ON CONFLICT (id) DO UPDATE SET last_issued = 0;                           -- re-seed via upsert
--
-- Every one of those makes the next allocated number collide with an ALREADY-PRINTED slab —
-- platform-wide, HQ's certificates as well as the partner estate, on a public verification record
-- that customers scan. Executed on a disposable PostgreSQL 17 cluster as the real
-- `partner_connector_runtime` (rolsuper=f, rolbypassrls=f): re-point BLOCKED, DELETE BLOCKED,
-- re-seed NOT BLOCKED.
--
-- COLUMN GRANTS CANNOT EXPRESS THIS. PostgreSQL privileges answer "may this role write this
-- column"; they cannot answer "may this role write this VALUE given the previous one". The
-- constraint being violated is a relationship between OLD and NEW, so it has to live where OLD and
-- NEW exist: a BEFORE UPDATE trigger. A CHECK constraint cannot see OLD and is therefore not an
-- option. Moving allocation behind a SECURITY DEFINER function was the alternative considered and
-- rejected below.
--
-- ============================================================================================
-- WHY A TRIGGER AND NOT A SECURITY DEFINER ALLOCATOR
-- ============================================================================================
-- A definer function (`partner_allocate_certificate_number()`, search_path pinned, direct UPDATE
-- revoked) would also work, and is the more orthodox least-privilege shape. It is rejected here
-- for three reasons, recorded so the choice reads as a decision rather than an omission:
--
--   1. It requires changing BOTH allocator call sites — server/storage.ts:1377-1379 (HQ grading,
--      the protected certificate-issuance hot path) and
--      server/partner/connector-import-service.ts:57-61. This file changes NEITHER. A guard that
--      needs the protected hot path rewritten to take effect is a guard that ships later, or not
--      at all.
--   2. A definer function is a new reachable entry point and a new object to own, and this repo's
--      definer surface is deliberately kept narrow (0006, and the definer-guard tests).
--   3. The trigger is strictly stronger against the actual threat. A definer allocator still
--      leaves whoever holds UPDATE able to re-seed unless the direct grant is revoked from EVERY
--      role including HQ's; the trigger binds every writer unconditionally, including a superuser.
--
-- ENABLE ALWAYS, not the default ENABLE ORIGIN. A plain trigger is silently skipped for a session
-- with `session_replication_role = 'replica'`. That is superuser-only, so it is not part of the
-- connector's reach — but the whole point of this file is that the invariant must not depend on
-- who is asking, and 0035 already uses ENABLE ALWAYS on the certificates origin snapshot for the
-- same reason. Consistency with the house convention costs nothing here.
--
-- ============================================================================================
-- WHY THIS FILE CREATES cert_counter INSTEAD OF SKIPPING WHEN IT IS ABSENT
-- ============================================================================================
-- cert_counter is created at APPLICATION BOOT by storage.ts:ensureCertCounterTable(), not by any
-- migration — so on a fresh database it does not exist when the migration chain runs. 0052 handles
-- that with a RAISE NOTICE and a skip, which is correct for a GRANT (there is nothing to tighten)
-- and would be WRONG here: a silently absent integrity guard is precisely the failure mode this
-- file exists to remove, and it would be absent on exactly the databases where the allocator has
-- not yet issued anything and therefore where a rewind is cheapest to hide.
--
-- So this file creates the table when it is missing, using storage.ts:1336-1340's definition
-- verbatim (id integer PRIMARY KEY DEFAULT 1, last_issued integer NOT NULL DEFAULT 0, updated_at
-- timestamptz NOT NULL DEFAULT NOW()), and then always installs the guard.
-- `CREATE TABLE IF NOT EXISTS` at boot then becomes a no-op, and the seed INSERT that follows it
-- is ON CONFLICT DO NOTHING, so the boot path is unaffected either way.
--
-- OWNERSHIP IS NOT A NEW RISK. The application already executes `CREATE TABLE` against this table
-- at boot, so the HQ role is a role that may create relations in `public` — the same class of role
-- that runs migrations. On the deployed databases they are literally the same role (the Neon
-- project owner). Both existing allocator call sites are re-proven against this file in
-- tests/partner-rollback-integrity.test.ts rather than assumed.
--
-- NOT CHANGED, deliberately: 0052's column grants are re-asserted below rather than re-issued
-- differently. On a fresh database 0052 skipped them (the table did not exist yet), so re-issuing
-- them here is what makes the connector's import path work at all; on an existing database the
-- GRANT is idempotent and changes nothing.
--
-- ROLLBACK: migrations/rollback-0054-cert-counter-monotonic-allocator.sql. It removes the triggers
-- and the function, leaves the table and its data alone, and deletes its own journal row.

-- --------------------------------------------------------------------------------------------
-- PRE-FLIGHT.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  is_super  boolean;
  is_bypass boolean;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass
    FROM pg_roles WHERE rolname = 'partner_connector_runtime';
  IF is_super IS NULL THEN
    RAISE EXCEPTION '0054: role partner_connector_runtime does not exist; 0008 must be applied first';
  END IF;
  -- A trigger binds a superuser too, so BYPASSRLS/SUPERUSER does NOT make this repair cosmetic the
  -- way it does for 0047 and 0051. It is still refused: a connector role with those attributes
  -- means the column grants this file re-asserts are decorative, and a database in that shape must
  -- be fixed before anything here is certified.
  IF is_super OR is_bypass THEN
    RAISE EXCEPTION
      '0054: partner_connector_runtime is SUPERUSER or BYPASSRLS (super=%, bypass=%). The '
      'column-level allocator grants re-asserted by this file would be meaningless against it. '
      'Fix the role first.', is_super, is_bypass;
  END IF;
END$$;

-- --------------------------------------------------------------------------------------------
-- 1) The allocator table. Created only if the application has not booted against this database yet.
--    Definition is storage.ts:1336-1340 verbatim.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cert_counter (
  id integer PRIMARY KEY DEFAULT 1,
  last_issued integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- The single allocator ROW, seeded exactly as storage.ts:1348 and
-- connector-import-service.ts:58 do. Creating the table without it would leave the guard below
-- with nothing to guard until the application booted, and `UPDATE ... WHERE id = 1` silently
-- affecting ZERO rows is the failure mode storage.ts:1382 raises FATAL on. ON CONFLICT DO NOTHING,
-- so this can never overwrite a live counter — on an existing database it is a no-op.
INSERT INTO cert_counter (id, last_issued) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------------------------
-- 2) The monotonicity guard.
--
-- Reads no table, so it cannot be pg_temp-shadowed through a relation reference; search_path is
-- pinned regardless, with pg_temp LAST, because that is the house convention from 0006 and because
-- an unpinned function is what MEDIUM-5 (0055) exists to sweep for. Only NEW/OLD and the error
-- machinery are touched.
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cert_counter_monotonic_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- DELETE + re-INSERT is re-seeding by another name, and the INSERT would not pass through the
    -- UPDATE branch below. Neither allocator call site ever deletes this row.
    RAISE EXCEPTION
      'cert_counter row % must not be deleted: removing the allocator row and re-inserting it '
      'restarts certificate numbering from zero and every subsequent number would collide with an '
      'already-issued certificate.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'cert_counter must not be truncated: it is the platform-wide certificate-number allocator.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- UPDATE from here down.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    -- Belt and braces over 0052's revoked UPDATE(id): that grant governs the connector role only,
    -- while this binds every writer.
    RAISE EXCEPTION
      'cert_counter.id is immutable (attempted % -> %): re-pointing the allocator row lets a fresh '
      'row take its place at last_issued = 0.', OLD.id, NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.last_issued IS NULL OR NEW.last_issued <= OLD.last_issued THEN
    RAISE EXCEPTION
      'cert_counter.last_issued is strictly monotonic and may only advance (attempted % -> %). '
      'Re-seeding or rewinding the allocator would make every subsequently issued certificate '
      'number collide with an already-printed slab, platform-wide.', OLD.last_issued, NEW.last_issued
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- --------------------------------------------------------------------------------------------
-- 3) Attach. Idempotent: a re-run replaces the function body and leaves the triggers in place.
-- --------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_cert_counter_monotonic'
                    AND tgrelid = 'public.cert_counter'::regclass AND NOT tgisinternal) THEN
    EXECUTE 'CREATE TRIGGER trg_cert_counter_monotonic'
         || ' BEFORE UPDATE OR DELETE ON cert_counter'
         || ' FOR EACH ROW EXECUTE FUNCTION cert_counter_monotonic_guard()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_cert_counter_no_truncate'
                    AND tgrelid = 'public.cert_counter'::regclass AND NOT tgisinternal) THEN
    EXECUTE 'CREATE TRIGGER trg_cert_counter_no_truncate'
         || ' BEFORE TRUNCATE ON cert_counter'
         || ' FOR EACH STATEMENT EXECUTE FUNCTION cert_counter_monotonic_guard()';
  END IF;
  -- ENABLE ALWAYS so `session_replication_role = 'replica'` cannot skip them.
  EXECUTE 'ALTER TABLE cert_counter ENABLE ALWAYS TRIGGER trg_cert_counter_monotonic';
  EXECUTE 'ALTER TABLE cert_counter ENABLE ALWAYS TRIGGER trg_cert_counter_no_truncate';
END$$;

-- --------------------------------------------------------------------------------------------
-- 4) Re-assert 0052's column-level allocator grants. On a fresh database 0052 skipped these because
--    the table did not exist yet; without them the connector import path fails 42501.
-- --------------------------------------------------------------------------------------------
REVOKE ALL ON cert_counter FROM partner_connector_runtime;
GRANT SELECT (id, last_issued)         ON cert_counter TO partner_connector_runtime;
GRANT INSERT (id, last_issued)         ON cert_counter TO partner_connector_runtime;
GRANT UPDATE (last_issued, updated_at) ON cert_counter TO partner_connector_runtime;

-- --------------------------------------------------------------------------------------------
-- POST-FLIGHT. Self-proving assertions — this file rolls back rather than being journalled as
-- applied while any part of its claim is false.
--
-- These are STRUCTURAL. The BEHAVIOURAL proof — that a re-seed, a rewind, an upsert re-seed and a
-- DELETE are all refused for a non-superuser NOBYPASSRLS role while the real increment at
-- storage.ts:1377-1379 still succeeds — lives in tests/partner-rollback-integrity.test.ts, because
-- a migration cannot honestly attack itself: it runs as the migrator, inside one transaction, with
-- its own DDL uncommitted.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  cfg  text[];
  ntrg integer;
BEGIN
  SELECT p.proconfig INTO cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cert_counter_monotonic_guard';
  IF cfg IS NULL OR NOT (cfg @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION '0054: cert_counter_monotonic_guard() search_path is not pinned (proconfig = %)', cfg;
  END IF;

  SELECT count(*) INTO ntrg
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgrelid = 'public.cert_counter'::regclass
     AND tgname IN ('trg_cert_counter_monotonic', 'trg_cert_counter_no_truncate');
  IF ntrg <> 2 THEN
    RAISE EXCEPTION '0054: expected both cert_counter guard triggers, found %', ntrg;
  END IF;

  -- 'A' = ENABLE ALWAYS. 'O' (origin) would be silently skipped under session_replication_role.
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgrelid = 'public.cert_counter'::regclass
       AND tgname IN ('trg_cert_counter_monotonic', 'trg_cert_counter_no_truncate')
       AND tgenabled <> 'A'
  ) THEN
    RAISE EXCEPTION '0054: a cert_counter guard trigger is not ENABLE ALWAYS and could be skipped by a replica session';
  END IF;

  -- The allocator must still be usable by the connector, or partner imports fail 42501.
  IF NOT (
    has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'id',          'SELECT') AND
    has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'last_issued', 'SELECT') AND
    has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'id',          'INSERT') AND
    has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'last_issued', 'INSERT') AND
    has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'last_issued', 'UPDATE') AND
    has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'updated_at',  'UPDATE')
  ) THEN
    RAISE EXCEPTION
      '0054: the connector lost a column privilege the certificate-number allocator needs '
      '(connector-import-service.ts:57-61); partner imports would fail 42501';
  END IF;

  -- …and still must not be able to re-point it.
  IF has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'id', 'UPDATE') THEN
    RAISE EXCEPTION '0054: partner_connector_runtime can UPDATE cert_counter.id; 0052''s narrowing was undone';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'cert_counter'
       AND grantee = 'partner_connector_runtime'
  ) THEN
    RAISE EXCEPTION '0054: a TABLE-level privilege on cert_counter survives for partner_connector_runtime';
  END IF;
END$$;
