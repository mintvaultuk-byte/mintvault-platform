-- Partner Portal — SHARED rate-limit buckets (invariant I19: no process-local authoritative state).
--
-- NUMBER SAFETY — RENUMBERED 0078 -> 0089 (owner-authorised, 2026-08-14).
--
-- This shipped as 0078, chosen as the first number above the global high-water mark of 0077
-- discovered across every ref at the time. Concurrent work on origin/main subsequently landed a
-- DIFFERENT migration at the same number — `0078_partner_connector_flag_read.sql` — so the release
-- lineage and main each held a distinct 0078. MintVault has already been bitten by exactly this at
-- 0046, where two different files occupied one slot and the journal (keyed on filename) could not
-- tell: the runner's MIGRATION IDENTITY GUARD exists because of it.
--
-- WHICH ONE MOVED, AND WHY THIS ONE. The rule is that an APPLIED migration never changes identity;
-- only an unapplied one may move. A read-only journal inspection of BOTH environments confirmed
-- neither 0078 was applied anywhere:
--
--     production (ep-wispy-morning):  no 0078 rows; highest applied 0076
--     staging    (ep-purple-voice):   no 0078 rows; highest applied 0073
--
-- With both free to move, main's lineage is canonical and keeps 0078; this one moved. 0089 was
-- verified free across EVERY ref in the repository, not merely this worktree — a sibling branch
-- (codex/scanner-sol-implementation-20260814) already carries this lineage's 0079-0087, and the
-- global maximum was 0088.
--
-- ORDER SAFETY. This migration creates one self-contained table, its index and its grant. Nothing in
-- 0079-0088 references `partner_rate_limit_buckets`, so moving it after them changes no behaviour.
-- Its semantics are untouched by the renumber.
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
