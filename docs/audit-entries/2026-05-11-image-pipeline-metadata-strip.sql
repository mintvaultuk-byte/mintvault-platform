-- Path-1 raw-upload metadata strip — 2026-05-11.
-- Run against PROD after the merge of PR "feat: image pipeline pre-launch
-- optimisations" (commit 3 of 3).
--
-- Before: admin upload-images path (routes.ts processAngle) uploaded the
-- raw multer buffer directly to R2 with ContentType forced to image/jpeg.
-- Two issues:
--   1. EXIF / ICC / embedded thumbnail metadata passed through unmodified
--      (sharp re-encode strips by default, but a raw passthrough does not).
--   2. ContentType was forced to image/jpeg regardless of actual input
--      format — multer accepted PNG/TIFF/WebP/etc and they got stored as
--      "JPEG" bytes that browsers would mis-render.
-- After: re-encode through sharp.jpeg({quality:85,mozjpeg:true,progressive:
-- true}) before upload. Metadata stripped, format normalised to actual JPEG.

INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
VALUES
  ('image_format', 'routes.ts:upload-images:original_reencode', 'pipeline_change', 'cornelius',
   '{"file":"server/routes.ts","line":6883,"change":"raw_passthrough_to_sharp_reencode","before":{"upload":"raw_multer_buffer","contentType":"image/jpeg (forced)","metadata":"passthrough_exif_icc_thumbnail","encoding":"whatever_browser_sent"},"after":{"upload":"sharp_jpeg_reencode","quality":85,"progressive":true,"mozjpeg":true,"metadata":"stripped_via_sharp_default","encoding":"jpeg_always"},"reason":"audit_2026-05-11_red_tier_fix_3","commit":"COMMIT_SHA_PLACEHOLDER_3"}'::jsonb,
   NOW());
