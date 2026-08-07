-- rollback-0056-partner-hq-control-tables-write-deny.sql
--
-- Restores the pre-0056 policies exactly:
--   * partner_emergency_controls  -> 0001's single combined FOR ALL tenant-isolation policy;
--   * partner_internal_notes      -> 0052's FOR ALL tenant-isolation policy;
--   * partner_management_audit    -> 0052's FOR ALL tenant-isolation policy.
--
-- ⚠️ APPLYING THIS RE-OPENS THE DEFECT 0056 CLOSED. Afterwards a tenant-equality policy on
-- cmd = ALL again admits a tenant's OWN rows into the USING clause of UPDATE and DELETE on all
-- three tables — and on these tables the tenant's own rows ARE the asset. If any blanket DML grant
-- is ever restored, a partner can self-lift an HQ-imposed emergency freeze, read HQ's internal
-- notes about itself, and delete the audit ledger of what HQ did to it. Use this only to unblock
-- an unrelated failure, and re-apply 0056 immediately afterwards.
--
-- Not destructive to data: no row is read, written or removed — this file only replaces policy
-- definitions. It does NOT restore any grant: 0051 revoked partner_runtime's writes on
-- partner_emergency_controls and 0052 revoked partner_connector_runtime's grants on the two
-- evidence tables, and those revokes belong to rollback-0051 and rollback-0052 respectively.
-- Reverting them here would silently widen the blast radius of a rollback whose stated scope is
-- "restore the previous policy shape".
--
-- JOURNAL HANDLING. The final block DELETEs this migration's own journal row. Without it
-- scripts/db/migrate.ts:planMigrations (migrate.ts:449-462) would still classify 0056 as
-- alreadyApplied and SKIP it on the next run, so the database would sit in the rolled-back state
-- behind a green migration status. The filename there is DATA, not a comment — it must track any
-- renumbering of this file, because a rename-by-grep would miss it.
--
-- NO "LATER MIGRATIONS" REFUSAL, DELIBERATELY: this file drops nothing structural and changes only
-- policy definitions, so nothing later can be structurally invalidated by it. Same reasoning as
-- rollback-0050/0051/0052/0054/0055.
--
-- LOCK SAFETY. DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE, which blocks READS as well as
-- writes. partner_emergency_controls is read on the RUNTIME pool by readEmergencyState()
-- (server/partner/emergency.ts:30-33) on every gated partner request, so a queued lock here stalls
-- the portal. The numbered runner never executes rollback files, so its lock_timeout machinery does
-- not apply; the bound goes inside this file's own transaction, before the first lock is taken, and
-- is deliberately tight for the same reason rollback-0051's is.

BEGIN;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
SET LOCAL lock_timeout = '2s';

-- ---- 1. partner_emergency_controls -> 0001's combined policy ----------------------------------
DROP POLICY IF EXISTS partner_emergency_controls_tenant_read     ON partner_emergency_controls;
DROP POLICY IF EXISTS partner_emergency_controls_no_tenant_write ON partner_emergency_controls;
-- Drop the name we are about to CREATE too, so a second run of this file does not raise 42710.
DROP POLICY IF EXISTS partner_emergency_controls_tenant_isolation ON partner_emergency_controls;

CREATE POLICY partner_emergency_controls_tenant_isolation ON partner_emergency_controls
  USING (tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

-- ---- 2. the two evidence tables -> 0052's tenant-isolation policies ----------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_internal_notes', 'partner_management_audit'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_no_tenant_access ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I '
      'USING (tenant_id = partner_current_tenant()) '
      'WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

-- ---- 3. Prove the restoration actually happened ------------------------------------------------
DO $$
DECLARE
  t       text;
  npolicy integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_emergency_controls', 'partner_internal_notes', 'partner_management_audit'] LOOP
    SELECT count(*) INTO npolicy FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF npolicy <> 1 THEN
      RAISE EXCEPTION 'rollback-0056: expected exactly 1 policy on %, found %', t, npolicy;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND cmd = 'ALL'
         AND qual       LIKE '%partner_current_tenant()%'
         AND with_check LIKE '%partner_current_tenant()%'
    ) THEN
      RAISE EXCEPTION 'rollback-0056: the restored policy on % is not the combined tenant-isolation policy', t;
    END IF;
  END LOOP;
END$$;

-- ---- 4. De-journal, so the runner re-applies 0056 instead of skipping it as applied ------------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. That is defect D4 from rollback-0045's header, avoided here rather than repeated.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0056_partner_hq_control_tables_write_deny.sql'$q$;
  END IF;
END$$;

COMMIT;
