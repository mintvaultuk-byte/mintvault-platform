-- 0051_partner_runtime_flag_control_least_privilege.sql
-- SECURITY REPAIR — partner_runtime must not be able to WRITE the platform kill switches.
--
-- ============================================================================================
-- WHAT WAS WRONG
-- ============================================================================================
-- 0001_partner_foundation.sql:250-271 grants privileges to the Partner-facing runtime role with a
-- DO loop over eleven tables. Two tables are carved out by name — partner_organisations gets
-- SELECT only ("org lifecycle is SUPER-ADMIN only"), and the two append-only log tables get
-- SELECT, INSERT — and everything else falls through to the blanket ELSE branch:
--
--     EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO partner_runtime', t);
--
-- `partner_feature_flags` and `partner_emergency_controls` are in that blanket bucket. Both are
-- super-admin-write-only by the same file's own stated intent: 0001:236-238 says global flags are
-- "super-admin/out-of-band", and server/partner/emergency.ts:1-4 describes emergency controls as an
-- HQ-imposed stop enforced on every request. Neither is ever written by the runtime pool.
--
-- Verified against the application, not assumed. EVERY write to either table in the entire
-- repository goes through the PRIVILEGED admin pool:
--   server/partner/admin-routes.ts:257,261   DELETE + INSERT partner_feature_flags   (partnerAdminQuery)
--   server/partner/admin-routes.ts:271       INSERT partner_emergency_controls       (partnerAdminQuery)
--   server/partner/flag-admin-routes.ts:185,189  DELETE + INSERT global flag row     (withPartnerAdminTransaction)
-- Every partner_runtime reference is a SELECT:
--   server/partner/flags.ts:40,59   server/partner/emergency.ts:32
--   server/partner/dashboard-service.ts:944   server/partner/connector-runtime.ts:297
--
-- ============================================================================================
-- WHY THE DELETE GRANT IS THE SHARP EDGE, AND WHY THE EXISTING POLICY DOES NOT CONTAIN IT
-- ============================================================================================
-- 0001:239-242 deliberately widens the feature-flag policy so a GLOBAL row (tenant_id IS NULL) is
-- readable by every tenant:
--
--     USING      (tenant_id IS NULL OR tenant_id = partner_current_tenant())
--     WITH CHECK (tenant_id = partner_current_tenant())
--
-- and its comment states the intent as "writable only within one's own tenant". That is true for
-- INSERT and UPDATE, which consult WITH CHECK. It is NOT true for DELETE: PostgreSQL governs
-- DELETE by the USING clause ALONE — WITH CHECK is never consulted for a row that is being
-- removed. So the permissive read branch doubles as a permissive DELETE branch, and the DELETE
-- grant reaches the platform-global rows.
--
-- REPRODUCED on a disposable PostgreSQL 17 cluster, full migration set applied under the realistic
-- NOSUPERUSER/NOBYPASSRLS role model, acting as partner_runtime inside an ordinary authenticated
-- tenant context (app.tenant_id set to the actor's OWN tenant):
--
--   DELETE FROM partner_feature_flags WHERE flag='partner_emergency_stop' AND tenant_id IS NULL;
--     -> DELETE 1        (the PLATFORM-WIDE kill switch row, affecting every tenant)
--   DELETE FROM partner_emergency_controls WHERE tenant_id='<own tenant>';
--     -> DELETE 1        (an HQ-imposed fraud/abuse freeze, self-lifted)
--
-- Impact of each, read off the resolvers rather than inferred:
--   * server/partner/flags.ts:53-63 resolveGlobalFlag() returns TRUE only when a global row exists
--     AND enabled=true. Deleting the row therefore reads as "emergency stop is OFF" — the portal-
--     wide stop is LIFTED, not failed closed. The same primitive applied to partner_portal_enabled
--     takes the portal DOWN for every tenant.
--   * server/partner/emergency.ts:30-33 readEmergencyState() selects rows WHERE frozen = true.
--     Deleting a tenant's own row un-freezes that tenant, defeating the HQ hold.
--
-- HONEST SCOPE. No HTTP route today issues either DELETE on the runtime pool, so this is not a
-- live exploit chain — it is a privilege-model defect. Its cost is that it converts any future SQL
-- injection, or any ordinary coding mistake that runs a DELETE on the runtime pool, from a
-- tenant-local problem into a platform-wide kill-switch bypass. Least privilege is what keeps that
-- conversion impossible; this migration restores it.
--
-- ============================================================================================
-- WHAT THIS MIGRATION DOES
-- ============================================================================================
-- 1. Revokes INSERT, UPDATE, DELETE on both tables from partner_runtime. SELECT is deliberately
--    RETAINED and asserted below: every portal gate reads these tables on the runtime pool, and
--    resolveGlobalFlag() reads the global row with NO tenant context at all, which only works
--    because of the permissive read branch of the policy.
--
-- 2. Splits the feature-flag policy so the permissive `tenant_id IS NULL` branch applies to SELECT
--    ONLY, and writes are governed by a strict tenant-equality policy. This is defence in depth
--    against step 1 being undone: if a future blanket GRANT loop hands DELETE back, the global row
--    is still unreachable, because no policy permits a non-owning tenant to see it for a write.
--    Permissive policies are OR-ed, so the read behaviour is byte-for-byte unchanged.
--    The admin pool is BYPASSRLS and is unaffected by either policy.
--
-- NOT CHANGED, deliberately: partner_runtime keeps its write grants on the tables it genuinely
-- writes. partner_service_tiers carries the same permissive `tenant_id IS NULL OR ...` USING
-- clause, but partner_runtime holds only SELECT on it, so there is no write to leak — verified in
-- the same inventory and left alone rather than churned.
--
-- ROLLBACK: migrations/rollback-0051-partner-runtime-flag-control-least-privilege.sql restores
-- both the grants and the single combined policy exactly as 0001 left them.

-- --------------------------------------------------------------------------------------------
-- PRE-FLIGHT. Refuse to run if the repair would be cosmetic.
--
-- Generalised from 0046's pre-flight. A REVOKE is security-meaningless against a role that is
-- SUPERUSER (ignores all privilege checks) or BYPASSRLS (ignores all policies) — the migration
-- would be journalled as applied while the hole stayed wide open, which is worse than not running.
-- Fail loudly instead.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  is_super  boolean;
  is_bypass boolean;
  t         text;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass
    FROM pg_roles WHERE rolname = 'partner_runtime';

  IF is_super IS NULL THEN
    RAISE EXCEPTION '0051: role partner_runtime does not exist; 0001 must be applied first';
  END IF;
  IF is_super THEN
    RAISE EXCEPTION
      '0051: partner_runtime is SUPERUSER. Revoking privileges from a superuser changes nothing — '
      'it would ignore both the revoked grants and every row-level policy. Fix the role first.';
  END IF;
  IF is_bypass THEN
    RAISE EXCEPTION
      '0051: partner_runtime is BYPASSRLS. The policy split below would be unenforceable against '
      'it, so this repair cannot deliver the isolation it claims. Fix the role first.';
  END IF;

  FOREACH t IN ARRAY ARRAY['partner_feature_flags', 'partner_emergency_controls'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION '0051: table public.% is missing', t;
    END IF;
  END LOOP;
END$$;

-- --------------------------------------------------------------------------------------------
-- 1) Least privilege: read-only for the Partner-facing runtime role.
-- --------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON partner_feature_flags     FROM partner_runtime;
REVOKE INSERT, UPDATE, DELETE ON partner_emergency_controls FROM partner_runtime;

-- --------------------------------------------------------------------------------------------
-- 2) Structural containment: the permissive global-read branch must not govern writes.
-- --------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS partner_feature_flags_tenant_isolation ON partner_feature_flags;
-- The two names this file is about to CREATE are dropped too, so the file is re-appliable in
-- place. Dropping only the OLD name left a bare CREATE POLICY that raises 42710 on any second
-- apply — a DR restore, a hand-run recovery, or an apply/reapply proof. Every sibling in this
-- series already guards its own names (0047:102, 0049:243, 0052:230, 0056:114-116); this file
-- and 0052's service-tier split were the two that did not.
DROP POLICY IF EXISTS partner_feature_flags_global_read ON partner_feature_flags;
DROP POLICY IF EXISTS partner_feature_flags_tenant_write ON partner_feature_flags;

