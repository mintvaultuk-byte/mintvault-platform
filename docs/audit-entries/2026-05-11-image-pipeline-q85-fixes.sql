-- Image pipeline q85/mozjpeg/progressive consistency fixes — 2026-05-11.
-- Run against PROD after the merge of PR "feat: image pipeline pre-launch
-- optimisations" (3 commits, single PR).
--
-- Three encode sites were running at q90/q95 with no mozjpeg, no progressive.
-- Standardised on q85 mozjpeg progressive matching every other JPEG output
-- in the pipeline. Estimated 10-15% size reduction on intermediate buffers
-- with no visible quality difference at q85 (well above the diminishing-
-- returns threshold).

INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
VALUES
  ('image_format', 'image-processing.ts:reCentreBitmap', 'pipeline_change', 'cornelius',
   '{"file":"server/image-processing.ts","line":814,"before":{"quality":95,"progressive":false,"mozjpeg":false},"after":{"quality":85,"progressive":true,"mozjpeg":true},"reason":"audit_2026-05-11_red_tier_fix_2","commit":"COMMIT_SHA_PLACEHOLDER_1"}'::jsonb,
   NOW()),
  ('image_format', 'ai-grading-service.ts:centredUnpadded', 'pipeline_change', 'cornelius',
   '{"file":"server/ai-grading-service.ts","line":229,"before":{"quality":95,"progressive":false,"mozjpeg":false},"after":{"quality":85,"progressive":true,"mozjpeg":true},"reason":"audit_2026-05-11_red_tier_fix_2","commit":"COMMIT_SHA_PLACEHOLDER_1"}'::jsonb,
   NOW()),
  ('image_format', 'scan-ingest-service.ts:resizeBuf', 'pipeline_change', 'cornelius',
   '{"file":"server/scan-ingest-service.ts","line":66,"before":{"quality":90,"progressive":false,"mozjpeg":false},"after":{"quality":85,"progressive":true,"mozjpeg":true},"reason":"audit_2026-05-11_red_tier_fix_2","commit":"COMMIT_SHA_PLACEHOLDER_1"}'::jsonb,
   NOW()),
  ('image_format', 'routes.ts:upload-images-mirror:resize', 'pipeline_change', 'cornelius',
   '{"file":"server/routes.ts","line":10076,"before":{"quality":90,"progressive":false,"mozjpeg":false},"after":{"quality":85,"progressive":true,"mozjpeg":true},"reason":"mirror_site_of_scan-ingest_resizeBuf_per_inline_comment","commit":"COMMIT_SHA_PLACEHOLDER_1"}'::jsonb,
   NOW());
