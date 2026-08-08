-- 0052_partner_internal_evidence_rls.sql
-- SECURITY REPAIR — close the remaining RLS / role-exposure findings on the tenant-keyed estate.
--
-- ============================================================================================
-- HOW THIS WAS FOUND: THE CATALOGUE, NOT AN ALLOWLIST
-- ============================================================================================
-- The full migration chain (0001 … 0051) was applied to a disposable PostgreSQL 17 cluster under
-- the realistic NOSUPERUSER / NOBYPASSRLS role model, and the catalogue was then asked which
-- tables carry a tenant_id column. It answered THIRTY-FOUR. Three of them had neither RLS nor a
-- policy:
--
--   partner_connector_records   rls=f force=f policies=0   partner_connector_runtime: SELECT,INSERT,UPDATE
--   partner_internal_notes      rls=f force=f policies=0   partner_connector_runtime: SELECT,INSERT
--   partner_management_audit    rls=f force=f policies=0   partner_connector_runtime: SELECT,INSERT
--
-- An earlier review cleared all three on the grounds that they carry no `partner_runtime` grant.
-- That checked the WRONG ROLE. `partner_connector_runtime` was verified in the same run to be
-- rolsuper=f, rolbypassrls=f — a genuinely restricted role — so a grant to it is real reach, and
-- with no RLS the reach is the WHOLE TABLE, every tenant at once.
--
-- ============================================================================================
-- WHAT THIS MIGRATION CLOSES, AND WHY EACH REPAIR IS THE ONE IT IS
-- ============================================================================================
--
-- (1) partner_internal_notes and partner_management_audit — CLOSED TWICE OVER.
--
--     The grant is 0015_partner_management.sql:159:
--         GRANT SELECT, INSERT ON partner_internal_notes, partner_management_audit
--           TO partner_connector_runtime;
--     Its own comment says these are "internal-EVIDENCE tables … granted to the internal
--     non-partner-facing runtime role only". But the code never took it up. EVERY reference to
--     either table in the entire repository runs on the PRIVILEGED ADMIN pool, which is BYPASSRLS
--     and needs no grant of its own:
--         server/partner/partner-management-service.ts  — partnerAdminQuery / withPartnerAdminTransaction
--           :950  INSERT partner_internal_notes            :2094 SELECT partner_internal_notes
--           :262,:284,:321,:351,:447,:462,:1089,:1161,:1259,:1520,:1647,:1965  INSERT partner_management_audit
--           :375,:2109,:2153  SELECT partner_management_audit
--         server/partner/dashboard-service.ts:1006,:1021  — partnerAdminQuery, SELECT partner_management_audit
--     There is NO connector-pool query against either table. The grant is dead privilege.
--
--     So the primary repair is the strongest available and costs nothing: REVOKE it. Least
--     privilege beats a policy, because a revoked grant cannot be defeated by a policy mistake.
--
--     RLS is then added ON TOP as defence in depth, so that if a future blanket GRANT loop hands
--     the privilege back (which is exactly how 0001's DO loop created the kill-switch defect 0051
--     had to repair), the table is still tenant-scoped rather than wide open. Both halves are
--     asserted in the post-flight.
--
--     SAFE FOR THE ADMIN POOL: BYPASSRLS outranks FORCE ROW LEVEL SECURITY, so the admin pool's
--     existing cross-tenant reads (which already carry an explicit WHERE tenant_id = $1) are
--     unaffected. This is byte-for-byte the pattern 0015:138-149 already applied to
--     partner_profiles / partner_contacts / partner_branding.
--
-- (2) partner_service_tiers — A8-F7, the `tenant_id IS NULL` vs WITH CHECK asymmetry.
--
--     Its policy is the same shape 0051 had to repair on partner_feature_flags:
--         USING      ((tenant_id IS NULL) OR (tenant_id = partner_current_tenant()))
--         WITH CHECK (tenant_id = partner_current_tenant())
--     on cmd = ALL. PostgreSQL governs DELETE by USING ALONE — WITH CHECK is never consulted for a
--     row being removed — so the permissive global-read branch doubles as a permissive DELETE
--     branch over the PLATFORM-WIDE service-tier rows.
--
--     0051 examined this table, found partner_runtime holds only SELECT on it, and deliberately
--     left it alone rather than churn it. That reasoning was correct about TODAY and is recorded
--     honestly in 0051's header. It is not a durable guarantee: the defect is one blanket GRANT
--     away from being live, and the pricing rows a tenant could delete drive what every partner is
--     charged. Splitting the policy makes the grant irrelevant — no policy would admit a global row
--     into a write command's USING clause, so restoring DELETE would still not reach it.
--
--     The read behaviour is unchanged, byte for byte: permissive policies are OR-ed, and the
--     SELECT branch below is the original USING clause verbatim.
--
-- (3) cert_counter — A8-F5, 0049's table-level allocator grant.
--
--     0049_partner_grading_work_items.sql:322-326 issues
--         GRANT SELECT, INSERT, UPDATE ON cert_counter TO partner_connector_runtime;
--     cert_counter is the SINGLE-ROW, PLATFORM-GLOBAL certificate-number allocator
--     (server/storage.ts:1336-1348 — id integer PK, last_issued integer, updated_at). It has no
--     tenant_id and never will; it is shared by MintVault HQ grading and by the Partner connector
--     alike.
--
--     The connector genuinely needs to write it — server/partner/connector-import-service.ts:57-61
--     seeds the row and increments it to allocate each partner certificate number — so this grant
--     cannot simply be revoked the way (1) can. But TABLE-LEVEL UPDATE is wider than that need: it
--     includes UPDATE on the PRIMARY KEY. With UPDATE(id) the connector role can re-point the
--     allocator row (`UPDATE cert_counter SET id = 2`) and then insert a fresh id=1 row at
--     last_issued = 0, after which every subsequently issued certificate number COLLIDES with
--     already-printed slabs — platform-wide, including HQ's own, not merely the partner estate.
--
--     Replaced with column-level grants covering exactly what the two call sites use:
--         SELECT (id, last_issued)   -- `WHERE id = 1`, and `RETURNING last_issued`
--         INSERT (id, last_issued)   -- the ON CONFLICT DO NOTHING seed
--         UPDATE (last_issued, updated_at)  -- the increment; id is NOT included
--     `updated_at` is included because the increment sets it; `id` is excluded, which is the point.
--
--     GUARDED BY to_regclass, exactly as 0049 guards its own grant, because cert_counter is created
--     at application boot by storage.ts:ensureCertCounterTable() and may legitimately not exist yet
--     on a fresh database. If it is absent, 0049's grant never happened either, so there is nothing
--     to tighten and skipping is correct rather than lenient. The post-flight asserts the end state
--     only when the table exists, and records the skip explicitly so it cannot be mistaken for a
--     silent pass.
--
-- ============================================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO — partner_connector_records
-- ============================================================================================
-- partner_connector_records is left RLS-less ON PURPOSE, as a registered exception rather than an
-- oversight. Enabling RLS on it would not harden the system; it would silently destroy the
-- connector pipeline, which is a strictly worse outcome than the privilege-model defect it closes.
--
-- THE TABLE IS A CROSS-TENANT WORK QUEUE, BY DESIGN. server/partner/connector-service.ts:332-347,
-- `claimNextConnectorRecord`, is the connector's central claim loop. It runs on the connector pool
-- inside `withConnectorTx(fn)` with NO tenant argument, and selects deliberately across every
-- tenant at once:
--
--     SELECT * FROM partner_connector_records
--      WHERE state = 'queued'
--         OR (state IN ('claimed','validating','ready_for_import') AND claim_expires_at < now())
--      ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
--
-- `listRetryableConnectorRecords` (:755-767) is a second such sweep, on `connectorQuery`, which
-- opens no transaction and sets no GUC at all (connector-db.ts:93-103).
--
-- A strict `tenant_id = partner_current_tenant()` policy makes both return ZERO ROWS FOREVER. The
-- failure is silent — the worker claims nothing, imports stop, and partner submissions never
-- become certificates — while every migration status stays green. Fail-closed is the right default
-- for a data boundary and precisely the wrong outcome for a queue drain.
--
-- WHY THE EXPOSURE IS NONETHELESS CONTAINED, verified rather than asserted:
--   * partner_runtime — the role every partner-authenticated portal request uses — holds NO grant
--     of any kind on this table. Confirmed in the same catalogue sweep. The post-flight below
--     asserts it and will fail this migration if that ever stops being true.
--   * No partner-facing route reaches the connector pool. `getConnectorStatus` (:292), the only
--     connector read that takes a caller-supplied tenant id, has zero callers anywhere in the
--     repository; server/partner/routes.ts and mount.ts contain no connector surface at all.
--   * The whole connector plane below this table — partner_connector_events, _imports,
--     _import_attempts, _validation_runs, _validation_findings, _customer_links, _admin_actions —
--     carries no tenant_id column whatsoever and is keyed on connector_record_id. RLS on the root
--     alone would give partial containment at full breakage cost.
--
-- The isolation boundary for the connector plane is therefore the ROLE, not RLS. That is a real
-- architectural constraint, not an amnesty: it is pinned in the exception register in
-- tests/partner-rls-isolation.test.ts, asserted in BOTH directions (a table that gains RLS must
-- lose its register entry), and the correct long-term fix — moving queue DISCOVERY onto the
-- privileged BYPASSRLS pool that connector-runtime.ts:44-52 already uses for handoff discovery,
-- so the connector pool only ever touches one named tenant — is recorded there as follow-up work
-- that needs its own concurrency proof and is out of scope for a release gate.
--
-- ROLLBACK: migrations/rollback-0052-partner-internal-evidence-rls.sql. It restores every grant and
-- policy exactly as 0015 / 0001 / 0049 left them AND deletes its own journal row, so a re-apply is
-- not silently skipped.

