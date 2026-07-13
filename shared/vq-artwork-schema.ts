/**
 * Vault Quest — approved-artwork revision ledger (R4-OPS-02), Phase 7D.
 *
 * ISOLATION: `vq_`-prefixed, additive-only, own file. Ends overwrite-in-place for
 * approved art: every approve/upload writes a NEW immutable key
 * (vq/characters/{id}/approved/{slot}/{revisionId}.png, vq/art/{id}/{slot}/{rev}.png)
 * and records a row here with sha256 + size; the entity's existing pointer column
 * points at the active revision. Gives version history, integrity, backup state,
 * and a safe restore (pointer flip, never a byte overwrite).
 *
 * Matching migration: migrations-vq/0010_artwork_revisions.sql — additive,
 * idempotent, NOT applied by this branch (apply by hand; never drizzle-kit push).
 * Pure key/guard/hash/pointer logic: server/vault-quest/lib/vq-artwork-versioning.ts.
 * Rewiring the approve sites + the B2 backup worker is Category C/D.
 */
import { pgTable, text, integer, boolean, serial, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const VQ_REVISION_ENTITY_TYPES = ["character", "card"] as const;
export const VQ_REVISION_BACKUP_STATES = ["pending", "archived", "failed"] as const;
export type VqRevisionBackupState = (typeof VQ_REVISION_BACKUP_STATES)[number];

export const vqArtworkRevisions = pgTable(
  "vq_artwork_revisions",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(), // 'character' | 'card'
    entityId: text("entity_id").notNull(), // characterId (GNV-F01-S1) or cardId
    slot: text("slot").notNull(), // reference_type (master_portrait, …) OR 'main'/'prev'
    r2Key: text("r2_key").notNull().unique(), // IMMUTABLE versioned key, never overwritten
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    mime: text("mime").notNull().default("image/png"),
    width: integer("width"),
    height: integer("height"),
    sourceCandidateId: integer("source_candidate_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
    backupState: text("backup_state").notNull().default("pending"), // pending | archived | failed
    archivedAt: timestamp("archived_at"),
  },
  (t) => ({
    entityIdx: index("vq_artwork_revisions_entity_idx").on(t.entityType, t.entityId, t.slot),
    // At most ONE active revision per (entity, slot) — DB-enforced, so a botched
    // pointer swap can never split-brain.
    activeUq: uniqueIndex("vq_artwork_revisions_active_uq")
      .on(t.entityType, t.entityId, t.slot)
      .where(sql`is_active = true`),
    backupIdx: index("vq_artwork_revisions_backup_idx").on(t.backupState),
    shaIdx: index("vq_artwork_revisions_sha_idx").on(t.sha256),
  }),
);

export type VqArtworkRevision = typeof vqArtworkRevisions.$inferSelect;
export type InsertVqArtworkRevision = typeof vqArtworkRevisions.$inferInsert;
export const insertVqArtworkRevisionSchema = createInsertSchema(vqArtworkRevisions).omit({ id: true, createdAt: true });

/**
 * Append-only audit log for revision lifecycle events (Phase 10A-6). Independent
 * of vqArtworkRevisions.isActive/archivedAt, which only reflect the LATEST
 * transition for a row — this answers "what happened, in what order, by whom"
 * across multiple activate/deactivate/restore cycles. Never UPDATEd/DELETEd.
 *
 * Matching migration: migrations-vq/0014_artwork_revision_events.sql.
 */
export const VQ_REVISION_EVENT_ACTIONS = [
  "created", "activated", "deactivated", "restored", "upload_failed", "commit_failed",
] as const;
export type VqRevisionEventAction = (typeof VQ_REVISION_EVENT_ACTIONS)[number];

export const vqArtworkRevisionEvents = pgTable(
  "vq_artwork_revision_events",
  {
    id: serial("id").primaryKey(),
    revisionId: integer("revision_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    slot: text("slot").notNull(),
    action: text("action").notNull(), // one of VQ_REVISION_EVENT_ACTIONS
    actor: text("actor"),
    note: text("note"),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index("vq_artwork_revision_events_entity_idx").on(t.entityType, t.entityId, t.slot, t.occurredAt),
    revisionIdx: index("vq_artwork_revision_events_revision_idx").on(t.revisionId),
  }),
);

export type VqArtworkRevisionEvent = typeof vqArtworkRevisionEvents.$inferSelect;
export type InsertVqArtworkRevisionEvent = typeof vqArtworkRevisionEvents.$inferInsert;
