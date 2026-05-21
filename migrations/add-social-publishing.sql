-- Weekly-reel social-publishing extensions. Bundled migration — additive,
-- idempotent. Safe to re-run.
--
-- Adds:
--   • reel_analytics — Instagram + Facebook IDs and insights numbers
--   • reel_card_approvals — per-card approval rows when require_card_approval
--     is enabled on the pipeline.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-social-publishing.sql

ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS instagram_post_id text;
ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS facebook_post_id text;
ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS instagram_likes integer;
ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS instagram_views integer;
ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS instagram_reach integer;
ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS instagram_comments integer;
ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS tiktok_post_id text;
ALTER TABLE reel_analytics
  ADD COLUMN IF NOT EXISTS thumbnail_r2_key text;

CREATE TABLE IF NOT EXISTS reel_card_approvals (
  id serial PRIMARY KEY,
  reel_date text NOT NULL,
  cert_number text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reel_card_approvals_date_cert
  ON reel_card_approvals (reel_date, cert_number);