-- --------------------------------------------------------------------------------------------
-- PRE-FLIGHT. Refuse to run if the repair would be cosmetic.
--
-- Same shape as 0050 and 0051: a REVOKE is security-meaningless against a SUPERUSER (ignores every
-- privilege check) and a policy is meaningless against BYPASSRLS (ignores every policy). Either
-- would leave this file journalled as applied while the hole stayed wide open — worse than not
-- running at all. Fail loudly instead.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  is_super  boolean;
  is_bypass boolean;
  t         text;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass
    FROM pg_roles WHERE rolname = 'partner_connector_runtime';

  IF is_super IS NULL THEN
    RAISE EXCEPTION '0052: role partner_connector_runtime does not exist; 0008 must be applied first';
  END IF;
  IF is_super THEN
    RAISE EXCEPTION
      '0052: partner_connector_runtime is SUPERUSER. Revoking privileges from a superuser changes '
      'nothing — it would ignore both the revoked grants and every row-level policy. Fix the role first.';
  END IF;
  IF is_bypass THEN
    RAISE EXCEPTION
      '0052: partner_connector_runtime is BYPASSRLS. The policies created below would be '
      'unenforceable against it, so this repair cannot deliver the isolation it claims. Fix the role first.';
  END IF;

  -- partner_runtime is not modified by this file, but the containment argument for
  -- partner_connector_records rests on its attributes too. Check it rather than trust it.
  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass
    FROM pg_roles WHERE rolname = 'partner_runtime';
  IF is_super IS NULL THEN
    RAISE EXCEPTION '0052: role partner_runtime does not exist; 0001 must be applied first';
  END IF;
  IF is_super OR is_bypass THEN
    RAISE EXCEPTION
      '0052: partner_runtime is SUPERUSER or BYPASSRLS (super=%, bypass=%). Every tenant policy on '
      'this estate, including the ones this file creates, would be unenforceable against the portal '
      'role. Fix the role before claiming any of this is isolation.', is_super, is_bypass;
  END IF;

  FOREACH t IN ARRAY ARRAY['partner_internal_notes', 'partner_management_audit', 'partner_service_tiers'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION '0052: table public.% is missing', t;
    END IF;
  END LOOP;

  -- to_regPROCEDURE, not to_regproc: only the former parses an argument list. to_regproc with
  -- parentheses returns NULL for a function that plainly exists, which would make this pre-flight
  -- refuse every correct database — a false alarm is as bad as a missed one.
  IF to_regprocedure('public.partner_current_tenant()') IS NULL THEN
    RAISE EXCEPTION '0052: partner_current_tenant() is missing; the policies below would be invalid';
  END IF;
END$$;

-- --------------------------------------------------------------------------------------------
-- 1) Least privilege: the internal-evidence tables are admin-pool-only, so take the dead grant away.
-- --------------------------------------------------------------------------------------------
REVOKE ALL ON partner_internal_notes  FROM partner_connector_runtime;
REVOKE ALL ON partner_management_audit FROM partner_connector_runtime;

