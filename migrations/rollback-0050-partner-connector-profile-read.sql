-- ROLLBACK for 0050_partner_connector_profile_read.sql.
--
-- Deliberately NOT numbered: scripts/db/migrate.ts only discovers `NNNN_*.sql`, so the runner can
-- never apply this file by accident. It is applied by hand by an operator, exactly like every other
-- migrations/rollback-*.sql in this repo.
--
-- WHAT IT UNDOES: the single column-level SELECT grant 0050 issued. Nothing else — 0050 creates no
-- object and modifies no row, so there is nothing else to undo.
--
-- ⚠️ OPERATIONAL WARNING. After this runs, server/partner/connector-import-service.ts's origin
-- snapshot query fails with 42501 (permission denied for table partner_profiles) and EVERY partner
-- connector import aborts and rolls back. That is the intended fail-closed behaviour — an import
-- that cannot read the approved trading name must not mint a certificate with the wrong one, since
-- migration 0035's ENABLE ALWAYS trigger makes the snapshot unfixable afterwards. Only run this
-- alongside reverting the application to a build whose importer does not read partner_profiles.
--
-- ============================================================================================
-- JOURNAL HANDLING — ADDED 2026-08-07, CLOSING A BLOCKER, AND THE WORST OF THE THREE
-- ============================================================================================
-- This file previously contained NO journal reference at all. Two consequences, both proven:
--
--  1. Its own re-apply was silently skipped. scripts/db/migrate.ts:planMigrations classifies a
--     file as alreadyApplied on the PRESENCE of its journal row alone (migrate.ts:449-462 — it
--     consults row.status and row.checksum, never the database), so after this rollback the runner
--     reported 0050 applied while the connector GRANT was absent and every partner import aborted
--     42501, behind a green migration status.
--
--  2. IT BRICKED THE THREE ROLLBACKS BELOW IT. rollback-0047, rollback-0048 and rollback-0049 each
--     refuse while `left(filename,4)::integer > <own number>` matches any journal row. The orphaned
--     0050 row satisfies all three thresholds and, having no deleter, was IMMORTAL — so after
--     rolling 0052 and 0051 back cleanly, 0050 left journal_row_present = 1 and 0049/0048/0047 all
--     failed with "refused: N later migration journal row(s) exist", permanently. Recovery required
--     hand-editing schema_migrations, which is precisely what the journal exists to prevent.
--
-- The DELETE at the end of this file closes both. The filename appears there as DATA rather than as
-- a comment: a rename-by-grep would miss it, so it must track any renumbering of this file.
--
-- NO "LATER MIGRATIONS" REFUSAL, DELIBERATELY. This file drops nothing, creates nothing and changes
-- one column-level privilege, so nothing later can be structurally invalidated by it. Adding a
-- threshold here would force 0051 and 0052 to be rolled back first for no structural reason, and
-- would reintroduce exactly the ordering trap described above from the other direction. This is the
-- same reasoning rollback-0051 and rollback-0052 record for their own absent thresholds; only
-- rollback-0049, which DROPs a table, has a genuine structural dependency to defend.
--
-- LOCK SAFETY — ADDED 2026-08-07. REVOKE takes ACCESS EXCLUSIVE on partner_profiles, which blocks
-- READS as well as writes: while it is held or QUEUED, the connector's origin-snapshot read and
-- every admin-pool partner_profiles read wait. The numbered runner never executes this file, so its
-- lock_timeout machinery does not apply and an unbounded wait here is genuinely unbounded. The
-- bound is inside this file's own transaction, before the first lock is taken (the shape
-- rollback-0049 established). SET LOCAL is discarded at COMMIT/ROLLBACK, so it cannot leak into the
-- operator's psql session.
--
-- TRANSACTION: this file now carries its own BEGIN/COMMIT, which it previously did not. Under
-- `psql -f` (autocommit, statement by statement) the REVOKE and the journal DELETE would otherwise
-- be two independent commits, so a failure between them could leave the privilege revoked with the
-- journal row intact — the exact state this file exists to avoid. It is also what makes SET LOCAL
-- meaningful at all.

BEGIN;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.partner_profiles') IS NULL THEN
    RAISE NOTICE 'rollback-0050: partner_profiles absent — nothing to revoke.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    RAISE NOTICE 'rollback-0050: partner_connector_runtime absent — nothing to revoke.';
    RETURN;
  END IF;

  -- Column-scoped revoke only. A blanket `REVOKE ALL ON partner_profiles` would also strip
  -- privileges granted by other migrations to other roles.
  EXECUTE 'REVOKE SELECT (tenant_id, trading_name) ON partner_profiles FROM partner_connector_runtime';

  IF has_column_privilege('partner_connector_runtime', 'public.partner_profiles', 'trading_name', 'SELECT') THEN
    RAISE EXCEPTION
      'rollback-0050 assertion failed: partner_connector_runtime can still SELECT partner_profiles.trading_name (a table-level grant from elsewhere may be in play).';
  END IF;

  RAISE NOTICE 'rollback-0050: revoked partner_connector_runtime SELECT on partner_profiles(tenant_id, trading_name).';
END$$;

-- De-journal, so the runner re-applies 0050 on its next run instead of skipping it as applied, and
-- so the row cannot go on blocking rollback-0047/0048/0049 forever.
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. That is defect D4 from rollback-0045's header, avoided here rather than repeated.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0050_partner_connector_profile_read.sql'$q$;
  END IF;
END$$;

COMMIT;
