-- TCGdex card-lookup infrastructure. All additive, all idempotent. Safe to re-run.
--
-- Adds:
--   * certificates.external_card_id  — canonical TCGdex card ID per cert
--   * pending_set_lookups            — queue for sets that need manual review
--   * Index on pending_set_lookups(status)
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-tcgdex-lookup.sql

-- 1. external_card_id on certificates
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS external_card_id TEXT;

-- 2. pending_set_lookups queue
CREATE TABLE IF NOT EXISTS pending_set_lookups (
  id SERIAL PRIMARY KEY,
  printed_code TEXT NOT NULL,
  card_number TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  cert_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  tcgdex_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_set_lookups_status
  ON pending_set_lookups (status);