-- --------------------------------------------------------------------------------------------
-- 2) Defence in depth: tenant-scope both tables, so a restored grant is still not a leak.
--    Written as a loop for exactly the reason 0015:138-149 used one — one definition, no drift.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_internal_notes', 'partner_management_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I '
      'USING (tenant_id = partner_current_tenant()) '
      'WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

-- --------------------------------------------------------------------------------------------
-- 3) A8-F7: the permissive global branch must govern reads only, never writes.
--     Identical treatment to 0051's partner_feature_flags split.
-- --------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS partner_service_tiers_tenant_isolation ON partner_service_tiers;
-- Same re-appliability guard as 0051's flag split: drop the names this file is about to create,
-- so a second apply cannot raise 42710.
DROP POLICY IF EXISTS partner_service_tiers_global_read ON partner_service_tiers;
DROP POLICY IF EXISTS partner_service_tiers_tenant_write ON partner_service_tiers;

-- Read: the original USING clause, verbatim. A global tier row (tenant_id IS NULL) stays readable
-- by every tenant and with no tenant context at all, which the pricing resolvers depend on.
CREATE POLICY partner_service_tiers_global_read ON partner_service_tiers
  FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = partner_current_tenant());

-- Write: strict tenant equality. USING governs which rows UPDATE and DELETE may target; WITH CHECK
-- governs the rows INSERT and UPDATE may produce. A global row satisfies neither, so it cannot be
-- deleted, updated or forged by any tenant-scoped role — with or without a DML grant.
CREATE POLICY partner_service_tiers_tenant_write ON partner_service_tiers
  FOR ALL
  USING (tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

-- --------------------------------------------------------------------------------------------
-- 4) A8-F5: column-level allocator grants replace 0049's table-level ones.
-- --------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.cert_counter') IS NOT NULL THEN
    REVOKE ALL ON cert_counter FROM partner_connector_runtime;
    GRANT SELECT (id, last_issued)            ON cert_counter TO partner_connector_runtime;
    GRANT INSERT (id, last_issued)            ON cert_counter TO partner_connector_runtime;
    GRANT UPDATE (last_issued, updated_at)    ON cert_counter TO partner_connector_runtime;
  ELSE
    RAISE NOTICE
      '0052: cert_counter absent — 0049''s grant never applied either, so there is nothing to '
      'tighten. storage.ts:ensureCertCounterTable() creates it at boot; re-run this file after '
      'the application has started at least once if the connector import path is in use.';
  END IF;
