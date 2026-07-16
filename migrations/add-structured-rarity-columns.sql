-- ============================================================================
-- Structured Pokémon rarity/variant foundation (Phase 1 — ADDITIVE ONLY)
-- Date: 2026-07-16
--
-- Adds nullable structured columns to `certificates` so rarity, printed symbol,
-- symbol colour, finish, promo, subset, region and era can each be stored
-- SEPARATELY instead of in the one flat `variant` text column. The existing
-- `variant` / `variant_other` / `rarity` / `language` columns are LEFT UNTOUCHED
-- as the historical source of truth. Every new column is nullable with no
-- default, so existing rows stay valid and current write paths are unaffected.
--
-- Also creates `rarity_mapping_reviews` — the (empty) admin review-queue table
-- used to confirm legacy -> structured mappings later. NOTHING in this migration
-- backfills, rewrites, or deletes any certificate data.
--
-- Idempotent + reversible (see rollback-structured-rarity-columns.sql).
-- Safe to run more than once.
-- ============================================================================

-- 1 · Structured columns on certificates (all nullable, no default) ----------
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS rarity_code TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS rarity_label TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS printed_symbol TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS printed_symbol_count INTEGER;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS printed_symbol_colour TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS finish_variant TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS promo_type TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS subset_name TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS era TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS structured_variant_version INTEGER;

-- 2 · Bounded validation on the small, STABLE enumerations only ---------------
-- rarity_code / finish_variant / promo_type / subset_name deliberately have NO
-- IN(...) constraint: those catalogues grow over time and are validated in the
-- application layer, so a DB enum there would force a migration on every new
-- rarity. Every check below allows NULL, so existing rows (all NULL) pass.
-- Guarded so re-running the migration does not error on an existing constraint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_printed_symbol_colour_chk' AND conrelid = 'certificates'::regclass) THEN
    ALTER TABLE certificates ADD CONSTRAINT certificates_printed_symbol_colour_chk
      CHECK (printed_symbol_colour IS NULL OR printed_symbol_colour IN ('black','white','silver','gold','bronze','rainbow','none'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_printed_symbol_count_chk' AND conrelid = 'certificates'::regclass) THEN
    ALTER TABLE certificates ADD CONSTRAINT certificates_printed_symbol_count_chk
      CHECK (printed_symbol_count IS NULL OR (printed_symbol_count >= 1 AND printed_symbol_count <= 5));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_region_chk' AND conrelid = 'certificates'::regclass) THEN
    ALTER TABLE certificates ADD CONSTRAINT certificates_region_chk
      CHECK (region IS NULL OR region IN ('western','japan','korea','china','sea','other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_era_chk' AND conrelid = 'certificates'::regclass) THEN
    ALTER TABLE certificates ADD CONSTRAINT certificates_era_chk
      CHECK (era IS NULL OR era IN ('vintage','ex-dp','bw-xy','sm','swsh','sv'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_structured_variant_version_chk' AND conrelid = 'certificates'::regclass) THEN
    ALTER TABLE certificates ADD CONSTRAINT certificates_structured_variant_version_chk
      CHECK (structured_variant_version IS NULL OR structured_variant_version >= 1);
  END IF;
END $$;

-- 3 · Partial index to support future "cards of rarity X" lookups -------------
-- Partial (WHERE rarity_code IS NOT NULL) so it stays near-empty until any data
-- is ever written — costs almost nothing now, ready when the picker is wired.
CREATE INDEX IF NOT EXISTS idx_certificates_rarity_code
  ON certificates (rarity_code)
  WHERE rarity_code IS NOT NULL;

-- 4 · Admin review queue for legacy -> structured mappings (empty) ------------
-- Data structure only. Populated later from the read-only audit; the app never
-- auto-applies a mapping. status: pending | approved | rejected | ignored.
CREATE TABLE IF NOT EXISTS rarity_mapping_reviews (
  id                      SERIAL PRIMARY KEY,
  legacy_value            TEXT NOT NULL,
  proposed_classification TEXT,
  proposed_value          TEXT,
  confidence              TEXT,
  reason                  TEXT,
  record_count            INTEGER NOT NULL DEFAULT 0,
  review_required         BOOLEAN NOT NULL DEFAULT TRUE,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','ignored')),
  reviewed_by             TEXT,
  reviewed_at             TIMESTAMP,
  created_at              TIMESTAMP NOT NULL DEFAULT now(),
  updated_at              TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT rarity_mapping_reviews_classification_chk
    CHECK (proposed_classification IS NULL OR proposed_classification IN ('rarity','finish','promo','subset','ambiguous')),
  CONSTRAINT rarity_mapping_reviews_confidence_chk
    CHECK (confidence IS NULL OR confidence IN ('high','medium','low'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rarity_mapping_reviews_legacy_value
  ON rarity_mapping_reviews (legacy_value);
CREATE INDEX IF NOT EXISTS idx_rarity_mapping_reviews_status
  ON rarity_mapping_reviews (status);
