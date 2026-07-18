-- Phase 1 closeout — MFA enrolment support (additive). Applied via the Phase 0.5 runner; validated
-- on disposable Postgres only. Touches no existing MintVault table.

-- Concurrency guard: at most ONE active TOTP method per user, so two concurrent confirmations cannot
-- create duplicate active methods.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_mfa_one_active
  ON partner_mfa_methods (user_id, method)
  WHERE status = 'ACTIVE';

-- Supporting index for enrolment/confirm lookups by (user, method, status).
CREATE INDEX IF NOT EXISTS idx_partner_mfa_user_method_status
  ON partner_mfa_methods (user_id, method, status);
