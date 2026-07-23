-- MANUAL, OWNER-APPROVED ROLLBACK ONLY — never picked up by the migration runner.
--
-- This removes only the optimistic-concurrency token; it does not alter grading
-- evidence or certificate data. Rehearse on a disposable database first. Once
-- removed, deploy the previous application version in the same maintenance
-- window because current code requires certificates.grading_version.

ALTER TABLE certificates DROP COLUMN IF EXISTS grading_version;
