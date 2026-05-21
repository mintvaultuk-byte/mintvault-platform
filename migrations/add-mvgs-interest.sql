-- MVGS compliance interest list — capture from /mvgs/join.
--
-- Public-facing form (no auth) accepts a grading company name + contact
-- email + a free-text message. Server endpoint is rate-limited per IP
-- (3 / hour).
--
-- Additive only, idempotent.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-mvgs-interest.sql

CREATE TABLE IF NOT EXISTS mvgs_interest (
  id          serial PRIMARY KEY,
  company     text NOT NULL,
  email       text NOT NULL,
  message     text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mvgs_interest_created_at ON mvgs_interest (created_at DESC);
