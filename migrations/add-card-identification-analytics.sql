-- ============================================================================
-- AI Card Identification — correction analytics (2026-07-16)
--
-- ONE new standalone table. Non-PII by construction: it stores only catalogue
-- IDs, confidence bands, set/era/language codes, provider/model, and the
-- grader's decision — NEVER card images, customer data, cert numbers, or
-- provider chain-of-thought. Powers a future accuracy dashboard; nothing here
-- retrains or changes any rule automatically.
--
-- Additive · idempotent · reversible (rollback-card-identification-analytics.sql).
-- Touches no existing table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS card_identification_corrections (
  id SERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  field TEXT NOT NULL,                 -- e.g. rarity_code | set_code | finish_variant
  -- What the AI suggested vs what the grader ended up with (catalogue codes only).
  suggested_value TEXT,
  decision TEXT NOT NULL,              -- accepted | rejected | changed
  corrected_value TEXT,
  confidence_band TEXT,                -- high | medium | low | conflict | unknown
  -- Context for slicing accuracy (all catalogue codes, no PII).
  set_key TEXT,
  era TEXT,
  language TEXT,
  provider TEXT,
  model TEXT,
  actor TEXT,                          -- staff/admin identifier (not customer data)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE card_identification_corrections ADD CONSTRAINT card_id_corrections_decision_chk
    CHECK (decision IN ('accepted','rejected','changed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE card_identification_corrections ADD CONSTRAINT card_id_corrections_band_chk
    CHECK (confidence_band IS NULL OR confidence_band IN ('high','medium','low','conflict','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_card_id_corrections_field ON card_identification_corrections (field);
CREATE INDEX IF NOT EXISTS idx_card_id_corrections_created ON card_identification_corrections (created_at);
CREATE INDEX IF NOT EXISTS idx_card_id_corrections_request ON card_identification_corrections (request_id);

-- ── Idempotency + daily-spend ledger for identify requests ──────────────────
-- One row per explicit Identify click. The UNIQUE idempotency_key makes a
-- double-click return the stored suggestion instead of issuing a second
-- (charged) provider call — and it's multi-machine safe (unlike an in-process
-- guard). `result` holds ONLY the assembled, validated suggestion (short
-- evidence, catalogue codes) — never raw provider output, images, or PII.
CREATE TABLE IF NOT EXISTS card_identification_requests (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  cert_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  cost_usd NUMERIC(10,5),
  result JSONB,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_card_id_requests_key ON card_identification_requests (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_card_id_requests_created ON card_identification_requests (created_at);
