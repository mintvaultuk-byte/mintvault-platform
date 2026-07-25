-- Set Library schema foundation — additive and idempotent.
--
-- 0023 is unclaimed across all repository refs. 0019–0021 are claimed by
-- active branches and 0022 is the print-workflow migration. This migration
-- makes the catalogue-read schema explicit so public read-only endpoints never
-- need runtime DDL.

ALTER TABLE custom_sets
  ADD COLUMN IF NOT EXISTS subset TEXT,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE tcgdex_sets
  ADD COLUMN IF NOT EXISTS card_game TEXT NOT NULL DEFAULT 'pokemon',
  ADD COLUMN IF NOT EXISTS subset TEXT,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS set_review_decisions (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  set_id TEXT NOT NULL,
  suggestion_key TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  actor_id TEXT,
  actor_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, set_id, suggestion_key)
);
