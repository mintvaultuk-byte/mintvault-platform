-- Disposable/staging rollback for unapplied 0103. Production use requires a
-- separate data-retention review because credentials/binding history may exist.
DROP TABLE IF EXISTS partner_google_profile_cache;
DROP TABLE IF EXISTS partner_google_location_candidates;
DROP TABLE IF EXISTS partner_google_credentials;
DROP TABLE IF EXISTS partner_google_oauth_states;
DROP TABLE IF EXISTS partner_google_connections;
-- location/user composite constraints belong to 0102 public presence and are
-- intentionally retained. Only the Google-only session constraint is removed.
ALTER TABLE partner_sessions DROP CONSTRAINT IF EXISTS uq_partner_sessions_tenant_user_id;
