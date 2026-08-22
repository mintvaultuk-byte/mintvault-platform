-- 0113 — Forward-only convergence: deliver certificates.mvgs_rules_version on any lineage
--        whose 0111 slot is occupied by a different migration.
--
-- WHY THIS FILE EXISTS
-- =============================================================================================
-- Two lineages both minted a 0111.
--
--   production : 0111_mvgs_rules_version.sql       (applied on v1120 / 320c731a)
--   staging    : 0111_partner_supply_commerce.sql  (applied on the first-shop staging line)
--
-- The supplies migration is renumbered to 0112 in this release, which fixes the collision for
-- every database that has not yet applied it. It does NOT fix the database that already applied
-- it under the old name: staging's journal immutably holds '0111_partner_supply_commerce.sql'
-- at 0111, so the release's 0111_mvgs_rules_version.sql can never legitimately apply there.
--
-- The migration identity guard in scripts/db/migrate.ts fails closed on exactly that, and its
-- own remedy is explicit: do NOT renumber or delete the applied row — applied history is
-- immutable — converge with a NEW migration at the next globally free number and declare the
-- collision in migrations/lineage-exclusions.json. This is that convergence migration.
--
-- WHAT IT DOES
-- =============================================================================================
-- Exactly what 0111_mvgs_rules_version.sql does, and nothing more. That file is already fully
-- idempotent (ADD COLUMN IF NOT EXISTS, a NULL-guarded backfill, CREATE INDEX IF NOT EXISTS),
-- so replaying its body is safe on every host:
--
--   * staging     — 0111_mvgs is EXCLUDED by declaration, so this file is what actually creates
--                   the column and backfills it. Without it, staging would run the new server
--                   against a table with no mvgs_rules_version column and every grade save
--                   would 500.
--   * production  — 0111_mvgs is already applied, the exclusion does not match (its occupant at
--                   0111 is 0111_mvgs_rules_version.sql itself), and this file is a verified
--                   no-op: the column exists, no row has a NULL version with a grade, the index
--                   is present.
--
-- It is deliberately NON-DESTRUCTIVE — it drops nothing and replaces no constraint — so it plans
-- clean without --allow-destructive on either host.
--
-- APPROVED GRADES ARE NOT TOUCHED. The backfill only writes where mvgs_rules_version IS NULL,
-- so a version already stamped on an issued certificate is never rewritten. This file states no
-- new grading rule and changes no grade value; it only records which ruleset a grade was issued
-- under, which is the same claim 0111 makes.

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS mvgs_rules_version text;

COMMENT ON COLUMN certificates.mvgs_rules_version IS
  'MVGS ruleset the stored grade was computed under. Immutable once approved; never recalculated.';

UPDATE certificates
   SET mvgs_rules_version = 'v1.3'
 WHERE mvgs_rules_version IS NULL
   AND grade IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_certificates_mvgs_rules_version
  ON certificates (mvgs_rules_version)
  WHERE mvgs_rules_version IS NOT NULL;
