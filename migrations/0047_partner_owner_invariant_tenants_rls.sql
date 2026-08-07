-- 0047_partner_owner_invariant_tenants_rls.sql
-- SECURITY REPAIR — A8-F1 (HIGH). Tenant isolation for partner_owner_invariant_tenants.
--
-- WHAT WAS WRONG. 0032_partner_final_owner_invariant.sql:9 creates
-- partner_owner_invariant_tenants and :117 grants SELECT, INSERT on it to partner_runtime — but it
-- never runs ENABLE ROW LEVEL SECURITY and never creates a policy. The five ROW LEVEL SECURITY
-- statements in that file (:26,:27,:38,:39) are a FORCE toggle around a backfill and concern
-- partner_users / partner_user_roles only.
--
-- Consequence, reproduced on a disposable PostgreSQL 17 cluster as a real NOSUPERUSER /
-- NOBYPASSRLS partner_runtime with a correct tenant-A GUC: partner_organisations returns 1 row
-- (isolated) while partner_owner_invariant_tenants returns BOTH tenants. With no GUC and with a
-- malformed GUC every other partner table returns 0 rows and this one still returns 2 — it ignores
-- tenant context entirely. Any authenticated partner session that reaches SQL can enumerate every
-- tenant UUID on the network plus each tenant's first-active-owner timestamp, and the INSERT grant
-- lets one tenant pin another tenant into the owner invariant.
--
-- Pre-existing since 0032. NOT introduced by the grading bridge. It is the only tenant-keyed table
-- that both lacks RLS and is granted to partner_runtime; the other RLS-less tenant tables are
-- documented exceptions with no partner_runtime grant.
--
-- WHY ENABLE **AND** FORCE, matching every sibling tenant table (see
-- 0031_partner_user_management.sql:61-62). FORCE subjects the table OWNER to the policy too. The
-- owner here is the migrator role, which never carries an app.tenant_id — so under FORCE a
-- migrator-run INSERT into this table fails LOUDLY on the WITH CHECK rather than silently writing a
-- row no tenant can see. That is the fail-closed direction. 0032's own backfill is unaffected: it
-- runs at 0032, before this file, and 0032 is already applied everywhere this file will land.
--
-- WHY THE partner_runtime GRANTS ARE NOT REVOKED. partner_enforce_final_owner_invariant()
-- (0032:41) is SECURITY **INVOKER** — it runs as whoever writes partner_users / partner_user_roles,
-- i.e. as partner_runtime — and it both INSERTs into (0032:63) and SELECTs from (0032:76) this
-- table. Revoking either grant would break the final-owner invariant outright. The policy is what
-- closes the hole: USING confines the SELECT at 0032:76 to the caller's own tenant, and WITH CHECK
-- makes the cross-tenant "pin" INSERT impossible instead of merely unaudited.
--
-- WHY THE INVARIANT STILL ENFORCES UNDER RLS. The `affected` tenant array in that function is
-- derived from NEW/OLD rows of partner_users / partner_user_roles / partner_organisations, all of
-- which are themselves RLS-bound to tenant_id = partner_current_tenant(). A partner_runtime session
-- therefore cannot produce an `affected` tenant other than its own, so the EXISTS probe at 0032:74
-- sees exactly the rows it saw before this migration. Admin pools run BYPASSRLS and are unaffected
-- by both ENABLE and FORCE.

DO $$
BEGIN
  ALTER TABLE partner_owner_invariant_tenants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE partner_owner_invariant_tenants FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS partner_owner_invariant_tenants_tenant_isolation
    ON partner_owner_invariant_tenants;
  CREATE POLICY partner_owner_invariant_tenants_tenant_isolation
    ON partner_owner_invariant_tenants
    USING (tenant_id = partner_current_tenant())
    WITH CHECK (tenant_id = partner_current_tenant());
END$$;

-- Self-proving assertions. If any of these fail the migration rolls back, so the repair cannot be
-- recorded as applied while the table is still open.
DO $$
DECLARE
  enabled boolean;
  forced  boolean;
  npolicy integer;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO enabled, forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'partner_owner_invariant_tenants';

  IF enabled IS NULL THEN
    RAISE EXCEPTION '0047: partner_owner_invariant_tenants does not exist';
  END IF;
  IF NOT enabled THEN
    RAISE EXCEPTION '0047: ROW LEVEL SECURITY is not enabled on partner_owner_invariant_tenants';
  END IF;
  IF NOT forced THEN
    RAISE EXCEPTION '0047: FORCE ROW LEVEL SECURITY is not set on partner_owner_invariant_tenants';
  END IF;

  SELECT count(*) INTO npolicy
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'partner_owner_invariant_tenants'
     AND policyname = 'partner_owner_invariant_tenants_tenant_isolation';
  IF npolicy <> 1 THEN
    RAISE EXCEPTION '0047: expected exactly 1 tenant-isolation policy, found %', npolicy;
  END IF;
END$$;
