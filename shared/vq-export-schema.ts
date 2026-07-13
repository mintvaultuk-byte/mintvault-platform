/**
 * Vault Quest — durable export jobs (INFRA-01 / OPEN-27), Phase 7A.
 *
 * ISOLATION: `vq_`-prefixed, additive-only, its own file. Replaces the in-process
 * `JOBS` Map (which fails ~50% on 2-machine Fly prod when poll/download land on a
 * different machine than the POST — the exact bug already fixed for magic-links by
 * moving them to Postgres). Job STATE lives here; output BYTES live in R2 under
 * `vq/exports/{jobId}/…`. Any machine can serve poll/download.
 *
 * The matching migration is migrations-vq/0008_export_jobs.sql — additive
 * (CREATE TABLE IF NOT EXISTS) and NOT applied by this branch. Export code must
 * degrade gracefully when the table is absent (the existing `safe()`/42P01
 * pattern), so the app boots and non-VQ is unaffected until the migration is
 * hand-applied to the VQ DB (never `drizzle-kit push`). Pure state/idempotency
 * logic lives in server/vault-quest/lib/export-job-state.ts (unit-tested).
 */
import { pgTable, text, integer, bigint, timestamp, uuid, serial, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const VQ_EXPORT_STATES = [
  "queued", "processing", "partial", "completed", "failed", "cancelled", "expired",
] as const;

export const vqExportJobs = pgTable(
  "vq_export_jobs",
  {
    id: serial("id").primaryKey(),
    jobId: uuid("job_id").notNull().defaultRandom(), // public handle used by poll/download
    kind: text("kind").notNull(), // 'pack' | 'proxy'
    ownerAdminId: text("owner_admin_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(), // hash(kind|owner|sorted ids)
    state: text("state").notNull().default("queued"),
    ids: jsonb("ids").$type<string[]>(), // requested card/item ids — a reclaiming machine needs these to render (0012)
    attemptCount: integer("attempt_count").notNull().default(0), // bounded requeue guard (0012)
    requestedCount: integer("requested_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    outputKey: text("output_key"), // vq/exports/{jobId}/<file>
    outputHash: text("output_hash"), // sha256 hex of the final artifact
    outputSize: bigint("output_size", { mode: "number" }),
    contentType: text("content_type"),
    fileName: text("file_name"),
    errorCode: text("error_code"), // machine-stable classifier
    errorMessage: text("error_message"), // safe — no paths/secrets
    workerMachine: text("worker_machine"), // FLY_MACHINE_ID holding the lease
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => ({
    jobIdUq: uniqueIndex("vq_export_jobs_job_id_uq").on(t.jobId),
    // At most ONE active job per (kind, owner, id-set); terminal rows may repeat.
    idemActiveUq: uniqueIndex("vq_export_jobs_idem_active_uq")
      .on(t.idempotencyKey)
      .where(sql`state IN ('queued','processing')`),
    stateExp: index("vq_export_jobs_state_expires_idx").on(t.state, t.expiresAt),
    stateLease: index("vq_export_jobs_state_lease_idx").on(t.state, t.leaseExpiresAt),
    owner: index("vq_export_jobs_owner_idx").on(t.ownerAdminId, t.createdAt),
  }),
);

export type VqExportJob = typeof vqExportJobs.$inferSelect;
export type InsertVqExportJob = typeof vqExportJobs.$inferInsert;
export const insertVqExportJobSchema = createInsertSchema(vqExportJobs).omit({ id: true, createdAt: true });
