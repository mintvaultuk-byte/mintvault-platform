-- ROLLBACK 0065 — remove the reviewed-unit index on certificates.
--
-- Reverts exactly what 0065 created: one index. Nothing else in 0065 exists to revert.
--
-- ⚠️ EVERY EXECUTABLE STATEMENT IN THIS FILE IS INSIDE THE BEGIN/COMMIT BELOW, AND THAT IS A
-- CORRECTION, NOT A STYLE CHOICE. A previous revision of this file described the manual
-- CONCURRENTLY alternative in prose, and two lines of that description were not actually
-- commented out. They executed — at file top level, in autocommit, BEFORE the descending-order
-- guard. Reproduced on a disposable PostgreSQL 17 cluster on 2026-08-09:
--
--     WARNING:  SET LOCAL can only be used in transaction blocks
--     DROP INDEX
--     ERROR:  rollback-0065 refused: 1 later migration journal row(s) exist.
--
--     post-state: index_present = f | 0065 journal status = applied     <-- DIVERGED
--
-- Three separate failures in one accident, all of which this rewrite closes:
--   * the guard refused, but the destructive act had already happened — an order guard downstream
--     of the damage is decoration;
--   * `SET LOCAL` outside a transaction is a no-op, so the stray DROP took AccessExclusiveLock on
--     `certificates` — the public certificate-lookup surface — with NO timeout at all;
--   * the journal still said 'applied', so the runner classified 0065 as alreadyApplied and would
--     never rebuild the index. The H10 defect it exists to fix returns silently, and the estate
--     reports fully migrated.
--
-- Without `ON_ERROR_STOP` — how an operator pasting a file into psql usually runs it — it was
-- worse still: psql continued past the refusal, the transaction ran anyway, and `DELETE 1`
-- de-journalled 0065, defeating the descending-order contract entirely while reporting success.
--
-- The rule this file now follows, and which rollback-0063/0064/0066 already followed: NOTHING
-- executes before the order guard, and the guard is inside the same transaction as the work.
--
-- ── WHY A PLAIN DROP, NOT `DROP INDEX CONCURRENTLY` ────────────────────────────────────────
-- 0065 had to BUILD concurrently because building an index is O(table): it reads every row, and a
-- ShareLock held for that long blocks every write to `certificates` for minutes. DROPPING one is
-- O(catalog) — a few catalog rows and an unlink. It takes the stronger mode, AccessExclusive, but
-- holds it for microseconds rather than for a scan, and the 2s lock_timeout below bounds the wait.
--
-- The concurrent form was tried and rejected on evidence: `DROP INDEX CONCURRENTLY` cannot run
-- inside a transaction block, and the rollback series' recovery path
-- (tests/partner-rollback-integrity.test.ts) executes the whole descending sequence through one
-- transactional client. A rollback that cannot participate in that sequence bricks every lower
-- one — which is the exact defect that test exists to prevent. Atomicity with the journal delete
-- is worth more than microseconds off a lock this file already bounds.
--
-- An operator who would rather not take AccessExclusive on `certificates` at all can run the
-- concurrent equivalent by hand instead of this file. That sequence is documented in
-- docs/partner-migration-lock-safety.md, deliberately NOT here: the last time it was written out
-- in this file as commented prose, two of its lines escaped the comment and caused everything
-- described above.
--
-- ⚠️ SAFETY DIRECTION. Rolling this back does not break anything: it makes the partner rating
-- measurement seq-scan `certificates` again (the H10 performance defect returns). The application
-- needs no matching rollback — a missing index changes plans, not results.

BEGIN;

-- Bounded, because the DROP takes ACCESS EXCLUSIVE on the public trust surface. Rollback files are
-- never executed by scripts/db/migrate.ts (its FILE_RE matches only NNNN_*.sql), so the runner's 5s
-- default does not apply here and an unbounded wait would be genuinely unbounded.
SET LOCAL lock_timeout = '2s';

-- ---- 0. DESCENDING-ORDER GUARD — FIRST, AND INSIDE THE TRANSACTION ----------------------------
DO $$
DECLARE later_migrations integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 65$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0065 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. The index -----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_certificates_origin_location_reviewed;

-- ---- 2. Reversal assertions -------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.idx_certificates_origin_location_reviewed') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0065 failed: idx_certificates_origin_location_reviewed survives';
  END IF;
  -- NOT OURS TO REMOVE — 0058's narrower index must survive untouched.
  IF to_regclass('public.certificates') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='certificates' AND column_name='origin_location_id')
     AND to_regclass('public.idx_certificates_origin_location_recent') IS NULL THEN
    RAISE EXCEPTION 'rollback-0065 overreached: it removed 0058''s idx_certificates_origin_location_recent';
  END IF;
END$$;

DELETE FROM schema_migrations WHERE filename = '0065_certificates_reviewed_unit_index.sql';

COMMIT;
