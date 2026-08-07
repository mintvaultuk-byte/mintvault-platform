-- 0050 — let the Trusted Intake Connector read the APPROVED partner trading name.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- migrations/0035_partner_certificate_origin.sql created certificates.origin_partner_trading_name
-- and states, in its own column commentary, that its source is `partner_profiles.trading_name at
-- capture` — "THE value rendered as 'Graded by <X>'". server/labels.ts certificateOrigin() renders
-- it first, ahead of the legal name.
--
-- The only code path that stamps a PARTNER origin is
-- server/partner/connector-import-service.ts createPartnerCertificateForWorkItem(). Until now that
-- function selected `NULL::text AS partner_trading_name` and never referenced partner_profiles at
-- all, so every partner-graded certificate recorded a NULL trading name. Because 0035 installs a
-- SET-ONCE immutability trigger (ENABLE ALWAYS) over the origin_* columns, each such certificate
-- would have been UNFIXABLE IN PLACE — permanent, wrong provenance on a public record.
--
-- Fixing the query is necessary but NOT sufficient. migration 0015 granted SELECT on
-- partner_profiles to `partner_runtime` (the partner-portal role) ONLY. The connector runs on its
-- own dedicated pool as `partner_connector_runtime` (see server/partner/connector-db.ts), which has
-- no privilege on that table at all — so the corrected query would fail with 42501 (permission
-- denied) at runtime while passing under any superuser test fixture. This migration closes that
-- gap, and nothing else.
--
-- WHAT THIS DOES *NOT* DO
-- ---------------------------------------------------------------------------
-- * No table, column, constraint, index, trigger or policy is created, altered or dropped.
-- * No row is inserted, updated or deleted anywhere. There is no backfill: certificates already
--   stamped carry an immutable snapshot by design and this file deliberately does not touch them.
-- * No write privilege is granted. The connector may READ the approved trading name; it can never
--   set it. partner_profiles remains super-admin-write-only via the privileged admin pool.
-- * RLS is NOT weakened. partner_profiles keeps ENABLE + FORCE ROW LEVEL SECURITY and its
--   partner_profiles_tenant_isolation policy from 0015; partner_connector_runtime is NOBYPASSRLS,
--   so this SELECT still returns rows only for the tenant in the transaction-local `app.tenant_id`
--   GUC, and zero rows (fail closed) when that GUC is absent or is another tenant's.
--
-- SCOPE OF THE GRANT
-- ---------------------------------------------------------------------------
-- COLUMN-LEVEL, not table-level: only (tenant_id, trading_name) — the join key and the one value
-- the certificate snapshot needs. partner_profiles also holds company/VAT numbers, contact email
-- and phone, and the internal tier/health note; none of those belong to the connector, and a
-- table-level grant would hand them over for no reason.
--
-- TRANSACTION: intentionally NO BEGIN/COMMIT. scripts/db/migrate.ts wraps each file in one
-- transaction together with its journal row (same rule as 0035/0044/0045).
--
-- IDEMPOTENT: GRANT is naturally idempotent, and the guards below make a re-run a no-op even if
-- the role or table is absent.
--
-- FAIL-CLOSED: the assertion block at the end proves the privilege is actually present and that no
-- write privilege leaked in. If anything is off the migration RAISES and the runner rolls back,
-- rather than leaving the importer to discover the missing privilege mid-import in production.
--
-- ROLLBACK: migrations/rollback-0050-partner-connector-profile-read.sql.

DO $$
BEGIN
  IF to_regclass('public.partner_profiles') IS NULL THEN
    RAISE EXCEPTION '0050 requires partner_profiles (migration 0015), which does not exist in this database.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime') THEN
    RAISE EXCEPTION '0050 requires the partner_connector_runtime role (migration 0008), which does not exist.';
  END IF;

  -- A BYPASSRLS connector role would turn this read into a cross-tenant one. That is not the
  -- deployed shape (0041 already asserts NOLOGIN/NOSUPERUSER/NOBYPASSRLS for this role), and
  -- granting the privilege without re-checking would silently widen the blast radius.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION
      '0050 refuses to grant partner_profiles access to partner_connector_runtime while it is SUPERUSER or BYPASSRLS — RLS tenant isolation would not apply.';
  END IF;
END$$;

GRANT SELECT (tenant_id, trading_name) ON partner_profiles TO partner_connector_runtime;

-- ---------------------------------------------------------------------------
-- Completeness assertion. Fail closed rather than certify a privilege that is not there.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  leaked text;
BEGIN
  IF NOT has_column_privilege('partner_connector_runtime', 'public.partner_profiles', 'trading_name', 'SELECT') THEN
    RAISE EXCEPTION '0050 assertion failed: partner_connector_runtime cannot SELECT partner_profiles.trading_name.';
  END IF;
  IF NOT has_column_privilege('partner_connector_runtime', 'public.partner_profiles', 'tenant_id', 'SELECT') THEN
    RAISE EXCEPTION '0050 assertion failed: partner_connector_runtime cannot SELECT partner_profiles.tenant_id.';
  END IF;

  -- No write privilege may exist on this table for the connector role, at table OR column level.
  -- DELETE is checked at TABLE level only: PostgreSQL has no column-level DELETE privilege, and
  -- passing 'DELETE' to has_column_privilege() raises `unrecognized privilege type`.
  SELECT string_agg(p, ', ' ORDER BY p) INTO leaked
    FROM unnest(ARRAY['INSERT','UPDATE','DELETE']) AS p
   WHERE has_table_privilege('partner_connector_runtime', 'public.partner_profiles', p)
      OR (p <> 'DELETE'
          AND has_column_privilege('partner_connector_runtime', 'public.partner_profiles', 'trading_name', p));
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0050 assertion failed: partner_connector_runtime holds write privilege(s) on partner_profiles: %. The connector must never author a trading name.',
      leaked;
  END IF;

  -- RLS must still be on and forced, or the grant above becomes a cross-tenant read.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.partner_profiles'::regclass
                   AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION '0050 assertion failed: partner_profiles no longer has ENABLE + FORCE ROW LEVEL SECURITY.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'partner_profiles'
                    AND policyname = 'partner_profiles_tenant_isolation') THEN
    RAISE EXCEPTION '0050 assertion failed: partner_profiles_tenant_isolation policy is missing.';
  END IF;

  RAISE NOTICE '0050: partner_connector_runtime granted RLS-scoped SELECT (tenant_id, trading_name) on partner_profiles. No rows modified.';
END$$;
