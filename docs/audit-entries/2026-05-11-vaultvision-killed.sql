-- VaultVision heatmap kill — feature decommissioned 2026-05-11.
--
-- Run against PROD only AFTER the kill PR merges. Single INSERT into
-- audit_log using the locked column schema. No data dependency, no
-- schema change.
--
-- Verify before running:
--   1. PR "kill: VaultVision heatmap (single V850 capture only)" is merged to main
--   2. Connected to prod Neon (host should contain ep-wispy-morning-ab6f4o08)
--   3. SELECT 1 FROM audit_log LIMIT 1; -- sanity, table exists
--
-- After running, confirm:
--   SELECT created_at, action, entity_id, details
--   FROM audit_log
--   WHERE entity_type = 'product_feature' AND entity_id = 'vaultvision_heatmap'
--   ORDER BY created_at DESC LIMIT 1;

INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
VALUES (
  'product_feature',
  'vaultvision_heatmap',
  'feature_killed',
  'cornelius',
  '{"reason":"storage cost + complexity, single V850 capture sufficient","decision_date":"2026-05-11","decision_owner":"cornelius","scope":"heatmap + raking-light + 4-scan capture never shipping"}'::jsonb,
  NOW()
);
