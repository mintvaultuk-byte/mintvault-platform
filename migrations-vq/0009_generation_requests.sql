-- Paid-generation idempotency & spend ledger (PROV-01..07), Phase 7B.
-- VQ-only, ADDITIVE, idempotent. NOT applied by this branch — apply to the
-- dedicated VQ DB directly (never drizzle-kit push: drift -> destructive drop).
--
-- One row per logical generation request. The UNIQUE idempotency_key makes one
-- request the single winner across both Fly machines; provider_job_id is persisted
-- the instant the provider create returns so a success-then-failure is recoverable;
-- created_at + charged_credits back the cross-machine hourly/daily spend ceilings.

CREATE TABLE IF NOT EXISTS "vq_generation_requests" (
  "id"                        serial PRIMARY KEY,
  "idempotency_key"           text NOT NULL,
  "request_fingerprint"       text NOT NULL,
  "admin_id"                  text,
  "set_code"                  text,
  "character_id"              text,
  "card_id"                   text,
  "family_id"                 text,
  "stage_id"                  text,
  "generation_type"           text NOT NULL,
  "model_requested"           text,
  "model_used"                text,
  "requested_count"           integer NOT NULL DEFAULT 1,
  "max_authorised_spend"      numeric(10,2) NOT NULL,
  "estimated_credits"         numeric(10,2) NOT NULL DEFAULT 0,
  "provider_reported_credits" numeric(10,2),
  "charged_credits"           numeric(10,2) NOT NULL DEFAULT 0,
  "state"                     text NOT NULL DEFAULT 'received'
                                CHECK (state IN ('received','reserved','provider_submitted','provider_processing',
                                                 'provider_completed','persisting','completed','failed_retryable',
                                                 'failed_final','unknown_provider_state','cancelled')),
  "provider_job_id"           text,
  "provider_request_id"       text,
  "candidate_id"              integer,
  "attempt_count"             integer NOT NULL DEFAULT 0,
  "error_class"               text,
  "last_error"                text,
  "retry_after"               timestamp,
  "expires_at"                timestamp,
  "created_at"                timestamp NOT NULL DEFAULT now(),
  "started_at"                timestamp,
  "completed_at"              timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vq_gen_req_idem_uq" ON "vq_generation_requests" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_gen_req_spend_idx" ON "vq_generation_requests" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_gen_req_state_idx" ON "vq_generation_requests" ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_gen_req_job_idx" ON "vq_generation_requests" ("provider_job_id")
  WHERE "provider_job_id" IS NOT NULL;
