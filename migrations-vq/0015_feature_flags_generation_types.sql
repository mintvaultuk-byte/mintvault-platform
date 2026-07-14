-- Vault Quest spend-guard hardening (Phase 2, items B + E) — widen the
-- vq_feature_flags CHECK constraint to allow per-generation-type toggles and the
-- automatic-paid-retry toggle. ADDITIVE, idempotent, reversible. NOT applied by
-- this branch — apply to staging/prod directly (never drizzle-kit push).
--
-- Existing rows ('generation','exports','writes') are untouched. New feature keys:
--   gen_master_portrait, gen_action_pose, gen_face_closeup, gen_turnaround_sheet,
--   gen_colour_sheet, gen_card_artwork, gen_replacement, auto_paid_retry
-- Same "row absent = default-on" contract for the gen_* keys as the existing three
-- (see server/vault-quest/lib/vq-feature-state.ts). auto_paid_retry is the one
-- exception: its OWN application-level default is OFF when absent — enforced in
-- code (isAutomaticPaidRetryEnabled), not by this constraint or a DB default.
--
-- Rollback: re-run the OLD CHECK (only safe if no row currently uses a new key —
-- see the DELETE guard commented below, run manually first if needed):
--   ALTER TABLE vq_feature_flags DROP CONSTRAINT vq_feature_flags_feature_check;
--   ALTER TABLE vq_feature_flags ADD CONSTRAINT vq_feature_flags_feature_check
--     CHECK (feature IN ('generation','exports','writes'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vq_feature_flags_feature_check'
  ) THEN
    ALTER TABLE "vq_feature_flags" DROP CONSTRAINT "vq_feature_flags_feature_check";
  END IF;
END $$;

ALTER TABLE "vq_feature_flags" ADD CONSTRAINT "vq_feature_flags_feature_check"
  CHECK (feature IN (
    'generation','exports','writes',
    'gen_master_portrait','gen_action_pose','gen_face_closeup',
    'gen_turnaround_sheet','gen_colour_sheet','gen_card_artwork','gen_replacement',
    'auto_paid_retry'
  ));
