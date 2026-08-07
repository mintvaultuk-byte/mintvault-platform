-- 0055_partner_hq_control_tables_write_deny.sql
-- SECURITY REPAIR — finish the defence-in-depth layer 0051 described and only half-delivered.
--
-- ============================================================================================
-- WHAT WAS WRONG
-- ============================================================================================
-- 0051 states, as the reason its policy SPLIT exists at all (0051:74-79):
--
--     "This is defence in depth against step 1 being undone: if a future blanket GRANT loop hands
--      DELETE back, the global row is still unreachable, because no policy permits a non-owning
--      tenant to see it for a write."
--
-- That is true for partner_feature_flags, and 0052 replicated it for partner_service_tiers. It is
-- NOT true for the other three tables in the same family, which received the REVOKE and nothing
-- else:
--
--     partner_emergency_controls   0001:219-235   FOR ALL USING (tenant_id = partner_current_tenant())
--     partner_internal_notes       0052:224-238   FOR ALL USING (tenant_id = partner_current_tenant())
--     partner_management_audit     0052:224-238   FOR ALL USING (tenant_id = partner_current_tenant())
--
-- A tenant-equality policy on cmd = ALL admits the tenant's OWN rows into the USING clause of
-- UPDATE and DELETE. On these three tables the tenant's own rows ARE the asset: an HQ-imposed
-- freeze, HQ's internal notes about that partner, and the audit ledger of what HQ did to them.
-- "Only your own rows" is the wrong boundary when the rows are evidence ABOUT you.
--
-- REPRODUCED on a disposable PostgreSQL 17 cluster, full chain applied under the realistic
-- NOSUPERUSER / NOBYPASSRLS role model, restoring only the blanket DML grant that 0001's DO loop
-- would hand back, acting inside an ordinary authenticated tenant context:
--
--     DELETE FROM partner_emergency_controls WHERE tenant_id = <own>;   -> DELETE 1  (freeze SELF-LIFTED)
--     SELECT  FROM partner_internal_notes    WHERE tenant_id = <own>;   -> HQ notes READ
--     DELETE FROM partner_management_audit   WHERE tenant_id = <own>;   -> DELETE 1  (evidence DESTROYED)
--
-- while the two tables that DID get the structural treatment correctly returned DELETE 0.
--
-- ============================================================================================
-- THE FIX — THE SAME STRUCTURAL TREATMENT, WITH THE BOUNDARY SET WHERE THE EVIDENCE IS
-- ============================================================================================
-- The rule 0051 articulated, applied literally: no policy may admit ANY row into a write command's
-- USING clause for a tenant-scoped role. Permissive policies are OR-ed, so a `USING (false)`
-- write policy is a floor that a restored GRANT cannot lift and that a future permissive read
-- policy cannot widen.
--
--   * partner_emergency_controls — READ is retained, tenant-scoped, because it is load-bearing:
--     server/partner/emergency.ts:30-33 readEmergencyState() runs on the RUNTIME pool on every
--     gated request, and 0051's own post-flight asserts partner_runtime keeps SELECT. Writes are
--     denied outright. HQ writes it through the BYPASSRLS admin pool
--     (server/partner/admin-routes.ts:271), which policies do not apply to.
--
--   * partner_internal_notes and partner_management_audit — DENIED ENTIRELY, read included. This
--     goes further than 0052's tenant policy deliberately, and it costs nothing: 0052's own
--     verified inventory (0052:27-39) found that EVERY reference to either table in the whole
--     repository runs on the privileged admin pool, and 0052 revoked the connector grant as dead
--     privilege on exactly that evidence. There is no code path for a restricted role to break.
--     A partner-facing view of its own audit trail, if it is ever wanted, is then an explicit new
--     policy rather than something that was quietly always true.
--
-- The policies are kept (rather than the tables left policy-less) so the catalogue sweep in
-- tests/partner-rls-isolation.test.ts still sees a policy-bearing table, and so the intent is
-- readable in `\d` instead of being an absence someone later "fixes".
--
-- ADMIN POOL UNAFFECTED: BYPASSRLS outranks FORCE ROW LEVEL SECURITY, so every HQ read and write
-- above continues to work unchanged. Verified in the post-flight by attribute, not assumed.
--
-- ROLLBACK: migrations/rollback-0055-partner-hq-control-tables-write-deny.sql restores the three
-- pre-0055 policies exactly as 0001 and 0052 left them, and deletes its own journal row.

-- --------------------------------------------------------------------------------------------
-- PRE-FLIGHT. A policy is meaningless against BYPASSRLS, so refuse rather than certify.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  r         record;
  t         text;
