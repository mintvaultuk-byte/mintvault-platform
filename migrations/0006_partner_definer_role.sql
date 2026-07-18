-- 0006_partner_definer_role.sql
-- Phase 1 — DB-F1 fix: dedicated least-privileged SECURITY DEFINER owner under FORCE RLS.
--
-- WHY: partner_auth_lookup / partner_session_lookup / partner_reset_token_tenant run BEFORE any
-- trusted tenant context exists, so they must read across all tenants. Every partner table is
-- FORCE ROW LEVEL SECURITY, which subjects even the table OWNER to RLS unless that owner has
-- BYPASSRLS. If those SECURITY DEFINER functions are owned by an ordinary (non-BYPASSRLS) role
-- — the realistic production case — the RLS predicate `tenant_id = partner_current_tenant()`
-- resolves to `tenant_id = NULL`, matches zero rows, and partner login/session discovery break
-- (fail-closed). The disposable harness masked this because migrations ran as a superuser owner.
--
-- FIX: introduce a dedicated, least-privileged role `partner_definer` (NOLOGIN, NOSUPERUSER,
-- BYPASSRLS) that owns ONLY these three pre-auth functions and holds ONLY SELECT on the exact
-- tables they read. The application runtime role `partner_runtime` stays NOBYPASSRLS, owns no
-- functions or tables, and merely holds EXECUTE. No production superuser is required at runtime.
--
-- PROVISIONING NOTE (migration-time authority): creating a BYPASSRLS role requires the applying
-- role to be a superuser OR to itself hold CREATEROLE + BYPASSRLS. On managed Postgres (Neon)
-- the standard migration role may not have this; in that case `partner_definer` must be
-- provisioned ONCE by an elevated role before this migration is applied (see
-- docs/runbooks/db-migration-safety.md). This migration CREATES the role when it has the
-- authority, otherwise RECONCILES/verifies it and FAILS CLOSED if it is absent or misconfigured.
-- The reassignment of function ownership requires the applying role to be a member of
-- partner_definer; this migration grants that membership to the current role when it is able to.

-- 1) Create-or-reconcile the dedicated definer role at least privilege.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_definer') THEN
    BEGIN
      CREATE ROLE partner_definer
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'partner_definer is absent and the current role lacks authority to create a BYPASSRLS role. Provision it once with an elevated role (see db-migration-safety runbook), then re-apply 0006.';
    END;
  ELSE
    -- Reconcile ONLY the approved least-privilege attributes. Tolerate lack of privilege here;
    -- the hard assertion below fails closed if the resulting attributes are still wrong.
    BEGIN
      ALTER ROLE partner_definer
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
END$$;

-- 2) Fail closed unless the definer role is exactly as designed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'partner_definer'
       AND rolbypassrls        -- required: bypass FORCE RLS for pre-auth lookups
       AND NOT rolcanlogin      -- must not be a login role
       AND NOT rolsuper         -- must not be a superuser
       AND NOT rolcreaterole    -- least privilege
       AND NOT rolcreatedb
       AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'partner_definer misconfigured: require NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS.';
  END IF;
  -- Defensive: the runtime role must never bypass RLS or be a superuser.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime' AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'partner_runtime must be NOSUPERUSER and NOBYPASSRLS.';
  END IF;
END$$;

-- 3) Make the current (migration) role a member of partner_definer so it can reassign object
--    ownership. No-op/tolerated when already a member or when running as superuser.
DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT partner_definer TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
    NULL;
  END;
END$$;

-- 4) Least-privilege data access for the definer: schema USAGE + SELECT on ONLY the tables the
--    three pre-auth functions read. No INSERT/UPDATE/DELETE, no other tables.
GRANT USAGE ON SCHEMA public TO partner_definer;
GRANT SELECT ON partner_users               TO partner_definer;  -- auth_lookup, session_lookup
GRANT SELECT ON partner_organisations       TO partner_definer;  -- auth_lookup, session_lookup
GRANT SELECT ON partner_sessions            TO partner_definer;  -- session_lookup
GRANT SELECT ON partner_locations           TO partner_definer;  -- session_lookup (LEFT JOIN)
GRANT SELECT ON partner_password_reset_tokens TO partner_definer; -- reset_token_tenant

-- 5) Transfer ownership of ONLY the three pre-auth SECURITY DEFINER functions to partner_definer.
--    These are the exact functions verified to require BYPASSRLS to operate without tenant context.
--    Postgres requires the NEW owner to hold CREATE on the function's schema at ALTER time. We grant
--    it TRANSIENTLY and revoke immediately, so partner_definer's persistent rights stay USAGE+SELECT
--    only (no lasting schema-creation power).
GRANT CREATE ON SCHEMA public TO partner_definer;
ALTER FUNCTION partner_auth_lookup(text)        OWNER TO partner_definer;
ALTER FUNCTION partner_session_lookup(text)     OWNER TO partner_definer;
ALTER FUNCTION partner_reset_token_tenant(text) OWNER TO partner_definer;
REVOKE CREATE ON SCHEMA public FROM partner_definer;

-- 6) Harden the execution search_path (SEC-1). The functions reference unqualified relations. With
--    `search_path = public` alone, PostgreSQL still searches the caller's pg_temp schema FIRST for
--    relation names, so a caller who can CREATE TEMP TABLE partner_users could shadow the real table
--    and — because these run as the BYPASSRLS partner_definer — forge auth / read across tenants.
--    Listing pg_temp EXPLICITLY LAST removes that implicit-first behaviour (verified empirically).
ALTER FUNCTION partner_auth_lookup(text)        SET search_path = public, pg_temp;
ALTER FUNCTION partner_session_lookup(text)     SET search_path = public, pg_temp;
ALTER FUNCTION partner_reset_token_tenant(text) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION partner_auth_lookup(text)        FROM PUBLIC;
REVOKE ALL ON FUNCTION partner_session_lookup(text)     FROM PUBLIC;
REVOKE ALL ON FUNCTION partner_reset_token_tenant(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION partner_auth_lookup(text)        TO partner_runtime;
GRANT EXECUTE ON FUNCTION partner_session_lookup(text)     TO partner_runtime;
GRANT EXECUTE ON FUNCTION partner_reset_token_tenant(text) TO partner_runtime;
