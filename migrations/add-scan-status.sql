-- Async scan-ingest status. Nullable text column; null = "ready"
-- (no special state). "processing" = background job in flight; "failed"
-- = background job hit an error. Additive, idempotent.

ALTER TABLE certificates ADD COLUMN IF NOT EXISTS scan_status TEXT;
