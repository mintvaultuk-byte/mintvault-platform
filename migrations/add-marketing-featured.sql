-- Add admin-controlled marketing-featured flag to certificates.
--   marketing_featured       boolean NOT NULL DEFAULT false
--   marketing_featured_at    timestamptz
--
-- Distinct from submissions.marketing_feature_consent (user opt-in, legal).
-- This column is the ADMIN POOL flag — controls which certs the weekly
-- reel job picks from. The two columns are intentionally independent
-- (per the spec: admin flag REPLACES the consent join in the reel data
-- query). The customer account-settings consent toggle still writes
-- submissions.marketing_feature_consent for the legal record.
--
-- Idempotent (IF NOT EXISTS). Additive only — no drops.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-marketing-featured.sql

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS marketing_featured boolean NOT NULL DEFAULT false;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS marketing_featured_at timestamptz;
