-- Partner Portal — SHARED rate-limit buckets (invariant I19: no process-local authoritative state).
--
-- NUMBER SAFETY. 0078 is the first number above the GLOBAL migration high-water mark discovered
-- across every ref in this repository (`git log --all --diff-filter=A` over migrations/), which is
-- 0077. MintVault has a documented history of number collisions (0019, 0020, 0033, 0044, 0045, 0046,
-- 0047, 0048 and 0053 each have two or three different files), so the number was taken from the
-- whole repository rather than from this worktree alone. The runner independently rejects duplicate
-- numbers before applying anything.
--
-- WHY THIS TABLE EXISTS.
-- server/partner/rate-limit.ts has always shipped a pluggable store whose only implementation was
-- MemoryRateLimitStore — a per-process Map. Its own header calls a shared store an "INFRASTRUCTURE
-- PREREQUISITE for production", and setPartnerRateLimitStore() had NO production caller, so
-- production ran on the in-memory default.
--
-- Production is a MINIMUM two-Machine Fly deployment behind a load balancer, so every published
-- partner limit was silently DOUBLE its stated value, and every rolling deploy reset all buckets to
-- zero — mid-attack, if one was underway. These are the only credential-attack controls on the
-- partner portal: login (10/15min), login-by-IP (30/15min), MFA (20/15min), password-reset (5/15min)
-- and invitation-accept (10/15min).
--
-- WHY THERE IS NO tenant_id AND NO RLS (deliberate, not an oversight).
-- These limiters run PRE-AUTHENTICATION. At the moment a login or password-reset request is rate
-- limited there is no session, no tenant and often no known account — the key is an IP prefix or a
-- submitted email address. A tenant-scoped table could not be written on that path at all.
-- Consequently the table holds NO tenant-owned data: only an opaque bucket key, a counter and an
-- expiry. It is therefore correctly outside the tenant-isolation model, and it is automatically
-- excluded from the RLS coverage sweep in tests/partner-rls-isolation.test.ts, which asserts RLS
-- only for partner_% tables that HAVE a tenant_id column.
--
-- PRIVACY. Bucket keys may embed a submitted email address, so rows are short-lived by construction:
-- every key carries an expiry and expired rows are deleted opportunistically by the application.
-- Nothing here is an audit record and nothing here is business data — truncating this table is
-- always safe and merely resets rate-limit counters.
--
-- ROLLBACK / DOWN-PATH: `DROP TABLE IF EXISTS partner_rate_limit_buckets;` is safe at any time. The
-- application falls back to the in-memory store, restoring the previous (weaker) behaviour rather
-- than failing. Forward-fix is preferred, per project migration policy.
--
-- MIXED-VERSION SAFETY (invariant I17): purely additive. An OLD application version does not know
-- this table exists and is unaffected; a NEW version uses it when present and falls back to the
-- in-memory store when absent, so it is safe to apply BEFORE the deploy (expand → migrate → deploy).

CREATE TABLE IF NOT EXISTS partner_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  hit_count integer NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  reset_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the opportunistic sweep of expired buckets.
CREATE INDEX IF NOT EXISTS idx_partner_rate_limit_buckets_reset_at
  ON partner_rate_limit_buckets (reset_at);

-- The restricted runtime role must be able to count hits and clear expired buckets. DELETE is
-- required for the sweep; there is no tenant data here to protect.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_rate_limit_buckets TO partner_runtime;
  END IF;
END$$;
