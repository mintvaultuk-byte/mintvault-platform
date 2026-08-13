-- 0078_partner_connector_flag_read.sql
--
-- The restricted connector runtime resolves the scoped partner_grading_enabled
-- pilot flag inside its import transaction. It needs read access only; the
-- existing FORCE ROW LEVEL SECURITY policy continues to limit rows to the
-- transaction's app.tenant_id plus global defaults. The connector never gains
-- INSERT, UPDATE, DELETE, ownership, or any flag-management capability.

REVOKE ALL ON TABLE partner_feature_flags FROM PUBLIC;
GRANT SELECT ON TABLE partner_feature_flags TO partner_connector_runtime;
