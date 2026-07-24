-- ============================================================================
-- ROLLBACK for 0019_catalogue_manager.sql
-- Date: 2026-07-24
--
-- Drops the additive `catalogue_items` table and its indexes. Because the
-- forward migration is purely additive (one new table, no existing object
-- touched), this rollback is a clean, total reversal — no existing certificate,
-- audit, or settings data is affected.
--
-- DESTRUCTIVE: this drops all catalogue rows. Take a backup / export the
-- catalogue (Catalogue Manager → Export JSON, or `pg_dump -t catalogue_items`)
-- before running if any founder-entered catalogue edits must be preserved. The
-- seed data can always be regenerated via scripts/db/seed-catalogue.ts.
-- ============================================================================

DROP INDEX IF EXISTS idx_catalogue_items_active;
DROP INDEX IF EXISTS idx_catalogue_items_category;
DROP INDEX IF EXISTS uq_catalogue_items_category_value;
DROP TABLE IF EXISTS catalogue_items;
