-- Split single dark_border flag into per-side flags. Additive, idempotent.
-- Backfills both new flags from the legacy dark_border column so existing
-- approved certs continue to score identically if re-evaluated.
--
-- Legacy dark_border column is preserved and now mirrors (front OR back)
-- via the application layer on save.

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS dark_border_front BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dark_border_back  BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any row with the legacy flag set gets BOTH new flags true.
-- This preserves the old semantic (multiplier applied to all edges).
-- Idempotent: only updates rows where both new flags are still false but
-- legacy is true, so re-running the migration is safe.
UPDATE certificates
SET dark_border_front = true,
    dark_border_back  = true
WHERE dark_border = true
  AND dark_border_front = false
  AND dark_border_back  = false;
