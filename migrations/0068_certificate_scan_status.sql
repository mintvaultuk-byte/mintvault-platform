-- 0068_certificate_scan_status.sql
--
-- Scanner ingestion and recovery both persist certificate-level scan_status.
-- The original additive file was not part of the numbered migration set, which
-- left a freshly migrated estate without the column even though the application
-- had already begun querying it. Make the deployment contract explicit.

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS scan_status TEXT;
