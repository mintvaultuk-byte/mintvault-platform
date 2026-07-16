-- ============================================================================
-- Pokémon Knowledge Engine — additive knowledge tables (2026-07-16)
--
-- Five NEW standalone tables. Nothing here touches certificates, card_sets,
-- custom_sets, tcgdex_sets or any existing table. Design constraint from the
-- Stage-2 audit: tcgdex re-import UPSERTs clobber tcgdex_sets rows, so
-- founder-verified set knowledge lives in a COMPANION table keyed by the
-- normalised set code (set_key) — the importer never writes here.
--
-- Additive · idempotent (IF NOT EXISTS everywhere) · reversible
-- (rollback-pokemon-knowledge.sql). Era/region vocabularies match the live
-- CHECK constraints on certificates so set + cert data join cleanly.
-- ============================================================================

-- ── 1 · Canonical set knowledge (the set directory) ─────────────────────────
CREATE TABLE IF NOT EXISTS pokemon_set_knowledge (
  id SERIAL PRIMARY KEY,
  -- Normalised set code/id (lowercase, whitespace-stripped) — the join key to
  -- tcgdex_sets/custom_sets when present. Unique per language edition.
  set_key TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  canonical_name TEXT NOT NULL,
  local_name TEXT,
  translated_name TEXT,
  set_code TEXT,
  alt_code TEXT,
  abbreviation TEXT,
  series TEXT,
  era TEXT,
  region TEXT,
  release_date TEXT,               -- ISO date string; unknown allowed
  year TEXT,
  announced_count INTEGER,
  main_count INTEGER,
  secret_count INTEGER,
  collector_number_format TEXT,    -- e.g. "037/165", "SV107", "TG12/TG30"
  -- Regional-equivalent relationship: set_key of the related edition (loose
  -- reference, no FK — regional editions are SEPARATE records, never merged).
  parent_set_key TEXT,
  symbol_note TEXT,                -- description of the set symbol (no artwork)
  symbol_asset_key TEXT,           -- optional R2 key for an approved symbol asset
  -- Provenance + review
  source_type TEXT NOT NULL DEFAULT 'unknown',
  source_reference TEXT,
  verified_date TEXT,
  confidence TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'provisional',
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE pokemon_set_knowledge ADD CONSTRAINT pokemon_set_knowledge_status_chk
    CHECK (status IN ('verified','provisional','needs_review','disputed','deprecated','archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pokemon_set_knowledge ADD CONSTRAINT pokemon_set_knowledge_confidence_chk
    CHECK (confidence IN ('high','medium','low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pokemon_set_knowledge ADD CONSTRAINT pokemon_set_knowledge_era_chk
    CHECK (era IS NULL OR era IN ('vintage','ex-dp','bw-xy','sm','swsh','sv'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pokemon_set_knowledge ADD CONSTRAINT pokemon_set_knowledge_region_chk
    CHECK (region IS NULL OR region IN ('western','japan','korea','china','sea','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pokemon_set_knowledge ADD CONSTRAINT pokemon_set_knowledge_source_type_chk
    CHECK (source_type IN ('official_pokemon','official_regional','official_checklist_pdf','official_card_database','trusted_catalogue','founder_confirmed','staff_confirmed','community','inferred','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A verified record must say where it came from (provenance required).
DO $$ BEGIN
  ALTER TABLE pokemon_set_knowledge ADD CONSTRAINT pokemon_set_knowledge_verified_provenance_chk
    CHECK (status <> 'verified' OR source_type <> 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One knowledge record per (set_key, language) — regional/language editions
-- stay separate records by design.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pokemon_set_knowledge_key_lang
  ON pokemon_set_knowledge (set_key, language);
CREATE INDEX IF NOT EXISTS idx_pokemon_set_knowledge_status ON pokemon_set_knowledge (status);
CREATE INDEX IF NOT EXISTS idx_pokemon_set_knowledge_era ON pokemon_set_knowledge (era);
CREATE INDEX IF NOT EXISTS idx_pokemon_set_knowledge_name ON pokemon_set_knowledge (canonical_name);

-- ── 2 · Set aliases (search: codes, local names, market names) ──────────────
CREATE TABLE IF NOT EXISTS pokemon_set_aliases (
  id SERIAL PRIMARY KEY,
  set_key TEXT NOT NULL,           -- loose reference to pokemon_set_knowledge.set_key
  language TEXT NOT NULL DEFAULT 'en',
  alias_type TEXT NOT NULL,        -- printed_code | ptcgo | jp_english_name | market_name | translated_name | other
  alias_value TEXT NOT NULL,       -- normalised (lowercase, trimmed)
  source_type TEXT NOT NULL DEFAULT 'community',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE pokemon_set_aliases ADD CONSTRAINT pokemon_set_aliases_type_chk
    CHECK (alias_type IN ('printed_code','ptcgo','jp_english_name','market_name','translated_name','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pokemon_set_aliases_value
  ON pokemon_set_aliases (alias_type, alias_value, language);
CREATE INDEX IF NOT EXISTS idx_pokemon_set_aliases_set_key ON pokemon_set_aliases (set_key);

-- ── 3 · Knowledge revisions (never silently overwrite history) ──────────────
CREATE TABLE IF NOT EXISTS pokemon_knowledge_revisions (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,       -- 'set' | 'alias' | future entity kinds
  entity_key TEXT NOT NULL,        -- e.g. "<set_key>:<language>"
  revision_number INTEGER NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  reason TEXT,
  source_type TEXT,
  edited_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pokemon_knowledge_revisions
  ON pokemon_knowledge_revisions (entity_type, entity_key, revision_number);
CREATE INDEX IF NOT EXISTS idx_pokemon_knowledge_revisions_entity
  ON pokemon_knowledge_revisions (entity_type, entity_key);

-- ── 4 · Import runs (draft-based — never write canonical records directly) ──
CREATE TABLE IF NOT EXISTS pokemon_import_runs (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,            -- 'manual' | 'starter_seed' | 'csv' | 'json' | 'tcgdex'
  source_reference TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  payload JSONB NOT NULL DEFAULT '[]'::jsonb,  -- candidate set records (drafts)
  records_total INTEGER NOT NULL DEFAULT 0,
  records_added INTEGER NOT NULL DEFAULT 0,
  records_changed INTEGER NOT NULL DEFAULT 0,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_by TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE pokemon_import_runs ADD CONSTRAINT pokemon_import_runs_status_chk
    CHECK (status IN ('draft','approved','rejected','applied'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pokemon_import_runs_status ON pokemon_import_runs (status);

-- ── 5 · Review queue (knowledge issues needing a founder decision) ───────────
CREATE TABLE IF NOT EXISTS pokemon_review_queue (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,              -- duplicate_set_code | duplicate_set_name | conflicting_counts |
                                   -- missing_source | unverified | ambiguous_alias | new_set |
                                   -- disputed | deprecated_code | legacy_variant | other
  entity_type TEXT NOT NULL DEFAULT 'set',
  entity_key TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  import_run_id INTEGER,           -- loose reference to pokemon_import_runs.id
  status TEXT NOT NULL DEFAULT 'pending',
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE pokemon_review_queue ADD CONSTRAINT pokemon_review_queue_status_chk
    CHECK (status IN ('pending','approved','rejected','ignored'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pokemon_review_queue_status ON pokemon_review_queue (status);
CREATE INDEX IF NOT EXISTS idx_pokemon_review_queue_entity ON pokemon_review_queue (entity_type, entity_key);