BEGIN
  FOR r IN SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
            WHERE rolname IN ('partner_runtime', 'partner_connector_runtime') LOOP
    IF r.rolsuper OR r.rolbypassrls THEN
      RAISE EXCEPTION
        '0055: % is SUPERUSER or BYPASSRLS (super=%, bypass=%). The write-deny policies below would '
        'be unenforceable against it, so this repair cannot deliver the containment it claims. '
        'Fix the role first.', r.rolname, r.rolsuper, r.rolbypassrls;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    RAISE EXCEPTION '0055: role partner_runtime does not exist; 0001 must be applied first';
  END IF;

  FOREACH t IN ARRAY ARRAY['partner_emergency_controls', 'partner_internal_notes', 'partner_management_audit'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION '0055: table public.% is missing', t;
    END IF;
    -- RLS must already be ENABLE + FORCE (0001 for emergency controls, 0052 for the other two).
    -- A policy on a table without RLS is decoration.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '0055: % is not ENABLE + FORCE ROW LEVEL SECURITY; 0001/0052 must be applied first', t;
    END IF;
  END LOOP;

  IF to_regprocedure('public.partner_current_tenant()') IS NULL THEN
    RAISE EXCEPTION '0055: partner_current_tenant() is missing; the read policy below would be invalid';
  END IF;
END$$;

-- --------------------------------------------------------------------------------------------
-- 1) partner_emergency_controls — tenant-scoped READ retained, ALL WRITES denied.
-- --------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS partner_emergency_controls_tenant_isolation  ON partner_emergency_controls;
DROP POLICY IF EXISTS partner_emergency_controls_tenant_read       ON partner_emergency_controls;
DROP POLICY IF EXISTS partner_emergency_controls_no_tenant_write   ON partner_emergency_controls;

-- Read: byte-for-byte 0001's predicate. readEmergencyState() depends on it.
CREATE POLICY partner_emergency_controls_tenant_read ON partner_emergency_controls
  FOR SELECT
  USING (tenant_id = partner_current_tenant());

-- Write: no row is admissible, for any tenant-scoped role, with or without a DML grant. USING
-- governs which rows UPDATE and DELETE may target; WITH CHECK governs what INSERT and UPDATE may
-- produce. Both are false, so an HQ-imposed freeze cannot be self-lifted, edited or forged.
CREATE POLICY partner_emergency_controls_no_tenant_write ON partner_emergency_controls
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- --------------------------------------------------------------------------------------------
-- 2) partner_internal_notes and partner_management_audit — HQ-only, read and write.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_internal_notes', 'partner_management_audit'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_no_tenant_access ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_no_tenant_access ON %I FOR ALL USING (false) WITH CHECK (false)', t, t
    );
  END LOOP;
END$$;

-- --------------------------------------------------------------------------------------------
-- POST-FLIGHT. Self-proving assertions.
--
-- STRUCTURAL only, deliberately: a migration runs as the migrator inside one uncommitted
-- transaction and cannot honestly attack itself. The BEHAVIOURAL proof — restore the blanket DML
-- grant, then confirm DELETE 0 and 0 rows for a genuinely restricted role on all three tables —
-- lives in tests/partner-rls-isolation.test.ts.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  t       text;
  npolicy integer;
  bad     text;
BEGIN
  -- (a) No policy on any of the three admits a row into a WRITE command's USING clause.
  --     `qual` is NULL for a WITH CHECK-only policy and 'false' for the deny policies above.
  SELECT string_agg(format('%s/%s (cmd=%s, qual=%s)', tablename, policyname, cmd, qual), '; ')
    INTO bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('partner_emergency_controls', 'partner_internal_notes', 'partner_management_audit')
     AND cmd <> 'SELECT'
     AND (qual IS NULL OR qual <> 'false');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      '0055: a non-SELECT policy still admits rows on an HQ control/evidence table: %. '
      'A restored blanket GRANT would reach them.', bad;
  END IF;

  -- (b) The emergency-control READ branch must SURVIVE. Over-tightening it would fail every
  --     emergency gate closed in production; it must fail here instead.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'partner_emergency_controls'
       AND cmd = 'SELECT' AND qual LIKE '%partner_current_tenant()%'
  ) THEN
    RAISE EXCEPTION
      '0055: the tenant-scoped READ branch on partner_emergency_controls was lost; '
      'readEmergencyState() (server/partner/emergency.ts:30-33) runs on the runtime pool';
  END IF;
  IF NOT has_table_privilege('partner_runtime', 'public.partner_emergency_controls', 'SELECT') THEN
    RAISE EXCEPTION '0055: partner_runtime lost SELECT on partner_emergency_controls';
  END IF;

  -- (c) The two evidence tables carry exactly one policy each, and it is the deny-all one.
  FOREACH t IN ARRAY ARRAY['partner_internal_notes', 'partner_management_audit'] LOOP
    SELECT count(*) INTO npolicy FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF npolicy <> 1 THEN
      RAISE EXCEPTION '0055: expected exactly 1 policy on %, found %', t, npolicy;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND cmd = 'ALL' AND qual = 'false' AND with_check = 'false'
    ) THEN
      RAISE EXCEPTION '0055: the policy on % is not the deny-all policy this file installs', t;
    END IF;
  END LOOP;

  -- (d) partner_emergency_controls carries exactly the two policies above and nothing else.
  SELECT count(*) INTO npolicy
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_emergency_controls';
  IF npolicy <> 2 THEN
    RAISE EXCEPTION '0055: expected exactly 2 policies on partner_emergency_controls, found %', npolicy;
  END IF;

  -- (e) 0051's revoke must not have been undone by anything between then and now — otherwise the
  --     policies above are the ONLY thing standing, which is not defence in depth.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = 'partner_runtime'
       AND table_name = 'partner_emergency_controls'
       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION '0055: partner_runtime holds a write grant on partner_emergency_controls; 0051''s revoke was undone';
  END IF;
END$$;
