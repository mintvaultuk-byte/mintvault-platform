-- Canonical display PNG → flattened JPEG q85 mozjpeg progressive — 2026-05-11.
-- Run against PROD after the merge of PR "feat: image pipeline pre-launch
-- optimisations" (commit 2 of 3).
--
-- Before: front.png / back.png canonical display keys, ~2.1MB/side (4.2MB
-- per cert page load). PNG required only to preserve rounded-corner alpha.
-- After: front.jpg / back.jpg, ~550KB/side (~1.1MB per cert page load).
-- Rounded corners baked into white via flatten (matches white-RGB-under-alpha
-- already set by maskRoundedCorners step 2). Mat-padded outer ring preserved.
-- Visual unchanged on /cert/:id pages (white page background).
--
-- Cutover: NEW certs from this PR onward write .jpg only. Historical certs
-- (MV1-MV100 at time of merge) keep their .png keys — front_image_path /
-- back_image_path are extension-agnostic strings; consumers derive media-
-- type from the key. NO backfill, NO hard deletes of historical PNGs.

INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
VALUES
  ('image_format', 'scan-ingest:display_jpeg', 'pipeline_change', 'cornelius',
   '{"file":"server/scan-ingest-service.ts","change":"display_png_to_jpeg","before":{"format":"png","alpha":true,"keys":["grading/{id}/{side}_cropped.png","images/{cert}/{side}.png"],"avg_size_kb":2100},"after":{"format":"jpeg","quality":85,"progressive":true,"mozjpeg":true,"flatten_bg":"#FFFFFF","keys":["grading/{id}/{side}_cropped.jpg","images/{cert}/{side}.jpg"],"expected_size_kb":550},"cutover":"new_certs_only,historical_png_keys_preserved","reason":"audit_2026-05-11_red_tier_fix_1","commit":"COMMIT_SHA_PLACEHOLDER_2"}'::jsonb,
   NOW()),
  ('image_format', 'routes.ts:upload-images:display_jpeg', 'pipeline_change', 'cornelius',
   '{"file":"server/routes.ts","line":6907,"change":"display_png_to_jpeg","before":{"format":"png","keys":["grading/{cert}/{angle}_cropped.png","images/{cert}/{side}.png"]},"after":{"format":"jpeg","quality":85,"progressive":true,"mozjpeg":true,"flatten_bg":"#FFFFFF","keys":["grading/{cert}/{angle}_cropped.jpg","images/{cert}/{side}.jpg"]},"reason":"audit_2026-05-11_red_tier_fix_1","commit":"COMMIT_SHA_PLACEHOLDER_2"}'::jsonb,
   NOW());
