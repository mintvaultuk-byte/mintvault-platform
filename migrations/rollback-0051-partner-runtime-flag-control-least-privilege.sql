-- rollback-0051-partner-runtime-flag-control-least-privilege.sql
--
-- Restores the pre-0051 state exactly: the blanket DML grants 0001_partner_foundation.sql:269 gave
-- partner_runtime on the two kill-switch tables, and the single combined feature-flag policy from
-- 0001:239-242.
--
-- ⚠️ APPLYING THIS RE-OPENS THE DEFECT 0051 CLOSED. After this file runs, partner_runtime can again
-- DELETE the platform-global feature-flag rows (including partner_emergency_stop and
-- partner_portal_enabled) and can DELETE its own HQ-imposed emergency freeze. Use it only to
-- unblock an unrelated failure, and re-apply 0051 immediately afterwards.
--
-- Not destructive to data: no row is read, written or removed — this file only restores privileges
-- and policy definitions.
--
-- JOURNAL HANDLING. The final block DELETEs this migration's own journal row. Without it the
-- runner would still consider 0051 applied while the database sat in the rolled-back state, so a
-- re-apply would be silently skipped and the defect would stay open behind a green migration
-- status. The filename in that DELETE must track any renumbering of this file — it is the one
-- place the number appears as data rather than as a comment.
--
-- NO "LATER MIGRATIONS" REFUSAL, DELIBERATELY. rollback-0045 refuses to run when any journal row
-- with a higher number exists, because it DROPS a table that later migrations reference. This file
-- drops nothing and changes only privileges and two policy definitions, so nothing later can be
-- structurally invalidated by it. A blanket refusal would instead defeat this file's only purpose:
-- it exists to unblock an emergency, and by then later migrations will certainly exist. Recorded
-- explicitly so the absence reads as a decision rather than an omission.
--
-- LOCK SAFETY — ADDED 2026-08-07, AND THE PROFILE IS WORSE THAN "GRANTS ONLY" SUGGESTS.
-- DROP POLICY, CREATE POLICY and GRANT all take ACCESS EXCLUSIVE on partner_feature_flags, which
-- blocks READS, not merely writes. That table is on the hottest partner path there is:
-- server/partner/mount.ts:119 and :132 call resolveGlobalFlag('partner_emergency_stop') and
-- resolveGlobalFlag('partner_portal_enabled') on EVERY partner portal request, uncached
-- (server/partner/flags.ts:54-64), and resolveGlobalFlag FAILS CLOSED on any error. So a queued
-- ACCESS EXCLUSIVE here does not merely slow the portal — requests stall on the flag read, and any
-- that error out resolve partner_portal_enabled = false and serve the kill-switch response, with
-- nothing in the logs pointing at this file. Run it in a quiet window.
--
-- The numbered runner NEVER executes rollback files (scripts/db/migrate.ts's FILE_RE matches only
-- `NNNN_*.sql`), so the runner's own lock_timeout machinery does not apply here and an unbounded
-- wait is genuinely unbounded. The bound is deliberately TIGHTER than the 5 s the other rollbacks
-- in this series use: on this table a long queue is an outage, and failing fast to be re-run is
-- strictly better than holding the portal down. SET LOCAL is discarded at COMMIT/ROLLBACK so it
-- cannot leak into the operator's psql session; if it fires, the whole file aborts atomically and
-- nothing is changed.

BEGIN;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS partner_feature_flags_global_read  ON partner_feature_flags;
DROP POLICY IF EXISTS partner_feature_flags_tenant_write ON partner_feature_flags;
-- Drop the name we are about to CREATE, not only the ones we are replacing. Without this a second
-- run of this file raises 42710 "policy already exists" — which matters in a DR restore and in any
-- per-file `psql -f` sequence, where re-running the last step is the normal recovery move.
DROP POLICY IF EXISTS partner_feature_flags_tenant_isolation ON partner_feature_flags;

CREATE POLICY partner_feature_flags_tenant_isolation ON partner_feature_flags
  USING (tenant_id IS NULL OR tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON partner_feature_flags     TO partner_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_emergency_controls TO partner_runtime;

DO $$
DECLARE npolicy integer;
BEGIN
  SELECT count(*) INTO npolicy
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_feature_flags';
  IF npolicy <> 1 THEN
    RAISE EXCEPTION 'rollback-0051: expected exactly 1 policy on partner_feature_flags, found %', npolicy;
  END IF;
  IF NOT has_table_privilege('partner_runtime', 'public.partner_feature_flags', 'DELETE') THEN
    RAISE EXCEPTION 'rollback-0051: partner_runtime DELETE grant was not restored';
  END IF;
END$$;

-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. That is defect D4 from rollback-0045's header, avoided here rather than repeated.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0051_partner_runtime_flag_control_least_privilege.sql'$q$;
  END IF;
END$$;

COMMIT;
