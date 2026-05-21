-- MVGS (MintVault Grading Standard) — additive columns on certificates.
--
-- Adds:
--   • dark_border          boolean default false  — admin-set flag; affects
--                                                   edge defect weighting in
--                                                   the MVGS scoring engine.
--   • eye_appeal_modifier  integer default 0      — admin ±2 modifier applied
--                                                   last in MVGS score calc.
--
-- Idempotent (IF NOT EXISTS). Additive only — no drops.
--
-- Note: grade_strength_score (integer 0-100, already present) is repurposed
-- as the MVGS score storage column; no schema change needed.
-- Note: verified_defects (jsonb, already present) is repurposed as the
-- MVGS-classified defect array; no schema change needed (existing rows
-- written by the auto-promote-from-ai-defects path remain valid because
-- new MVGS fields are typed as optional in shared/schema.ts).
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-mvgs.sql

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS dark_border boolean NOT NULL DEFAULT false;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS eye_appeal_modifier integer NOT NULL DEFAULT 0;

-- Sanity guardrail — keep eye_appeal_modifier within the documented ±2
-- range. Drop + re-add the constraint on each run so the check is
-- idempotent without depending on a specific PostgreSQL version's
-- "ADD CONSTRAINT IF NOT EXISTS" support.
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_eye_appeal_modifier_range;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_eye_appeal_modifier_range
  CHECK (eye_appeal_modifier BETWEEN -2 AND 2);
