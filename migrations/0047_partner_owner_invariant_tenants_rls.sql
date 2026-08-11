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

-- --------------------------------------------------------------------------------------------
-- PRE-FLIGHT. Refuse to run if the repair would be cosmetic.
--
-- ADDED 2026-08-07, closing a HIGH finding against this file. The post-flight assertions below
-- check relrowsecurity, relforcerowsecurity and the policy COUNT — all three of which are true
-- regardless of whether the policy binds ANYONE. A policy is meaningless against a BYPASSRLS role
-- and a privilege model is meaningless against a SUPERUSER, so with partner_runtime BYPASSRLS this
-- migration passed every one of its own assertions, was journalled `applied`, and left the A8-F1
-- leak FULLY INTACT — the worst possible outcome, because it also consumed the migration number
-- and closed the finding on paper.
--
-- Reproduced: with `ALTER ROLE partner_runtime BYPASSRLS`, 0047 completed green and
-- partner_owner_invariant_tenants still returned every tenant's UUID to a partner session.
--
-- This is 0051's pre-flight, generalised from 0046's, applied to the role THIS file's policy is
-- supposed to bind. Fail loudly instead of certifying isolation that does not exist.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  is_super  boolean;
  is_bypass boolean;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass
    FROM pg_roles WHERE rolname = 'partner_runtime';

  IF is_super IS NULL THEN
    RAISE EXCEPTION '0047: role partner_runtime does not exist; 0001 must be applied first';
  END IF;
  IF is_super THEN
    RAISE EXCEPTION
      '0047: partner_runtime is SUPERUSER. A superuser ignores every row-level policy, so the '
      'policy created below would bind nobody and this repair would be journalled as applied while '
      'partner_owner_invariant_tenants stayed readable network-wide. Fix the role first.';
  END IF;
  IF is_bypass THEN
    RAISE EXCEPTION
      '0047: partner_runtime is BYPASSRLS. The tenant-isolation policy created below would be '
      'unenforceable against it, so this repair cannot deliver the isolation it claims. Fix the '
      'role first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'partner_owner_invariant_tenants' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION '0047: table public.partner_owner_invariant_tenants is missing; 0032 must be applied first';
  END IF;

  -- to_regPROCEDURE, not to_regproc: only the former parses an argument list. Without the function
  -- the policy below would be invalid, and the failure would surface at first use rather than here.
  IF to_regprocedure('public.partner_current_tenant()') IS NULL THEN
    RAISE EXCEPTION '0047: partner_current_tenant() is missing; the policy below would be invalid';
  END IF;
END$$;

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
