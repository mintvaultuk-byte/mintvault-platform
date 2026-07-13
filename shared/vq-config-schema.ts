/**
 * Vault Quest — minimal key/value config store (Phase 10A D4). VQ-only; holds spend
 * ceilings + operational values ONLY (no grading/payment/global config). Absence of
 * the table or a row degrades to conservative code defaults (server/vault-quest/lib/
 * vq-config.ts). Migration: migrations-vq/0013_vq_config.sql (local-only in 10A).
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const vqConfig = pgTable("vq_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  description: text("description"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type VqConfigRow = typeof vqConfig.$inferSelect;
export type InsertVqConfigRow = typeof vqConfig.$inferInsert;
export const insertVqConfigSchema = createInsertSchema(vqConfig);