-- Read: unchanged semantics — a global row (tenant_id IS NULL) stays readable by every tenant, and
-- with no tenant context at all, which resolveGlobalFlag() depends on.
CREATE POLICY partner_feature_flags_global_read ON partner_feature_flags
  FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = partner_current_tenant());

-- Write: strict tenant equality for INSERT/UPDATE/DELETE. USING governs which rows may be targeted
-- by UPDATE and DELETE; WITH CHECK governs the rows INSERT and UPDATE may produce. A global row
-- satisfies neither, so it cannot be deleted, updated, or forged by any tenant-scoped role.
CREATE POLICY partner_feature_flags_tenant_write ON partner_feature_flags
  FOR ALL
  USING (tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

-- --------------------------------------------------------------------------------------------
-- POST-FLIGHT. Self-proving assertions — the migration rolls back rather than being journalled as
-- applied while any part of the claim is false.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  leaked   text;
  t        text;
  enabled  boolean;
  forced   boolean;
  npolicy  integer;
BEGIN
  -- (a) No write privilege survives, by any route (direct grant or role membership).
  SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ' ORDER BY table_name, privilege_type)
    INTO leaked
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND grantee      = 'partner_runtime'
     AND table_name   IN ('partner_feature_flags', 'partner_emergency_controls')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION '0051: partner_runtime still holds write privileges: %', leaked;
  END IF;

  -- (b) SELECT is RETAINED. Losing it would fail every portal gate closed and take the portal down;
  --     an over-tightening must fail here rather than in production.
  FOREACH t IN ARRAY ARRAY['partner_feature_flags', 'partner_emergency_controls'] LOOP
    IF NOT has_table_privilege('partner_runtime', format('public.%I', t), 'SELECT') THEN
      RAISE EXCEPTION '0051: partner_runtime lost SELECT on %, which every portal gate depends on', t;
    END IF;
  END LOOP;

  -- (c) RLS is still ENABLE + FORCE on both tables — the revoke must not have been mistaken for a
  --     substitute for row-level isolation.
  FOREACH t IN ARRAY ARRAY['partner_feature_flags', 'partner_emergency_controls'] LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity INTO enabled, forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t;
    IF NOT enabled OR NOT forced THEN
      RAISE EXCEPTION '0051: % must remain ENABLE + FORCE ROW LEVEL SECURITY (enabled=%, forced=%)',
        t, enabled, forced;
    END IF;
  END LOOP;

  -- (d) The policy split is in place: exactly the two new policies, and no surviving policy that
  --     lets a write command target a global row.
  SELECT count(*) INTO npolicy
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_feature_flags';
  IF npolicy <> 2 THEN
    RAISE EXCEPTION '0051: expected exactly 2 policies on partner_feature_flags, found %', npolicy;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'partner_feature_flags'
       AND cmd <> 'SELECT' AND qual LIKE '%IS NULL%'
  ) THEN
    RAISE EXCEPTION
      '0051: a non-SELECT policy on partner_feature_flags still admits the global (tenant_id IS NULL) '
      'row into its USING clause — DELETE would remain reachable if the grant were restored';
  END IF;
END$$;