END$$;

-- --------------------------------------------------------------------------------------------
-- POST-FLIGHT. Self-proving assertions — this file rolls back rather than being journalled as
-- applied while any part of its claim is false.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  leaked   text;
  t        text;
  enabled  boolean;
  forced   boolean;
  npolicy  integer;
  ncols    integer;
BEGIN
  -- (a) The dead grants are gone, by ANY route (direct grant or role membership).
  SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ' ORDER BY table_name, privilege_type)
    INTO leaked
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND grantee      = 'partner_connector_runtime'
     AND table_name   IN ('partner_internal_notes', 'partner_management_audit');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION '0052: partner_connector_runtime still holds privileges on the evidence tables: %', leaked;
  END IF;

  -- (b) …and no column-level residue either. A table-level REVOKE does not remove column grants,
  --     so checking only role_table_grants would be a false all-clear.
  SELECT count(*) INTO ncols
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND grantee      = 'partner_connector_runtime'
     AND table_name   IN ('partner_internal_notes', 'partner_management_audit');
  IF ncols <> 0 THEN
    RAISE EXCEPTION '0052: % column-level privileges survive on the evidence tables', ncols;
  END IF;

  -- (c) partner_runtime must never have held anything on these tables, and must not gain it here.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = 'partner_runtime'
       AND table_name IN ('partner_internal_notes', 'partner_management_audit')
  ) THEN
    RAISE EXCEPTION '0052: partner_runtime holds a grant on an internal-evidence table — partner users could read HQ notes';
  END IF;

  -- (d) RLS is ENABLE + FORCE with exactly one isolation policy on each evidence table.
  FOREACH t IN ARRAY ARRAY['partner_internal_notes', 'partner_management_audit'] LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity INTO enabled, forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t;
    IF NOT enabled OR NOT forced THEN
      RAISE EXCEPTION '0052: % must be ENABLE + FORCE ROW LEVEL SECURITY (enabled=%, forced=%)', t, enabled, forced;
    END IF;
    -- No policy on these tables may be anything other than this file's tenant-isolation policy or
    -- 0056's deny-all. Counting "exactly 1" was asserting something STRICTER than the security
    -- property, and it made this file un-re-appliable: 0056 legitimately adds
    -- %I_no_tenant_access (USING false / WITH CHECK false) to the same two tables, so on any
    -- re-apply — the apply/rollback/reapply proof, a DR restore, a hand-run recovery — 0052 saw 2
    -- and aborted. Because the runner applies files in one transaction and stops on the first
    -- failure, that abort also took 0054 and 0055 down with it, which is why the cert_counter
    -- allocator guards read as "not enforcing": they were never installed.
    --
    -- 0056's policy is strictly MORE restrictive than this one, so its presence cannot weaken the
    -- guarantee. What must still be impossible is an UNEXPECTED policy, and that is what is
    -- asserted here instead — by name, so a permissive third policy is still a hard failure.
    SELECT count(*) INTO npolicy
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = t
       AND policyname NOT IN (t || '_tenant_isolation', t || '_no_tenant_access');
    IF npolicy <> 0 THEN
      RAISE EXCEPTION '0052: unexpected policy on % — found % policy(ies) that are neither %_tenant_isolation nor %_no_tenant_access', t, npolicy, t, t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_tenant_isolation'
    ) THEN
      RAISE EXCEPTION '0052: the tenant-isolation policy on % is missing', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND qual LIKE '%partner_current_tenant()%' AND with_check LIKE '%partner_current_tenant()%'
    ) THEN
      RAISE EXCEPTION '0052: the policy on % is not tenant-scoped in both USING and WITH CHECK', t;
    END IF;
  END LOOP;

  -- (e) The service-tier split is in place, and no surviving WRITE policy admits a global row.
  SELECT count(*) INTO npolicy
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_service_tiers';
  IF npolicy <> 2 THEN
    RAISE EXCEPTION '0052: expected exactly 2 policies on partner_service_tiers, found %', npolicy;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'partner_service_tiers'
       AND cmd <> 'SELECT' AND qual LIKE '%IS NULL%'
  ) THEN
    RAISE EXCEPTION
      '0052: a non-SELECT policy on partner_service_tiers still admits the global (tenant_id IS NULL) '
      'row into its USING clause — DELETE would remain reachable if a DML grant were restored';
  END IF;
  -- The permissive read branch must SURVIVE. Over-tightening it would fail pricing resolution
  -- closed in production; it must fail here instead.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'partner_service_tiers'
       AND cmd = 'SELECT' AND qual LIKE '%IS NULL%'
  ) THEN
    RAISE EXCEPTION '0052: the global service-tier READ branch was lost; every tenant would stop seeing platform tiers';
  END IF;

  -- (f) cert_counter: table-level privilege gone, column-level privilege exactly as intended, and
  --     specifically NO UPDATE on the primary key.
  IF to_regclass('public.cert_counter') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'cert_counter' AND grantee = 'partner_connector_runtime'
    ) THEN
      RAISE EXCEPTION '0052: table-level privilege on cert_counter survives for partner_connector_runtime';
    END IF;
    IF has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'id', 'UPDATE') THEN
      RAISE EXCEPTION
        '0052: partner_connector_runtime can still UPDATE cert_counter.id — the allocator could be '
        're-pointed and every future certificate number would collide platform-wide';
    END IF;
    -- The allocator path must still work: seed, increment, and read back.
    IF NOT (
      has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'id',          'SELECT') AND
      has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'last_issued', 'SELECT') AND
      has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'id',          'INSERT') AND
      has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'last_issued', 'INSERT') AND
      has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'last_issued', 'UPDATE') AND
      has_column_privilege('partner_connector_runtime', 'public.cert_counter', 'updated_at',  'UPDATE')
    ) THEN
      RAISE EXCEPTION
        '0052: the connector lost a column privilege the certificate-number allocator needs '
        '(connector-import-service.ts:57-61); partner imports would fail 42501';
    END IF;
  END IF;

  -- (g) The registered exception is still an exception and has not quietly widened: the portal role
  --     must hold NOTHING on partner_connector_records. If this ever fails, the containment
  --     argument in this file's header is void and the table needs real RLS plus the connector
  --     discovery rework described there.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'partner_connector_records' AND grantee = 'partner_runtime'
  ) THEN
    RAISE EXCEPTION
      '0052: partner_runtime has gained a grant on partner_connector_records, which has no RLS. '
      'The documented containment (role boundary, not row boundary) no longer holds.';
  END IF;
END$$;
