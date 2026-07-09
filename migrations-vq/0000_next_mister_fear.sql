CREATE TABLE "vq_card_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"revision_json" jsonb NOT NULL,
	"edited_by" text,
	"edited_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vq_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"collector_number" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"card_type" text NOT NULL,
	"element" text NOT NULL,
	"rarity" text,
	"family_id" text,
	"stage_number" integer,
	"life_stage" text,
	"health" integer,
	"guard" integer,
	"shift" integer,
	"attack1_name" text,
	"attack1_cost" integer,
	"attack1_damage" integer,
	"attack1_effect" text,
	"attack2_name" text,
	"attack2_cost" integer,
	"attack2_damage" integer,
	"attack2_effect" text,
	"vulnerability" text,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effects" jsonb,
	"art_r2_key" text,
	"prev_art_r2_key" text,
	"render_r2_key" text,
	"set_code" text DEFAULT 'GNV' NOT NULL,
	"language" text DEFAULT 'EN' NOT NULL,
	"year" integer DEFAULT 2026 NOT NULL,
	"edition" text DEFAULT 'FIRST EDITION' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vq_cards_card_id_unique" UNIQUE("card_id")
);
--> statement-breakpoint
CREATE TABLE "vq_elements" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"border" text NOT NULL,
	"accent" text NOT NULL,
	"dark" text NOT NULL,
	"crest_key" text,
	CONSTRAINT "vq_elements_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "vq_families" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"set_code" text DEFAULT 'GNV' NOT NULL,
	"element" text NOT NULL,
	"name" text NOT NULL,
	"stage1_name" text,
	"stage2_name" text,
	"stage3_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vq_families_family_id_unique" UNIQUE("family_id")
);
--> statement-breakpoint
CREATE TABLE "vq_game_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "vq_game_config_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "vq_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"set_code" text DEFAULT 'GNV' NOT NULL,
	"cards_json_r2_key" text NOT NULL,
	"card_count" integer DEFAULT 0 NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"published_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vq_releases_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "vq_sets" (
	"id" serial PRIMARY KEY NOT NULL,
	"set_code" text NOT NULL,
	"name" text NOT NULL,
	"year" integer NOT NULL,
	"edition" text NOT NULL,
	"rules_version" text DEFAULT 'v0.1' NOT NULL,
	"card_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vq_sets_set_code_unique" UNIQUE("set_code")
);
--> statement-breakpoint
CREATE INDEX "vq_card_revisions_card_idx" ON "vq_card_revisions" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "vq_cards_set_status_idx" ON "vq_cards" USING btree ("set_code","status");--> statement-breakpoint
CREATE INDEX "vq_cards_element_idx" ON "vq_cards" USING btree ("element");--> statement-breakpoint
CREATE INDEX "vq_cards_type_idx" ON "vq_cards" USING btree ("card_type");--> statement-breakpoint
CREATE INDEX "vq_families_set_idx" ON "vq_families" USING btree ("set_code");--> statement-breakpoint
CREATE UNIQUE INDEX "vq_releases_current_idx" ON "vq_releases" USING btree ("set_code") WHERE "vq_releases"."is_current";