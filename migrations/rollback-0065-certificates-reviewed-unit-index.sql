-- ROLLBACK 0065 — remove the reviewed-unit index on certificates.
--
-- Reverts exactly what 0065 created: one index. Nothing else in 0065 exists to revert.
--
-- ⚠️ A PLAIN DROP, NOT `DROP INDEX CONCURRENTLY`, AND THE ASYMMETRY WITH 0065 IS DELIBERATE.
--
-- 0065 had to build CONCURRENTLY because BUILDING an index is O(table): it reads every row, and a
-- ShareLock held for that long blocks every write to `certificates` for minutes. DROPPING one is
-- O(catalog) — a few catalog rows and an unlink. It takes ACCESS EXCLUSIVE, which is the stronger
-- mode, but it holds it for microseconds rather than for a scan.
--
-- The concurrent form was tried first and rejected on evidence: `DROP INDEX CONCURRENTLY` cannot
-- run inside a transaction block, so this file would have to abandon BEGIN/COMMIT — and the
-- rollback series' recovery path (tests/partner-rollback-integrity.test.ts) executes the whole
-- descending sequence through one transactional client. A rollback that cannot participate in the
-- descending sequence is a rollback that bricks every lower one, which is the precise defect that
-- test exists to prevent. Atomicity with the journal delete is worth more here than shaving
-- microseconds off a lock this file already bounds.
--
-- If an operator would rather not take ACCESS EXCLUSIVE on `certificates` at all, the equivalent
-- manual sequence is two autocommit statements outside any transaction:
--     BEGIN;

-- Bounded, because this is ACCESS EXCLUSIVE on the public trust surface. Rollback files are never
-- executed by scripts/db/migrate.ts, so the runner's 5s default does not apply here.
SET LOCAL lock_timeout = '2s';

DROP INDEX IF EXISTS idx_certificates_origin_location_reviewed;
--     DELETE FROM schema_migrations WHERE filename = '0065_certificates_reviewed_unit_index.sql';
-- That is supported and equivalent; it simply cannot be this file.
--
-- ⚠️ SAFETY DIRECTION. Rolling this back does not break anything; it makes the partner rating
-- measurement seq-scan `certificates` again (the H10 performance defect returns). The application
-- needs no matching rollback: a missing index changes plans, not results. That is why this file
-- carries no descending-order guard on the APPLICATION — but it does still carry one on the
-- journal, so the series' descending recovery order is not silently violated.

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

BEGIN;

-- Bounded, because this is ACCESS EXCLUSIVE on the public trust surface. Rollback files are never
-- executed by scripts/db/migrate.ts, so the runner's 5s default does not apply here.
SET LOCAL lock_timeout = '2s';

DROP INDEX IF EXISTS idx_certificates_origin_location_reviewed;

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
