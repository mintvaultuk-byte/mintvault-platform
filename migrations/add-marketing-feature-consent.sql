-- Add marketing-feature consent columns to submissions.
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.
-- Additive only: no drops, no destructive changes.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-marketing-feature-consent.sql
--
-- Or via drizzle-kit (uses shared/schema.ts as source of truth):
--   npm run db:push

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS marketing_feature_consent boolean NOT NULL DEFAULT false;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS marketing_feature_consent_at timestamptz;
