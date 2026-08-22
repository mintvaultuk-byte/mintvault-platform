-- ROLLBACK for 0109 — remove the explicit onboarding test-card marker.
--
-- Safe while no shipped code depends on the column. It removes a CLASSIFICATION, not any card, MV
-- number, credit, evidence or grade: every Card Job survives untouched, and the only thing lost is
-- the record of which one was the shop's onboarding test. Onboarding readiness then reports
-- UNKNOWN — which fails closed, and is the correct answer once the authority is gone.
--
-- Forward-fix is preferred over running this once a shop has completed a test card, per project
-- policy on destructive rollbacks against real data.

DROP TRIGGER IF EXISTS trg_partner_card_jobs_immutable_purpose ON partner_card_jobs;
DROP FUNCTION IF EXISTS partner_card_jobs_immutable_purpose();
DROP INDEX IF EXISTS uq_partner_card_jobs_open_onboarding_test;
DROP INDEX IF EXISTS idx_partner_card_jobs_onboarding_test;
ALTER TABLE partner_card_jobs DROP CONSTRAINT IF EXISTS chk_partner_card_jobs_purpose;
ALTER TABLE partner_card_jobs DROP COLUMN IF EXISTS purpose;
ALTER TABLE partner_profiles DROP COLUMN IF EXISTS onboarding_test_card_armed_at;
ALTER TABLE partner_profiles DROP COLUMN IF EXISTS onboarding_test_card_armed_by;
