-- rollback-0050-partner-runtime-flag-control-least-privilege.sql
--
-- Restores the pre-0050 state exactly: the blanket DML grants 0001_partner_foundation.sql:269 gave
-- partner_runtime on the two kill-switch tables, and the single combined feature-flag policy from
-- 0001:239-242.
--
-- ⚠️ APPLYING THIS RE-OPENS THE DEFECT 0050 CLOSED. After this file runs, partner_runtime can again
-- DELETE the platform-global feature-flag rows (including partner_emergency_stop and
-- partner_portal_enabled) and can DELETE its own HQ-imposed emergency freeze. Use it only to
-- unblock an unrelated failure, and re-apply 0050 immediately afterwards.
--
-- Not destructive to data: no row is read, written or removed — this file only restores privileges
-- and policy definitions.

DROP POLICY IF EXISTS partner_feature_flags_global_read  ON partner_feature_flags;
DROP POLICY IF EXISTS partner_feature_flags_tenant_write ON partner_feature_flags;

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
    RAISE EXCEPTION 'rollback-0050: expected exactly 1 policy on partner_feature_flags, found %', npolicy;
  END IF;
  IF NOT has_table_privilege('partner_runtime', 'public.partner_feature_flags', 'DELETE') THEN
    RAISE EXCEPTION 'rollback-0050: partner_runtime DELETE grant was not restored';
  END IF;
END$$;
