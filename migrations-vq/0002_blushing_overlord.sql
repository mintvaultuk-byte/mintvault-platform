CREATE TABLE "vq_ai_generations" (
	"id" serial PRIMARY KEY NOT NULL,
	"card_id" text,
	"kind" text NOT NULL,
	"mode" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"generated_by" text,
	"prompt" text,
	"output" jsonb,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vq_ai_generations_card_idx" ON "vq_ai_generations" USING btree ("card_id");