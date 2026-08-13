-- Admin PASSWORD-step lockout — durable, shared across Fly Machines (invariant I19).
--
-- NUMBER SAFETY: 0079 follows 0078 in this pass; both are above the global high-water mark of 0077
-- discovered across every ref in the repository. The runner independently rejects duplicate numbers.
--
-- WHY.
-- Admin authentication is two steps: password, then PIN. The PIN step already has a DURABLE,
-- DB-backed lockout (`pin_failed_count` / `pin_locked_until`, see server/pin.ts). The PASSWORD step
-- had NO persistent counter at all — its only controls were two per-process structures:
--   * `loginAttempts`, a module-level Map in server/auth.ts, and
--   * `adminCredentialRateLimit`, an express-rate-limit instance with no `store:` option, so the
--     library's default in-process MemoryStore.
--
-- Production runs a MINIMUM of two Fly Machines behind a load balancer, so the advertised budget of
-- 5 attempts per 10 minutes per IP was really 5 PER MACHINE — double overall — and every rolling
-- deploy reset both structures to zero, including mid-attack. That is the weakest control in the
-- system guarding the single highest-privilege credential in it.
--
-- These columns mirror the PIN pair exactly so server/pin.ts's proven check/register/reset shape can
-- be reused rather than a second, subtly different lockout being invented.
--
-- MIXED-VERSION SAFETY (invariant I17): purely additive with defaults, so an OLD application version
-- is unaffected and a NEW one degrades to the previous in-memory behaviour if the columns are absent.
-- Safe to apply before OR after the deploy (expand → migrate → deploy).
--
-- ROLLBACK / DOWN-PATH:
--   ALTER TABLE users DROP COLUMN IF EXISTS password_failed_count;
--   ALTER TABLE users DROP COLUMN IF EXISTS password_locked_until;
-- Both are safe: they hold only transient security counters, never business data.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS password_locked_until timestamptz;

-- A negative counter would be a bug in the increment path, not a state to tolerate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_password_failed_count_non_negative'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT chk_users_password_failed_count_non_negative
      CHECK (password_failed_count >= 0);
  END IF;
END$$;
