/**
 * Vault Quest — emergency runtime feature flags (Phase 7E). VQ-only kill switches
 * that propagate to both Fly machines without a restart. A row ABSENT = default-ON,
 * so a missing/empty table never disables VQ. The env HARD-OFF vars
 * (VQ_GENERATION_DISABLED / VQ_EXPORTS_DISABLED / VQ_READONLY / VQ_PROVIDER_OUTAGE)
 * beat this table and work with no DB at all — see lib/vq-feature-state.ts.
 *
 * Matching migration: migrations-vq/0011_feature_flags.sql — additive, idempotent,
 * NOT applied by this branch (apply by hand; never drizzle-kit push). The reader
 * must soft-fail to {} when the table is absent (default-on preserved).
 */
import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const vqFeatureFlags = pgTable("vq_feature_flags", {
  feature: text("feature").primaryKey(), // 'generation' | 'exports' | 'writes'
  enabled: boolean("enabled").notNull(), // true=on, false=off; ROW ABSENT = default-on
  reason: text("reason"), // operator note
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type VqFeatureFlag = typeof vqFeatureFlags.$inferSelect;
export type InsertVqFeatureFlag = typeof vqFeatureFlags.$inferInsert;
export const insertVqFeatureFlagSchema = createInsertSchema(vqFeatureFlags);
