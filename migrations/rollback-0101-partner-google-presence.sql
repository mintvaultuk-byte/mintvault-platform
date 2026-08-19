-- Disposable/staging rollback for unapplied 0101. Production use requires a
-- separate data-retention review because credentials/binding history may exist.
DROP TABLE IF EXISTS partner_google_profile_cache;
DROP TABLE IF EXISTS partner_google_location_candidates;
DROP TABLE IF EXISTS partner_google_credentials;
DROP TABLE IF EXISTS partner_google_oauth_states;
DROP TABLE IF EXISTS partner_google_connections;
ALTER TABLE partner_locations DROP CONSTRAINT IF EXISTS uq_partner_locations_tenant_id;
ALTER TABLE partner_sessions DROP CONSTRAINT IF EXISTS uq_partner_sessions_tenant_user_id;
ALTER TABLE partner_users DROP CONSTRAINT IF EXISTS uq_partner_users_tenant_id;
