-- ============================================================================
-- Catalogue Manager foundation (ADDITIVE ONLY)
-- Date: 2026-07-24
--
-- Creates ONE table, `catalogue_items`, which becomes the single source of truth
-- for every grading classification list (rarities, finishes, promo types,
-- designations, languages, eras, subsets, optional card attributes) so MintVault
-- can add/edit/disable/archive entries from the Super Admin "Catalogue Manager"
-- page WITHOUT a code deploy.
--
-- One row = one classification entry, discriminated by `category`. Per-category
-- structure (a rarity's printed-symbol metadata, a promo's kind, a language's
-- region…) lives in the `metadata` JSONB column, so the table stays canonical for
-- all eight sections. The hard-coded arrays in shared/pokemon-rarity-catalogue.ts
-- SEED this table (scripts/db/seed-catalogue.ts) and remain the offline fallback.
--
-- AUDIT: catalogue changes are recorded in the EXISTING `audit_log` table
-- (entity_type = 'catalogue_item'); this migration creates NO new audit table.
--
-- This migration is purely additive: it creates one new table + its indexes and
-- touches NO existing table, column, sequence, or row. It does not backfill,
-- rewrite or delete any data, and does not touch cert_counter or certificates.
--
-- Idempotent (IF NOT EXISTS throughout) and reversible
-- (see rollback-0019-catalogue-manager.sql — deliberately NOT numbered so the
-- migration runner never applies the rollback as a migration). Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS catalogue_items (
  id                   SERIAL PRIMARY KEY,
  category             TEXT        NOT NULL,
  value                TEXT        NOT NULL,
  label                TEXT        NOT NULL,
  abbreviation         TEXT,
  aliases              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  description          TEXT        NOT NULL DEFAULT '',
  metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sort_order           INTEGER     NOT NULL DEFAULT 0,
  active               BOOLEAN     NOT NULL DEFAULT TRUE,
  archived             BOOLEAN     NOT NULL DEFAULT FALSE,
  allow_cross_category BOOLEAN     NOT NULL DEFAULT FALSE,
  notes                TEXT,
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A `value` is unique WITHIN a category (prevents duplicate catalogue entries).
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_items_category_value
  ON catalogue_items (category, value);

-- Fast per-category listing.
CREATE INDEX IF NOT EXISTS idx_catalogue_items_category
  ON catalogue_items (category);

-- Fast "live picker" filtering (active, not archived) within a category.
CREATE INDEX IF NOT EXISTS idx_catalogue_items_active
  ON catalogue_items (category, active, archived);
