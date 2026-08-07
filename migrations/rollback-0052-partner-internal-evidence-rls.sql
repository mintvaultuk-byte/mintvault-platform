-- rollback-0052-partner-internal-evidence-rls.sql
--
-- Restores the pre-0052 state exactly:
--   * the SELECT, INSERT grant 0015_partner_management.sql:159 gave partner_connector_runtime on
--     partner_internal_notes and partner_management_audit, and their RLS-less state;
--   * the single combined partner_service_tiers policy from 0001_partner_foundation.sql;
--   * the table-level SELECT, INSERT, UPDATE grant 0049_partner_grading_work_items.sql:325 gave
--     partner_connector_runtime on cert_counter.
--
-- ⚠️ APPLYING THIS RE-OPENS EVERY DEFECT 0052 CLOSED. Afterwards partner_connector_runtime — a
-- restricted, NOBYPASSRLS role — can again read and write EVERY tenant's internal HQ notes and the
-- whole admin-action audit ledger with no row filter of any kind; a tenant-scoped role can again
-- DELETE the platform-global service-tier (pricing) rows; and the connector can again UPDATE
-- cert_counter.id and re-point the platform-wide certificate-number allocator. Use it only to
-- unblock an unrelated failure, and re-apply 0052 immediately afterwards.
--
-- Not destructive to data: no row is read, written or removed — this file only restores privileges,
-- RLS flags and policy definitions.
--
-- JOURNAL HANDLING — THE PART THAT IS EASIEST TO GET WRONG AND WORST TO GET WRONG.
-- The final block DELETEs this migration's own journal row. Without it, scripts/db/migrate.ts would
-- still find 0052 in schema_migrations, classify it as alreadyApplied, and SKIP it on the next run
-- (see migrate.ts:367-377) — so the database would sit in the rolled-back, EXPOSED state behind a
-- green migration status, and no operator would ever be told. A re-apply must be automatic and
-- unprompted; this DELETE is what makes it so. The filename below must track any renumbering of
-- this file: it is the one place the number appears as DATA rather than as a comment, so a
-- rename-by-grep would miss it.
--
-- "LATER MIGRATIONS" REFUSAL — ADDED 2026-08-07, CORRECTING THIS FILE'S OWN HEADER.
--
-- This file previously carried the same "no refusal, deliberately" note as rollback-0051, on the
-- reasoning that it drops nothing structural and so nothing later can be invalidated by it. That
-- reasoning was correct when it was written and is now WRONG, because 0055 landed:
--
--   0055_partner_hq_control_tables_write_deny.sql REPLACES the very policies 0052 creates, on the
--   SAME two tables. It drops partner_internal_notes_tenant_isolation and
--   partner_management_audit_tenant_isolation and installs *_no_tenant_access in their place.
--
-- So running this file underneath 0055 leaves each of those tables carrying BOTH policies, and
-- re-applying 0052 then fails its own post-flight ("expected exactly 1 policy on %, found 2") — a
-- migration that can be rolled back but not rolled forward, which is the one-way door
-- rollback-0049's D6 exists to prevent. Caught by the round-trip in
-- tests/partner-rollback-integrity.test.ts, not by inspection.
--
-- The threshold is always this file's OWN number; if this file is ever renumbered, the integer
-- moves with it. rollback-0055 de-journals itself, so the correct order — 0055 then 0052 — is
-- always available and this refusal is never a dead end. That property is exactly what BLOCKER 2
-- destroyed and what this series restores.
--
-- LOCK SAFETY — ADDED 2026-08-07. Every statement below takes ACCESS EXCLUSIVE: DROP POLICY,
-- ALTER TABLE ... DISABLE ROW LEVEL SECURITY, GRANT/REVOKE and CREATE POLICY all do, on
-- partner_internal_notes, partner_management_audit, partner_service_tiers and cert_counter.
-- ACCESS EXCLUSIVE blocks READS as well as writes, and a request that has to QUEUE behind an
-- existing AccessShareLock also blocks every reader that arrives after it. partner_service_tiers
-- is on the pricing-resolution path and cert_counter is the platform-wide certificate-number
-- allocator shared by HQ grading and the partner connector, so an unbounded wait here stalls
-- certificate issuance for both. The numbered runner NEVER executes rollback files
-- (scripts/db/migrate.ts's FILE_RE matches only `NNNN_*.sql`), so its lock_timeout machinery does
-- not apply and an unbounded wait is genuinely unbounded. The bound goes inside this file's own
-- transaction, before the first lock is taken — the shape rollback-0049 established. SET LOCAL is
-- discarded at COMMIT/ROLLBACK so it cannot leak into the operator's psql session; if it fires the
-- whole file aborts atomically and nothing is changed.

BEGIN;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
SET LOCAL lock_timeout = '5s';

-- ---- 0. Refuse while any migration numbered above 52 is journalled ------------------------------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole IF expression up front, so a
-- direct reference raises 42P01 on any database that has no schema_migrations table.
DO $$
DECLARE
  later_migrations bigint := 0;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 52$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION
        'rollback-0052 refused: % later migration journal row(s) exist. 0055 redefines the policies '
        'this file restores on partner_internal_notes and partner_management_audit, so running '
        'underneath it leaves both policies in place and 0052 can never be re-applied. Roll back the '
        'newer migrations first (each de-journals itself, so the order is always available).',
        later_migrations;
    END IF;
  END IF;
END$$;

-- ---- 1. Undo the evidence-table repair (both halves) ------------------------------------------
DROP POLICY IF EXISTS partner_internal_notes_tenant_isolation  ON partner_internal_notes;
DROP POLICY IF EXISTS partner_management_audit_tenant_isolation ON partner_management_audit;

ALTER TABLE partner_internal_notes   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_internal_notes   DISABLE ROW LEVEL SECURITY;
ALTER TABLE partner_management_audit NO FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_management_audit DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON partner_internal_notes, partner_management_audit TO partner_connector_runtime;

-- ---- 2. Undo the A8-F7 service-tier policy split -----------------------------------------------
DROP POLICY IF EXISTS partner_service_tiers_global_read  ON partner_service_tiers;
DROP POLICY IF EXISTS partner_service_tiers_tenant_write ON partner_service_tiers;

CREATE POLICY partner_service_tiers_tenant_isolation ON partner_service_tiers
  USING (tenant_id IS NULL OR tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

-- ---- 3. Undo the A8-F5 allocator tightening ----------------------------------------------------
-- REVOKE ALL removes the COLUMN-level grants too (revoking a table-level privilege revokes the
-- corresponding per-column ones), so the table-level GRANT below lands on a clean slate rather
-- than layering on top of 0052's column grants.
DO $$
BEGIN
  IF to_regclass('public.cert_counter') IS NOT NULL THEN
    REVOKE ALL ON cert_counter FROM partner_connector_runtime;
    GRANT SELECT, INSERT, UPDATE ON cert_counter TO partner_connector_runtime;
  END IF;
END$$;

-- ---- 4. Prove the restoration actually happened ------------------------------------------------
DO $$
DECLARE
  t       text;
  enabled boolean;
  npolicy integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_internal_notes', 'partner_management_audit'] LOOP
    SELECT c.relrowsecurity INTO enabled
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t;
    IF enabled THEN
      RAISE EXCEPTION 'rollback-0052: RLS is still enabled on %', t;
    END IF;
    IF NOT has_table_privilege('partner_connector_runtime', format('public.%I', t), 'INSERT') THEN
      RAISE EXCEPTION 'rollback-0052: the partner_connector_runtime INSERT grant on % was not restored', t;
    END IF;
  END LOOP;

  SELECT count(*) INTO npolicy
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_service_tiers';
  IF npolicy <> 1 THEN
    RAISE EXCEPTION 'rollback-0052: expected exactly 1 policy on partner_service_tiers, found %', npolicy;
  END IF;

  IF to_regclass('public.cert_counter') IS NOT NULL
     AND NOT has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'id', 'UPDATE') THEN
    RAISE EXCEPTION 'rollback-0052: the table-level cert_counter UPDATE grant was not restored';
  END IF;
END$$;

-- ---- 5. Delete this migration's own journal row ------------------------------------------------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. That is defect D4 from rollback-0045's header, avoided here rather than repeated.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0052_partner_internal_evidence_rls.sql'$q$;
  END IF;
END$$;

COMMIT;
