-- Weekly-reel pipeline admin extensions. Bundled migration — all additive,
-- all idempotent. Safe to re-run.
--
-- Adds:
--   • pipeline_settings — generic key/value JSON store for all reel-admin
--     toggles (schedule, selection rules, video style, output, notifications).
--     One row per setting key. Defaults live in code (server/lib/pipeline-
--     settings.ts); the table is opt-in overrides only.
--   • certificates.marketing_pinned       — admin-pin: always include in reel
--   • certificates.marketing_blacklisted  — admin-blacklist: exclude permanently
--   • reel_analytics — per-run record of card/success/fail counts + model/
--     clip-length + estimated cost. Drives the analytics dashboard.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-pipeline-settings.sql

CREATE TABLE IF NOT EXISTS pipeline_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text
);

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS marketing_pinned boolean NOT NULL DEFAULT false;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS marketing_blacklisted boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS reel_analytics (
  id serial PRIMARY KEY,
  reel_date text NOT NULL,
  card_count integer,
  success_count integer,
  fail_count integer,
  estimated_cost_usd numeric(10,4),
  model text,
  clip_length_seconds integer,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reel_analytics_created_at ON reel_analytics (created_at DESC);
