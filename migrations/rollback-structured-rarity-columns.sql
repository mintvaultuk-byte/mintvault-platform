-- ============================================================================
-- ROLLBACK: Structured Pokémon rarity/variant foundation (Phase 1)
-- Date: 2026-07-16
-- Reverts every change made by add-structured-rarity-columns.sql.
--
-- Because that migration is ADDITIVE and never touched the legacy `variant`,
-- `variant_other`, `rarity` or `language` columns, this rollback only drops the
-- new (empty / unwired) columns, constraints, index and review table. No
-- historical certificate data is affected.
--
-- Idempotent. Safe to run more than once.
-- ============================================================================

-- 1 · Drop the review queue (empty in Phase 1) -------------------------------
DROP TABLE IF EXISTS rarity_mapping_reviews;

-- 2 · Drop the partial index -------------------------------------------------
DROP INDEX IF EXISTS idx_certificates_rarity_code;

-- 3 · Drop the bounded CHECK constraints -------------------------------------
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_printed_symbol_colour_chk;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_printed_symbol_count_chk;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_region_chk;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_era_chk;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_structured_variant_version_chk;

-- 4 · Drop the structured columns --------------------------------------------
ALTER TABLE certificates DROP COLUMN IF EXISTS rarity_code;
ALTER TABLE certificates DROP COLUMN IF EXISTS rarity_label;
ALTER TABLE certificates DROP COLUMN IF EXISTS printed_symbol;
ALTER TABLE certificates DROP COLUMN IF EXISTS printed_symbol_count;
ALTER TABLE certificates DROP COLUMN IF EXISTS printed_symbol_colour;
ALTER TABLE certificates DROP COLUMN IF EXISTS finish_variant;
ALTER TABLE certificates DROP COLUMN IF EXISTS promo_type;
ALTER TABLE certificates DROP COLUMN IF EXISTS subset_name;
ALTER TABLE certificates DROP COLUMN IF EXISTS region;
ALTER TABLE certificates DROP COLUMN IF EXISTS era;
ALTER TABLE certificates DROP COLUMN IF EXISTS structured_variant_version;
