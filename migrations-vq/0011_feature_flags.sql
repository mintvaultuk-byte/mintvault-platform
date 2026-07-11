-- Vault Quest emergency runtime feature flags (Phase 7E). VQ-only, ADDITIVE,
-- idempotent. NOT applied by this branch — apply to the VQ DB directly (never
-- drizzle-kit push).
--
-- A row ABSENT = default-ON, so a missing/empty table never disables VQ. The env
-- HARD-OFF vars beat this table and need no DB. DROP TABLE returns to env-only
-- control (default-on) and cannot break VQ because the reader soft-fails to {}.

CREATE TABLE IF NOT EXISTS "vq_feature_flags" (
  "feature"    text PRIMARY KEY CHECK (feature IN ('generation','exports','writes')),
  "enabled"    boolean NOT NULL,
  "reason"     text,
  "updated_by" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
