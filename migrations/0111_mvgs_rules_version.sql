-- 0111 — Stamp every certificate with the MVGS ruleset its grade was computed under.
--
-- WHY
-- =============================================================================================
-- MVGS had no rules version. The engine, the centering chart, the floor rule and the grade
-- brackets were all mutable code with nothing recording which revision any given certificate was
-- issued under. That made the promise "approved grades are immutable" unenforceable: a future
-- change to the deduction tables silently reinterprets every historical grade, because the only
-- statement of the rules is the current source file.
--
-- The 0111 column closes that. It is written by the server-authoritative grade path
-- (server/lib/draft-grade-authority.ts -> resolveDraftGradeAuthority) on every draft grade write,
-- from the same MVGS_RULES_VERSION constant the scoring engine itself declares. Approved rows are
-- untouchable by that path: both grade UPDATEs carry `WHERE ... grade_approved_at IS NULL` or
-- preserve-on-omission semantics, so an issued certificate's version cannot be rewritten.
--
-- WHAT THIS MIGRATION DOES
-- =============================================================================================
--   1. Adds `certificates.mvgs_rules_version` (nullable text).
--   2. Backfills every row that already carries a grade to 'v1.3' — the ruleset published at
--      /standard on 24 May 2026, which is the ruleset those grades were in fact issued under.
--
-- NO GRADE IS RECALCULATED OR MODIFIED. This migration writes exactly one new column and reads
-- `grade` only to decide which rows are graded at all. `grade`, the four subgrades, `grade_type`,
-- `label_type` and `grade_approved_at` are not referenced in any SET clause.
--
-- Rows graded from here on are stamped 'v1.4' by the application, which differs from v1.3 in one
-- respect: the floor rule's high-variance threshold is now attainable at the 9 rung, so grade 9.5
-- (Mint+) — published, but never once issued in 714 live certificates — can be awarded. No other
-- rung's behaviour changes.
--
-- REVERSIBILITY
-- =============================================================================================
-- Additive and idempotent. To undo:  ALTER TABLE certificates DROP COLUMN mvgs_rules_version;
-- Dropping it loses only the provenance stamp; no grade depends on the column being present.

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS mvgs_rules_version text;

COMMENT ON COLUMN certificates.mvgs_rules_version IS
  'MVGS ruleset the stored grade was computed under. Immutable once approved; never recalculated.';

-- Backfill: only rows that actually hold a grade, and only where the stamp is still absent.
UPDATE certificates
   SET mvgs_rules_version = 'v1.3'
 WHERE mvgs_rules_version IS NULL
   AND grade IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_certificates_mvgs_rules_version
  ON certificates (mvgs_rules_version)
  WHERE mvgs_rules_version IS NOT NULL;
