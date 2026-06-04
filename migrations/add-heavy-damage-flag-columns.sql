-- Heavy-damage flag — manual grade override + flag dismissal persistence.
--
-- Adds two columns to `certificates`:
--   grade_manual_override          boolean NOT NULL DEFAULT false
--   heavy_damage_acknowledged_at   timestamptz NULL
--
-- Engine logic in shared/mvgs-scoring.ts (HEAVY_DAMAGE_THRESHOLD,
-- getHeavyDamageFlags) detects when a category's raw pre-clamp deduction
-- blows past -40 AND the engine still computes overall >= 5. When that
-- happens, the grading panel HARD-GATES the Approve button until the
-- grader either:
--   (a) flips on the override toggle and sets a manual grade — sets
--       grade_manual_override=true and stores the grader's grade in the
--       existing `grade` column. computed grade stays in
--       grade_strength_score for reference display.
--   (b) dismisses the flag ("Reviewed — grade stands") — sets
--       heavy_damage_acknowledged_at to NOW(). The engine grade stays;
--       the dismissal is recorded so the flag doesn't re-block on reload.
--
-- Both actions write an audit_log row (action='manual_grade_override' or
-- 'heavy_damage_acknowledged') carrying the computed grade, the grader's
-- grade (where applicable), and the raw category deductions that justified
-- the decision.
--
-- All columns nullable / default-false so existing rows continue to score
-- and render identically (no override, no acknowledgement = engine grade
-- stands, flag re-fires if the cert is re-opened).
--
-- Idempotent — ADD COLUMN IF NOT EXISTS. Safe to re-run.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-heavy-damage-flag-columns.sql

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS grade_manual_override boolean NOT NULL DEFAULT false;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS heavy_damage_acknowledged_at timestamptz;
