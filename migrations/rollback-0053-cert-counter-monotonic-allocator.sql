-- rollback-0053-cert-counter-monotonic-allocator.sql
--
-- ⚠️ APPLYING THIS RE-OPENS THE DEFECT 0053 CLOSED. Afterwards any role holding
-- UPDATE (last_issued) on cert_counter — which the connector must hold, because it is the
-- increment — can re-seed or rewind the PLATFORM-WIDE certificate-number allocator:
--     UPDATE cert_counter SET last_issued = 0 WHERE id = 1;
--     INSERT INTO cert_counter (id, last_issued) VALUES (1,0) ON CONFLICT (id) DO UPDATE SET last_issued = 0;
-- and every subsequently issued certificate number collides with an already-printed slab, HQ's
-- included, on a public verification record. Use it only to unblock an unrelated failure, and
-- re-apply 0053 immediately afterwards.
--
-- NOT DESTRUCTIVE TO DATA. The allocator TABLE and its row are deliberately left alone: 0053 only
-- creates cert_counter when it is absent, and by the time anyone rolls back it may hold the live
-- counter for every certificate ever issued. Dropping it to "undo" a CREATE TABLE IF NOT EXISTS
-- would be the single most destructive act available on this database. Only the two triggers and
-- the guard function are removed.
--
-- 0052's column grants are likewise NOT reverted here. 0053 re-asserted them rather than authoring
-- them; rollback-0052 owns them, and reverting them from this file would leave the connector
-- failing 42501 after a rollback whose stated scope is "remove the monotonicity guard".
--
-- JOURNAL HANDLING. The final block DELETEs this migration's own journal row. Without it
-- scripts/db/migrate.ts:planMigrations (migrate.ts:449-462) would still classify 0053 as
-- alreadyApplied and SKIP it on the next run, so the database would sit unguarded behind a green
-- migration status. The filename there is DATA, not a comment — it must track any renumbering of
-- this file, because a rename-by-grep would miss it.
--
-- NO "LATER MIGRATIONS" REFUSAL, DELIBERATELY. This file drops no table and no column; nothing
-- later can be structurally invalidated by it. Only rollback-0049, which DROPs a table, has a
-- genuine structural dependency to defend. Same reasoning as rollback-0051/0052/0050.
--
-- LOCK SAFETY. DROP TRIGGER takes ACCESS EXCLUSIVE on cert_counter, which blocks READS as well as
-- writes — and cert_counter is on the certificate-issuance hot path for BOTH HQ grading
-- (server/storage.ts:1377-1379) and the partner connector
-- (server/partner/connector-import-service.ts:57-61). A queued ACCESS EXCLUSIVE stalls certificate
-- allocation platform-wide. The numbered runner never executes rollback files
-- (scripts/db/migrate.ts's FILE_RE matches only NNNN_*.sql), so its lock_timeout machinery does not
-- apply here. Bound it inside this file's own transaction, before the first lock is taken.

BEGIN;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.cert_counter') IS NULL THEN
    RAISE NOTICE 'rollback-0053: cert_counter absent; nothing to do.';
    RETURN;
  END IF;
  EXECUTE 'DROP TRIGGER IF EXISTS trg_cert_counter_monotonic   ON cert_counter';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_cert_counter_no_truncate ON cert_counter';
END$$;

DROP FUNCTION IF EXISTS cert_counter_monotonic_guard();

-- Prove the reversal actually happened rather than trusting the DDL above.
DO $$
DECLARE ntrg integer;
BEGIN
  IF to_regclass('public.cert_counter') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO ntrg
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgrelid = 'public.cert_counter'::regclass
     AND tgname IN ('trg_cert_counter_monotonic', 'trg_cert_counter_no_truncate');
  IF ntrg <> 0 THEN
    RAISE EXCEPTION 'rollback-0053: % cert_counter guard trigger(s) survive', ntrg;
  END IF;
  IF to_regprocedure('public.cert_counter_monotonic_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0053: cert_counter_monotonic_guard() survives';
  END IF;
  -- The allocator itself must be untouched. A rollback that lost the counter would be a platform
  -- incident, not a rollback.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.cert_counter'::regclass) THEN
    RAISE EXCEPTION 'rollback-0053: cert_counter was dropped; this file must never remove the allocator';
  END IF;
END$$;

-- De-journal, so the runner re-applies 0053 on its next run instead of skipping it as applied.
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. That is defect D4 from rollback-0045's header, avoided here rather than repeated.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0053_cert_counter_monotonic_allocator.sql'$q$;
  END IF;
END$$;

COMMIT;
