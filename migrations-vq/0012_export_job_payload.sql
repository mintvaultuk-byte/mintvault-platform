-- Phase 10A (D3): additive payload columns for durable export processing.
-- VQ-only, additive, idempotent. Apply to the ISOLATED LOCAL test DB only during
-- Phase 10A (127.0.0.1:55432 / mintvault_vq_phase10_local). NOT staging/prod.
-- No shared-table reference; no destructive statement.

ALTER TABLE "vq_export_jobs" ADD COLUMN IF NOT EXISTS "ids" jsonb;
--> statement-breakpoint
ALTER TABLE "vq_export_jobs" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vq_export_jobs_attempt_nonneg') THEN
    ALTER TABLE "vq_export_jobs" ADD CONSTRAINT "vq_export_jobs_attempt_nonneg" CHECK ("attempt_count" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vq_export_jobs_ids_bounded') THEN
    -- bounded validation: ids is a JSONB array of at most 1000 identifiers (MAX_BATCH is 200)
    ALTER TABLE "vq_export_jobs" ADD CONSTRAINT "vq_export_jobs_ids_bounded"
      CHECK ("ids" IS NULL OR (jsonb_typeof("ids") = 'array' AND jsonb_array_length("ids") <= 1000));
  END IF;
END $$;

-- ROLLBACK (exact):
--   ALTER TABLE "vq_export_jobs" DROP CONSTRAINT IF EXISTS "vq_export_jobs_ids_bounded";
--   ALTER TABLE "vq_export_jobs" DROP CONSTRAINT IF EXISTS "vq_export_jobs_attempt_nonneg";
--   ALTER TABLE "vq_export_jobs" DROP COLUMN IF EXISTS "attempt_count";
--   ALTER TABLE "vq_export_jobs" DROP COLUMN IF EXISTS "ids";
