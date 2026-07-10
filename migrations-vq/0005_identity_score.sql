-- Phase 2: Character Identity Score + future-game metadata. VQ-only, additive.
ALTER TABLE "vq_artwork_candidates" ADD COLUMN IF NOT EXISTS "identity_score" integer;
--> statement-breakpoint
ALTER TABLE "vq_artwork_candidates" ADD COLUMN IF NOT EXISTS "identity_breakdown" jsonb;
--> statement-breakpoint
ALTER TABLE "vq_characters" ADD COLUMN IF NOT EXISTS "game_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
