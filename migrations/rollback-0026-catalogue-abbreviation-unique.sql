-- Rollback for 0026_catalogue_abbreviation_unique.sql
--
-- Drops ONLY the index the migration added. No table, column or row is touched,
-- so this is a complete and lossless reversal.

DROP INDEX IF EXISTS uq_catalogue_items_live_effective_code;
