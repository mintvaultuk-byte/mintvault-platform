-- Vault Quest approved-artwork revision ledger + integrity + backup state (R4-OPS-02).
-- VQ-only, ADDITIVE, idempotent. NOT applied by this branch — apply to the
-- dedicated VQ DB directly (never drizzle-kit push: drift -> destructive drop).
--
-- Every approve/upload writes a NEW immutable versioned key + a row here (sha256 +
-- size); the entity's existing pointer column points at the active revision. The
-- partial-unique active index is the load-bearing invariant: the DB refuses two
-- live revisions for one slot, so a botched pointer swap can't split-brain.

CREATE TABLE IF NOT EXISTS "vq_artwork_revisions" (
  "id"                  serial PRIMARY KEY,
  "entity_type"         text NOT NULL CHECK (entity_type IN ('character','card')),
  "entity_id"           text NOT NULL,
  "slot"                text NOT NULL,
  "r2_key"              text NOT NULL UNIQUE,
  "sha256"              text NOT NULL,
  "byte_size"           integer NOT NULL,
  "mime"                text NOT NULL DEFAULT 'image/png',
  "width"               integer,
  "height"              integer,
  "source_candidate_id" integer,
  "created_by"          text,
  "created_at"          timestamp NOT NULL DEFAULT now(),
  "is_active"           boolean NOT NULL DEFAULT true,
  "backup_state"        text NOT NULL DEFAULT 'pending' CHECK (backup_state IN ('pending','archived','failed')),
  "archived_at"         timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_revisions_entity_idx"
  ON "vq_artwork_revisions" ("entity_type","entity_id","slot");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vq_artwork_revisions_active_uq"
  ON "vq_artwork_revisions" ("entity_type","entity_id","slot") WHERE "is_active" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_revisions_backup_idx" ON "vq_artwork_revisions" ("backup_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vq_artwork_revisions_sha_idx" ON "vq_artwork_revisions" ("sha256");
