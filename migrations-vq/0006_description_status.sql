-- Description approval workflow (text before pixels). VQ-only, additive.
ALTER TABLE "vq_characters" ADD COLUMN IF NOT EXISTS "description_status" text DEFAULT 'draft' NOT NULL;
