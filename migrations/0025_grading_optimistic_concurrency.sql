-- Grading optimistic concurrency
--
-- Additive and idempotent. Existing certificate rows receive version 1, while
-- new rows receive the same default. Application code performs compare-and-set
-- writes using this column; do not use updated_at as the concurrency token.

-- The partner-only disposable schema used by unrelated migration tests does
-- not own certificates. Production MintVault databases do; IF EXISTS keeps
-- this additive migration safe in both independently-versioned schemas.
ALTER TABLE IF EXISTS certificates
  ADD COLUMN IF NOT EXISTS grading_version INTEGER NOT NULL DEFAULT 1;
