-- ============================================================================
-- ROLLBACK: Pokémon Knowledge Engine tables (add-pokemon-knowledge.sql)
-- Drops ONLY the five knowledge tables + their indexes/constraints.
-- Touches nothing else. Safe to run multiple times (idempotent).
-- ============================================================================

DROP TABLE IF EXISTS pokemon_review_queue;
DROP TABLE IF EXISTS pokemon_import_runs;
DROP TABLE IF EXISTS pokemon_knowledge_revisions;
DROP TABLE IF EXISTS pokemon_set_aliases;
DROP TABLE IF EXISTS pokemon_set_knowledge;
