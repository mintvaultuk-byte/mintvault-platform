-- 0053_partner_mfa_failure_lockout.sql
-- Partner Network: per-account failure tracking and temporary lockout for the SECOND factor.
--
-- UNAPPLIED AND FORWARD-ONLY. Strictly additive: two nullable/defaulted columns on
-- partner_users. It edits no applied migration, rewrites no row, changes no default on an
-- existing column, and adds no constraint that existing rows could violate.
--
-- Numbering: 0044 and 0046 are applied on staging, 0045 is permanently unused (see
-- docs/migration-ownership-partner-0049.md), and 0047-0052 are taken by other work in flight.
-- 0053 is the next free slot.
--
-- ===========================================================================================
-- WHY NEW COLUMNS RATHER THAN REUSING failed_login_count / locked_until
-- ===========================================================================================
-- The obvious cheap option is to have a failed MFA verification increment the SAME
-- failed_login_count / locked_until pair that the password path already uses (0002). That is
-- wrong here, and the reason is specific rather than stylistic.
--
-- The MFA challenge is only reachable by a caller that has ALREADY passed the password check.
-- server/partner/auth.ts partnerLogin() clears the password counters on every SUCCESSFUL login:
--
--     UPDATE partner_users SET failed_login_count=0, locked_until=NULL, last_login_at=now() ...
--
-- An attacker who holds a phished or stuffed password therefore owns a counter-reset primitive.
-- Had the MFA failures landed in those columns, the attack loop would be:
--
--     log in (password succeeds -> counters zeroed) -> guess 4 codes -> log in again -> repeat
--
-- and the lockout would never arm. The control has to live in columns the attacker cannot reset
-- without completing the very step it is defending. failed_mfa_count is cleared ONLY by a
-- successful second-factor verification (or by an out-of-band password reset, which revokes
-- every session and re-arms the whole login path anyway).
--
-- The second reason is blast radius: an MFA lock must not be indistinguishable from a password
-- lock in the audit trail. Separate columns keep "five wrong passwords" and "five wrong codes"
-- separately attributable, which is what an incident responder actually needs to see.
--
-- The COST of separate columns, stated honestly: an account can now be in two lock states at
-- once, and neither implies the other. That is intentional. A password lock stops session
-- minting; an MFA lock stops an existing mfa-pending session from being upgraded. Both are
-- refusals, neither weakens the other, and a legitimate user clears either by waiting out the
-- same 15-minute interval used by the password path.
--
-- ===========================================================================================
-- GRANTS AND RLS
-- ===========================================================================================
-- Deliberately none needed. 0001 issued TABLE-LEVEL SELECT/INSERT/UPDATE/DELETE on partner_users
-- to partner_runtime, and a table-level grant covers columns added later. partner_users already
-- has ENABLE + FORCE ROW LEVEL SECURITY with the tenant-isolation policy from 0001, so the new
-- columns inherit that isolation with no policy change. Adding column-level grants here would
-- SHRINK the existing table-level grant to a column list and silently break unrelated writes.
--
-- REVERSIBLE: migrations/rollback-0053-partner-mfa-failure-lockout.sql drops both columns. The
-- only data lost on rollback is in-flight failure counts, which are ephemeral by design.

ALTER TABLE partner_users
  ADD COLUMN IF NOT EXISTS failed_mfa_count integer NOT NULL DEFAULT 0;

ALTER TABLE partner_users
  ADD COLUMN IF NOT EXISTS mfa_locked_until timestamptz;

COMMENT ON COLUMN partner_users.failed_mfa_count IS
  'Consecutive failed second-factor verifications. Cleared ONLY by a successful verification or a '
  'password reset - never by a successful password login, because an attacker holding the password '
  'would otherwise be able to reset it at will. See migration 0053.';

COMMENT ON COLUMN partner_users.mfa_locked_until IS
  'When set and in the future, POST /api/partner/auth/mfa refuses to evaluate a code for this user '
  'regardless of source IP. Independent of locked_until, which gates the password step. See 0053.';
