CREATE TABLE IF NOT EXISTS "vq_characters" (
  "id" serial PRIMARY KEY NOT NULL,
  "character_id" text NOT NULL UNIQUE,
  "set_code" text DEFAULT 'GNV' NOT NULL,
  "family_id" text NOT NULL,
  "family_name" text,
  "card_id" text NOT NULL UNIQUE,
  "stage_number" integer NOT NULL,
  "character_name" text NOT NULL,
  "element" text NOT NULL,
  "role" text,
  "variant_card_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "evolves_from_character_id" text,
  "source_notes" text,
  "character_dna" text,
  "visual_description" text,
  "body_shape" text,
  "colours" text,
  "markings" text,
  "eyes" text,
  "tail_accessories" text,
  "personality" text,
  "stage_progression_notes" text,
  "element_identity" text,
  "negative_prompt" text,
  "master_artwork_prompt" text,
  "reference_artwork_r2_key" text,
  "approved_artwork_r2_key" text,
  "approval_status" text DEFAULT 'draft' NOT NULL,
  "locked" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_characters_family_idx" ON "vq_characters" USING btree ("family_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_characters_set_idx" ON "vq_characters" USING btree ("set_code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vq_characters_family_stage_uq" ON "vq_characters" USING btree ("family_id", "stage_number");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vq_character_revisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "character_id" text NOT NULL,
  "revision_json" jsonb NOT NULL,
  "edited_by" text,
  "reason" text,
  "edited_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_character_revisions_character_idx" ON "vq_character_revisions" USING btree ("character_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vq_artwork_candidates" (
  "id" serial PRIMARY KEY NOT NULL,
  "character_id" text,
  "card_id" text,
  "slot" text DEFAULT 'main' NOT NULL,
  "source" text DEFAULT 'generated' NOT NULL,
  "provider" text,
  "model" text,
  "prompt" text,
  "r2_key" text NOT NULL UNIQUE,
  "width" integer,
  "height" integer,
  "status" text DEFAULT 'candidate' NOT NULL,
  "ai_generation_id" integer,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_candidates_character_idx" ON "vq_artwork_candidates" USING btree ("character_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_candidates_card_idx" ON "vq_artwork_candidates" USING btree ("card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_candidates_status_idx" ON "vq_artwork_candidates" USING btree ("status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vq_family_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "family_id" text NOT NULL UNIQUE,
  "element" text NOT NULL,
  "allowed_attack_themes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "forbidden_attack_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "stat_profile" jsonb,
  "notes" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_family_rules_element_idx" ON "vq_family_rules" USING btree ("element");
--> statement-breakpoint

WITH base_creatures AS (
  SELECT
    c.card_id,
    c.family_id,
    c.stage_number,
    c.name AS character_name,
    c.element,
    c.life_stage,
    c.set_code,
    f.name AS family_name
  FROM vq_cards c
  JOIN vq_families f ON f.family_id = c.family_id
  WHERE c.card_type = 'Creature'
    AND c.base_card_id IS NULL
    AND c.family_id IN (
      'GNV-F01','GNV-F02','GNV-F03','GNV-F04','GNV-F05','GNV-F06',
      'GNV-F07','GNV-F08','GNV-F09','GNV-F10','GNV-F11','GNV-F12'
    )
),
variants AS (
  SELECT
    base_card_id,
    jsonb_agg(card_id ORDER BY card_id) AS variant_card_ids
  FROM vq_cards
  WHERE base_card_id IS NOT NULL
  GROUP BY base_card_id
),
seed_notes AS (
  SELECT *
  FROM (VALUES
    ('GNV-F01', 'Energetic / Loyal / Brave', 'Approved Family 01 sheet'),
    ('GNV-F02', 'Calm / Loyal / Playful', 'Approved Family 02 sheet'),
    ('GNV-F03', 'Gentle / Natural / Nurturing', 'Approved Family 03 sheet'),
    ('GNV-F04', 'Energetic / Bold / Electric', 'Approved Family 04 sheet'),
    ('GNV-F05', 'Steady / Strong / Loyal', 'Approved Family 05 sheet'),
    ('GNV-F06', 'Mystical / Wise / Dreamy', 'Generated Family 06 sheet - Option B update'),
    ('GNV-F07', 'Free / Agile / Playful', 'Generated Family 07 sheet - Option B update'),
    ('GNV-F08', 'Energetic / Bold / Confident', 'Generated Family 08 sheet - Option B update'),
    ('GNV-F09', 'Calm / Wise / Resilient', 'Generated Family 09 sheet - Option B update'),
    ('GNV-F10', 'Mysterious / Sneaky / Loyal', 'Generated Family 10 sheet - Option B update'),
    ('GNV-F11', 'Steady / Strong / Nurturing', 'Generated Family 11 sheet - Option B update'),
    ('GNV-F12', 'Adaptable / Playful / Fluid', 'Generated Family 12 sheet - Option B update')
  ) AS t(family_id, vibe, source_note)
)
INSERT INTO vq_characters (
  character_id,
  set_code,
  family_id,
  family_name,
  card_id,
  stage_number,
  character_name,
  element,
  role,
  variant_card_ids,
  evolves_from_character_id,
  source_notes,
  personality
)
SELECT
  b.family_id || '-S' || b.stage_number,
  b.set_code,
  b.family_id,
  b.family_name,
  b.card_id,
  b.stage_number,
  b.character_name,
  b.element,
  b.life_stage,
  COALESCE(v.variant_card_ids, '[]'::jsonb),
  CASE WHEN b.stage_number > 1 THEN b.family_id || '-S' || (b.stage_number - 1) ELSE NULL END,
  COALESCE(n.vibe || '. ' || n.source_note || '.', NULL),
  n.vibe
FROM base_creatures b
LEFT JOIN variants v ON v.base_card_id = b.card_id
LEFT JOIN seed_notes n ON n.family_id = b.family_id
ON CONFLICT (character_id) DO NOTHING;
--> statement-breakpoint

INSERT INTO vq_family_rules (
  family_id,
  element,
  allowed_attack_themes,
  forbidden_attack_terms,
  stat_profile,
  notes
)
SELECT
  f.family_id,
  f.element,
  jsonb_build_array(
    CASE f.element
      WHEN 'Blaze' THEN 'fire, flame, ember, heat'
      WHEN 'Tide' THEN 'water, wave, tidal, ocean'
      WHEN 'Blossom' THEN 'nature, petal, bloom, vine'
      WHEN 'Spark' THEN 'spark, jolt, static, electric'
      WHEN 'Earth' THEN 'earth, rock, stone, boulder'
      WHEN 'Cosmos' THEN 'cosmic, star, gravity, nebula'
      WHEN 'Wind' THEN 'wind, gust, gale, air'
      WHEN 'Electric' THEN 'lightning, shock, volt, thunder'
      WHEN 'Ice' THEN 'ice, frost, snow, glacial'
      WHEN 'Dark' THEN 'shadow, night, dark, umbral'
      WHEN 'Water' THEN 'water, current, splash, aqua'
      ELSE lower(f.element) || '-themed'
    END
  ),
  '[]'::jsonb,
  jsonb_build_object(
    'stage1', jsonb_build_object('health', 5, 'guard', 0, 'shift', 0),
    'stage2', jsonb_build_object('health', 8, 'guard', 1, 'shift', 1),
    'stage3', jsonb_build_object('health', 12, 'guard', 3, 'shift', 2)
  ),
  'Seeded from canonical family element; refine after playtest.'
FROM vq_families f
WHERE f.family_id IN (
  'GNV-F01','GNV-F02','GNV-F03','GNV-F04','GNV-F05','GNV-F06',
  'GNV-F07','GNV-F08','GNV-F09','GNV-F10','GNV-F11','GNV-F12'
)
ON CONFLICT (family_id) DO NOTHING;
