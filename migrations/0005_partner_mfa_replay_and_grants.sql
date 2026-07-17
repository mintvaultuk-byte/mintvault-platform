-- Phase 1 closeout review-fixes (additive). Applied via the Phase 0.5 runner; validated on
-- disposable Postgres only. Touches no existing MintVault table.

-- F3: TOTP replay protection — track the last-accepted counter per method so a code cannot be
-- replayed inside its validity window.
ALTER TABLE partner_mfa_methods ADD COLUMN IF NOT EXISTS last_totp_counter bigint;

-- CONCERN-1 (defence-in-depth): the tenant runtime must not WRITE the assignment table — location
-- assignment is a super-admin control (via the privileged control shell), never a partner self-service
-- path. Keep SELECT (needed for the per-request assignment re-check); revoke write.
REVOKE INSERT, UPDATE, DELETE ON partner_user_locations FROM partner_runtime;
