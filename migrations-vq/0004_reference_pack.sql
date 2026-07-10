-- Reference Pack: per-type approved reference artwork on the Character Bible.
-- VQ-only. Additive (ADD COLUMN IF NOT EXISTS) — no drops, no non-vq_ tables.
ALTER TABLE "vq_characters" ADD COLUMN IF NOT EXISTS "reference_pack" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "vq_artwork_candidates" ADD COLUMN IF NOT EXISTS "reference_type" text DEFAULT 'master_portrait' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_candidates_reftype_idx" ON "vq_artwork_candidates" USING btree ("reference_type");
--> statement-breakpoint
-- Backfill: characters that already have an approved master image (pre-pack era,
-- e.g. Flammi's bootstrap) get it recorded as their master_portrait pack entry.
UPDATE "vq_characters"
SET "reference_pack" = jsonb_build_object('master_portrait', jsonb_build_object('r2Key', "approved_artwork_r2_key"))
WHERE "approved_artwork_r2_key" IS NOT NULL
  AND ("reference_pack" IS NULL OR "reference_pack" = '{}'::jsonb);
