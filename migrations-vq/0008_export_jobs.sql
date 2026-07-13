-- Durable Vault Quest export jobs (INFRA-01 / OPEN-27), Phase 7A.
-- VQ-only, ADDITIVE, idempotent. NOT applied by this branch — apply to the
-- dedicated VQ DB directly (never drizzle-kit push: drift -> destructive drop).
--
-- Moves export job state off the in-process Map (which fails ~50% on 2-machine
-- Fly prod when poll/download land on a different machine) into Postgres; output
-- bytes live in R2 under vq/exports/{job_id}/. gen_random_uuid() is core in
-- Neon PG13+ (no extension needed).

CREATE TABLE IF NOT EXISTS "vq_export_jobs" (
  "id"              serial PRIMARY KEY,
  "job_id"          uuid NOT NULL DEFAULT gen_random_uuid(),
  "kind"            text NOT NULL,
  "owner_admin_id"  text NOT NULL,
  "idempotency_key" text NOT NULL,
  "state"           text NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued','processing','partial','completed','failed','cancelled','expired')),
  "requested_count" integer NOT NULL DEFAULT 0,
  "completed_count" integer NOT NULL DEFAULT 0,
  "skipped_count"   integer NOT NULL DEFAULT 0,
  "failed_count"    integer NOT NULL DEFAULT 0,
  "output_key"      text,
  "output_hash"     text,
  "output_size"     bigint,
  "content_type"    text,
  "file_name"       text,
  "error_code"      text,
  "error_message"   text,
  "worker_machine"  text,
  "lease_expires_at" timestamp,
  "created_at"      timestamp NOT NULL DEFAULT now(),
  "started_at"      timestamp,
  "completed_at"    timestamp,
  "expires_at"      timestamp NOT NULL DEFAULT (now() + INTERVAL '20 minutes')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vq_export_jobs_job_id_uq" ON "vq_export_jobs" ("job_id");
--> statement-breakpoint
-- One active job per idempotency key; terminal rows may repeat (re-export allowed).
CREATE UNIQUE INDEX IF NOT EXISTS "vq_export_jobs_idem_active_uq"
  ON "vq_export_jobs" ("idempotency_key") WHERE state IN ('queued','processing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_export_jobs_state_expires_idx" ON "vq_export_jobs" ("state","expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_export_jobs_state_lease_idx"   ON "vq_export_jobs" ("state","lease_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_export_jobs_owner_idx"         ON "vq_export_jobs" ("owner_admin_id","created_at");
