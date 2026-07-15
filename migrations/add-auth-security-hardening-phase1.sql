-- MintVault Authentication Security Hardening Phase 1.
-- Additive, idempotent, safe to re-run.
--
-- Adds DB-backed admin passphrase support, shared credential-version session
-- invalidation, and staff/admin failed-login diagnostics.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-auth-security-hardening-phase1.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS admin_passphrase_hash text;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credential_version integer NOT NULL DEFAULT 1;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_failed_login_at timestamp;
