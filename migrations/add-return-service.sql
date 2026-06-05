-- Add return_service text column to submissions.
--
-- Pairs with the existing return_carrier free-text column to capture the
-- carrier's SERVICE level (e.g. royal_mail + tracked_24, dpd + dpd_next_day).
-- Service keys are owned by shared/carriers.ts; this column stores the raw
-- key so the source of truth stays in code, not the DB.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS), additive only — existing rows
-- read as NULL and the Mark-Shipped flow stays backward-compatible.
--
-- STAGING ONLY for this pass (ep-purple-voice-abfez796-pooler).
-- Usage:
--   psql "$STAGING_DATABASE_URL" -f migrations/add-return-service.sql

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS return_service TEXT;
