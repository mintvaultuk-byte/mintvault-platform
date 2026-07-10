-- Genesis Production Studio (Phase 4). VQ-only, ADDITIVE, idempotent.
-- NOT applied by this branch — apply to the dedicated VQ staging DB when ready.

CREATE TABLE IF NOT EXISTS "vq_set_settings" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL UNIQUE,
  "name" text,
  "code" text,
  "release_year" integer,
  "card_count" integer,
  "elements" jsonb,
  "rarity_structure" jsonb,
  "fonts" jsonb,
  "colour_palette" jsonb,
  "set_logo_r2_key" text,
  "booster_size" integer,
  "cards_per_pack" integer,
  "description" text,
  "locked" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "vq_production_stages" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL,
  "stage_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'not_started',
  "note" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vq_prod_stage_set_idx" ON "vq_production_stages" ("set_code", "stage_key");

CREATE TABLE IF NOT EXISTS "vq_packaging_items" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "artwork_r2_key" text,
  "mockup_r2_key" text,
  "print_pdf_r2_key" text,
  "dieline_r2_key" text,
  "status" text NOT NULL DEFAULT 'not_started',
  "approval_status" text NOT NULL DEFAULT 'draft',
  "locked" boolean NOT NULL DEFAULT false,
  "revision" integer NOT NULL DEFAULT 1,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vq_packaging_set_idx" ON "vq_packaging_items" ("set_code");

CREATE TABLE IF NOT EXISTS "vq_pack_config" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL,
  "name" text NOT NULL DEFAULT 'Standard Booster',
  "cards_per_pack" integer,
  "guaranteed_rarity" text,
  "variant_slots" integer,
  "holo_slots" integer,
  "card_pool" jsonb,
  "duplicate_rules" text,
  "sku" text,
  "barcode" text,
  "wrapper_version" text,
  "print_quantity" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vq_pack_config_set_idx" ON "vq_pack_config" ("set_code");

CREATE TABLE IF NOT EXISTS "vq_print_exports" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "file_r2_key" text,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vq_print_exports_set_idx" ON "vq_print_exports" ("set_code");

CREATE TABLE IF NOT EXISTS "vq_qa_checks" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL,
  "asset_type" text NOT NULL,
  "asset_ref" text NOT NULL,
  "checklist" jsonb,
  "status" text NOT NULL DEFAULT 'not_started',
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vq_qa_checks_set_idx" ON "vq_qa_checks" ("set_code");

CREATE TABLE IF NOT EXISTS "vq_release_state" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL UNIQUE,
  "cards_complete" boolean NOT NULL DEFAULT false,
  "packaging_complete" boolean NOT NULL DEFAULT false,
  "qa_passed" boolean NOT NULL DEFAULT false,
  "print_ready" boolean NOT NULL DEFAULT false,
  "release_date" text,
  "print_quantity" integer,
  "revision_number" integer NOT NULL DEFAULT 1,
  "final_export_r2_key" text,
  "archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "vq_asset_library" (
  "id" serial PRIMARY KEY,
  "set_code" text NOT NULL,
  "category" text NOT NULL,
  "name" text NOT NULL,
  "r2_key" text,
  "approved" boolean NOT NULL DEFAULT false,
  "source_type" text,
  "source_ref" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vq_asset_library_set_cat_idx" ON "vq_asset_library" ("set_code", "category");
