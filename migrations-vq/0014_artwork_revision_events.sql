-- Vault Quest artwork-revision AUDIT LOG (Phase 10A-6). VQ-only, ADDITIVE,
-- idempotent, append-only (no UPDATE/DELETE ever issued against this table).
-- NOT applied by this branch except to the LOCAL throwaway DB — apply to the
-- dedicated VQ DB directly (never drizzle-kit push: drift -> destructive drop).
--
-- vq_artwork_revisions.is_active/archived_at only reflect the LATEST transition
-- for a row (reactivating a row overwrites archived_at back to null), so they
-- cannot answer "what happened, in what order, by whom" across multiple
-- activate/deactivate/restore cycles. This table is that history, independent of
-- the mutable pointer state.

CREATE TABLE IF NOT EXISTS "vq_artwork_revision_events" (
  "id"           serial PRIMARY KEY,
  "revision_id"  integer NOT NULL,
  "entity_type"  text NOT NULL CHECK (entity_type IN ('character','card')),
  "entity_id"    text NOT NULL,
  "slot"         text NOT NULL,
  "action"       text NOT NULL CHECK (action IN ('created','activated','deactivated','restored','upload_failed','commit_failed')),
  "actor"        text,
  "note"         text,
  "occurred_at"  timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_revision_events_entity_idx"
  ON "vq_artwork_revision_events" ("entity_type","entity_id","slot","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_revision_events_revision_idx"
  ON "vq_artwork_revision_events" ("revision_id");

-- Rollback (owner-approved only):
--   DROP INDEX IF EXISTS "vq_artwork_revision_events_revision_idx";
--   DROP INDEX IF EXISTS "vq_artwork_revision_events_entity_idx";
--   DROP TABLE IF EXISTS "vq_artwork_revision_events";
