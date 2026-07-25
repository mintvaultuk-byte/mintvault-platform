-- Set Library canonical base schema — additive and idempotent.
--
-- Migration 0023 owns the Set Library additions but intentionally used
-- ALTER TABLE IF EXISTS because the base tables were historically created by
-- runtime application code. That runtime DDL has been removed. This migration
-- establishes the complete, numbered-migration owner for fresh installs and
-- safely adopts the known legacy runtime-created table shapes.

CREATE TABLE IF NOT EXISTS custom_sets (
  id SERIAL PRIMARY KEY,
  set_id TEXT NOT NULL UNIQUE,
  set_name TEXT NOT NULL,
  series TEXT,
  ptcgo_code TEXT,
  release_date DATE,
  total_cards INTEGER,
  card_game TEXT NOT NULL DEFAULT 'pokemon',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT,
  subset TEXT,
  archived BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tcgdex_sets (
  id SERIAL PRIMARY KEY,
  set_id TEXT NOT NULL UNIQUE,
  set_name TEXT NOT NULL,
  series TEXT,
  ptcgo_code TEXT,
  release_date DATE,
  total_cards INTEGER,
  source TEXT NOT NULL DEFAULT 'tcgdex',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  card_game TEXT NOT NULL DEFAULT 'pokemon',
  subset TEXT,
  archived BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Legacy runtime-created tables already have these base columns. ADD COLUMN
-- keeps the migration safe for older partial schemas without rewriting rows.
ALTER TABLE custom_sets
  ADD COLUMN IF NOT EXISTS id SERIAL,
  ADD COLUMN IF NOT EXISTS set_id TEXT,
  ADD COLUMN IF NOT EXISTS set_name TEXT,
  ADD COLUMN IF NOT EXISTS series TEXT,
  ADD COLUMN IF NOT EXISTS ptcgo_code TEXT,
  ADD COLUMN IF NOT EXISTS release_date DATE,
  ADD COLUMN IF NOT EXISTS total_cards INTEGER,
  ADD COLUMN IF NOT EXISTS card_game TEXT NOT NULL DEFAULT 'pokemon',
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS subset TEXT,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE tcgdex_sets
  ADD COLUMN IF NOT EXISTS id SERIAL,
  ADD COLUMN IF NOT EXISTS set_id TEXT,
  ADD COLUMN IF NOT EXISTS set_name TEXT,
  ADD COLUMN IF NOT EXISTS series TEXT,
  ADD COLUMN IF NOT EXISTS ptcgo_code TEXT,
  ADD COLUMN IF NOT EXISTS release_date DATE,
  ADD COLUMN IF NOT EXISTS total_cards INTEGER,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tcgdex',
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS card_game TEXT NOT NULL DEFAULT 'pokemon',
  ADD COLUMN IF NOT EXISTS subset TEXT,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE custom_sets
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN set_id SET NOT NULL,
  ALTER COLUMN set_name SET NOT NULL,
  ALTER COLUMN card_game SET DEFAULT 'pokemon',
  ALTER COLUMN card_game SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN archived SET DEFAULT false,
  ALTER COLUMN archived SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE tcgdex_sets
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN set_id SET NOT NULL,
  ALTER COLUMN set_name SET NOT NULL,
  ALTER COLUMN source SET DEFAULT 'tcgdex',
  ALTER COLUMN source SET NOT NULL,
  ALTER COLUMN synced_at SET DEFAULT NOW(),
  ALTER COLUMN synced_at SET NOT NULL,
  ALTER COLUMN card_game SET DEFAULT 'pokemon',
  ALTER COLUMN card_game SET NOT NULL,
  ALTER COLUMN archived SET DEFAULT false,
  ALTER COLUMN archived SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT NOW();

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

-- Do not create duplicate constraints when adopting the known legacy schema.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['custom_sets', 'tcgdex_sets'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = table_name::regclass AND c.contype = 'p'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (id)', table_name);
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.conrelid = table_name::regclass
        AND c.contype = 'u'
        AND array_length(c.conkey, 1) = 1
        AND a.attname = 'set_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD UNIQUE (set_id)', table_name);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'set_review_decisions'::regclass
      AND c.contype = 'u'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'set_review_decisions'::regclass AND attname = 'source'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'set_review_decisions'::regclass AND attname = 'set_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'set_review_decisions'::regclass AND attname = 'suggestion_key')
      ]
  ) THEN
    ALTER TABLE set_review_decisions ADD UNIQUE (source, set_id, suggestion_key);
  END IF;
END $$;
