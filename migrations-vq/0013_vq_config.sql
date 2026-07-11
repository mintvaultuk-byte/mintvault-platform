-- Phase 10A (D4): minimal VQ-only key/value config store for spend ceilings +
-- operational values. VQ-only, additive, idempotent. Apply to the ISOLATED LOCAL
-- test DB only during Phase 10A. NOT staging/prod. NO grading/payment/global config
-- goes here. Absence of the table or a row degrades safely to conservative defaults.

CREATE TABLE IF NOT EXISTS "vq_config" (
  "key"        text PRIMARY KEY,
  "value"      text NOT NULL,
  "description" text,
  "updated_by" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- ROLLBACK (exact):  DROP TABLE IF EXISTS "vq_config";
-- Note: production values remain owner-gated and UNSET here; the app falls back to
-- conservative code defaults (server/vault-quest/lib/vq-config.ts) when a key is absent.
