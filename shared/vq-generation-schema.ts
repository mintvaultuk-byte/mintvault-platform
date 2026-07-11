/**
 * Vault Quest — paid-generation idempotency & spend ledger (PROV-01..07), Phase 7B.
 *
 * ISOLATION: `vq_`-prefixed, additive-only, own file. One row per logical
 * generation request (client-minted idempotency key), enforcing exactly-one paid
 * provider `create` per action across the 2 Fly machines, persisting the provider
 * jobId the instant it exists (so a success-then-failure is recoverable, PROV-03/04),
 * and providing the cross-machine spend window for server-side ceilings (PROV-07).
 *
 * Matching migration: migrations-vq/0009_generation_requests.sql — additive,
 * idempotent, NOT applied by this branch (apply by hand to the VQ DB; never
 * drizzle-kit push). Pure decision logic is in
 * server/vault-quest/lib/generation-idempotency.ts (unit-tested). Wiring the live
 * generation routes to this table is Category C.
 */
import { pgTable, text, integer, numeric, serial, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const vqGenerationRequests = pgTable(
  "vq_generation_requests",
  {
    id: serial("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(), // client UUID, stable across retries
    requestFingerprint: text("request_fingerprint").notNull(), // sha256 of normalized payload
    adminId: text("admin_id"),
    setCode: text("set_code"),
    characterId: text("character_id"),
    cardId: text("card_id"),
    familyId: text("family_id"),
    stageId: text("stage_id"),
    generationType: text("generation_type").notNull(),
    modelRequested: text("model_requested"),
    modelUsed: text("model_used"), // provider may upgrade z_image→nano_banana
    requestedCount: integer("requested_count").notNull().default(1),
    maxAuthorisedSpend: numeric("max_authorised_spend", { precision: 10, scale: 2 }).notNull(),
    estimatedCredits: numeric("estimated_credits", { precision: 10, scale: 2 }).notNull().default("0"),
    providerReportedCredits: numeric("provider_reported_credits", { precision: 10, scale: 2 }), // authoritative
    chargedCredits: numeric("charged_credits", { precision: 10, scale: 2 }).notNull().default("0"),
    state: text("state").notNull().default("received"),
    providerJobId: text("provider_job_id"), // persisted the instant create returns
    providerRequestId: text("provider_request_id"),
    candidateId: integer("candidate_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    errorClass: text("error_class"),
    lastError: text("last_error"),
    retryAfter: timestamp("retry_after"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    idemUq: uniqueIndex("vq_gen_req_idem_uq").on(t.idempotencyKey), // one winner per action
    spendIdx: index("vq_gen_req_spend_idx").on(t.createdAt), // hourly/daily windows
    stateIdx: index("vq_gen_req_state_idx").on(t.state),
    jobIdx: index("vq_gen_req_job_idx").on(t.providerJobId), // recover-by-jobId
  }),
);

export type VqGenerationRequest = typeof vqGenerationRequests.$inferSelect;
export type InsertVqGenerationRequest = typeof vqGenerationRequests.$inferInsert;
export const insertVqGenerationRequestSchema = createInsertSchema(vqGenerationRequests).omit({ id: true, createdAt: true });
