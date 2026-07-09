/**
 * Vault Quest — database schema (Phase 1a).
 *
 * ISOLATION: every table is prefixed `vq_`. This file is the ONLY schema Vault
 * Quest touches. It is pushed with a SEPARATE config (`drizzle-vq.config.ts`,
 * `tablesFilter: ["vq_*"]`) so a migration physically cannot alter any grading
 * table. `shared/schema.ts` and `drizzle.config.ts` are never touched by VQ.
 *
 * Phase 1a ships schema + storage only — no route imports this yet, so nothing
 * customer-facing changes.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  serial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod";

/** A set (one row for Genesis Vault). */
export const vqSets = pgTable("vq_sets", {
  id: serial("id").primaryKey(),
  setCode: text("set_code").notNull().unique(),
  name: text("name").notNull(),
  year: integer("year").notNull(),
  edition: text("edition").notNull(),
  rulesVersion: text("rules_version").notNull().default("v0.1"),
  cardCount: integer("card_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Evolution families (the 18 Genesis Vault lines). Drives the prev-stage join. */
export const vqFamilies = pgTable(
  "vq_families",
  {
    id: serial("id").primaryKey(),
    familyId: text("family_id").notNull().unique(),
    setCode: text("set_code").notNull().default("GNV"),
    element: text("element").notNull(),
    name: text("name").notNull(),
    stage1Name: text("stage1_name"),
    stage2Name: text("stage2_name"),
    stage3Name: text("stage3_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ setIdx: index("vq_families_set_idx").on(t.setCode) }),
);

/** The core card table — one row per card (creature or support). */
export const vqCards = pgTable(
  "vq_cards",
  {
    id: serial("id").primaryKey(),
    cardId: text("card_id").notNull().unique(), // GNV-001
    collectorNumber: text("collector_number").notNull(), // 001/090
    name: text("name").notNull(),
    displayName: text("display_name"),
    cardType: text("card_type").notNull(), // Creature | Tactic | Relic | Vault
    element: text("element").notNull(),
    rarity: text("rarity"),
    // creature-only (null on support cards)
    familyId: text("family_id"),
    stageNumber: integer("stage_number"),
    lifeStage: text("life_stage"),
    health: integer("health"),
    guard: integer("guard"),
    shift: integer("shift"),
    attack1Name: text("attack1_name"),
    attack1Cost: integer("attack1_cost"),
    attack1Damage: integer("attack1_damage"),
    attack1Effect: text("attack1_effect"),
    attack2Name: text("attack2_name"),
    attack2Cost: integer("attack2_cost"),
    attack2Damage: integer("attack2_damage"),
    attack2Effect: text("attack2_effect"),
    vulnerability: text("vulnerability"),
    keywords: jsonb("keywords").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // dormant — the audit's future Oracle Round-Trip Gate lives here; nothing reads it in Phase 1
    effects: jsonb("effects"),
    // artwork + render (R2 keys; served by card id, never raw key)
    artR2Key: text("art_r2_key"),
    prevArtR2Key: text("prev_art_r2_key"),
    renderR2Key: text("render_r2_key"),
    // variant model (150-card commercial set = base cards + alt-rarity variants)
    variantTier: text("variant_tier"), // STANDARD | SRA | CHR | FSR | UR | CR | ...
    baseCardId: text("base_card_id"), // for a variant: its base card's card_id (gameplay inherited unless overridden)
    // locked constants (defaults, still stored per row for export parity)
    setCode: text("set_code").notNull().default("GNV"),
    language: text("language").notNull().default("EN"),
    year: integer("year").notNull().default(2026),
    edition: text("edition").notNull().default("FIRST EDITION"),
    // draft -> approved (QA clean) -> published (reaches exports/public)
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    setStatusIdx: index("vq_cards_set_status_idx").on(t.setCode, t.status),
    elementIdx: index("vq_cards_element_idx").on(t.element),
    typeIdx: index("vq_cards_type_idx").on(t.cardType),
  }),
);

/** Automatic snapshot on every card save — the git-diff substitute for DB-edited cards. */
export const vqCardRevisions = pgTable(
  "vq_card_revisions",
  {
    id: serial("id").primaryKey(),
    cardId: text("card_id").notNull(),
    revisionJson: jsonb("revision_json").notNull(),
    editedBy: text("edited_by"),
    editedAt: timestamp("edited_at").notNull().defaultNow(),
  },
  (t) => ({ cardIdx: index("vq_card_revisions_card_idx").on(t.cardId) }),
);

/**
 * Audit log for every Card Studio AI suggestion. AI output is preview-only and is
 * never auto-applied to a card — this table records what was generated (provider,
 * model, prompt, output) and whether the admin later clicked Apply, so AI content
 * is never a black box. Additive + isolated; touches no card row.
 */
export const vqAiGenerations = pgTable(
  "vq_ai_generations",
  {
    id: serial("id").primaryKey(),
    cardId: text("card_id"), // nullable — a card being created may have no id yet
    kind: text("kind").notNull(), // name | family-names | gameplay | flavour | artwork-prompt
    mode: text("mode"), // sub-mode: cuter | stronger | attack1 | main | …
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    generatedBy: text("generated_by"),
    prompt: text("prompt"),
    output: jsonb("output"),
    applied: boolean("applied").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ cardIdx: index("vq_ai_generations_card_idx").on(t.cardId) }),
);
export type VqAiGeneration = typeof vqAiGenerations.$inferSelect;
export type InsertVqAiGeneration = typeof vqAiGenerations.$inferInsert;

/** Element palette + crest key (seeded from elements.json). */
export const vqElements = pgTable("vq_elements", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  border: text("border").notNull(),
  accent: text("accent").notNull(),
  dark: text("dark").notNull(),
  crestKey: text("crest_key"),
});

/** Rules constants (deck_size, seal_count, rules_version, …). */
export const vqGameConfig = pgTable("vq_game_config", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

/** Published snapshots — compiled cards.json in R2 that public pages read (Phase 1d). */
export const vqReleases = pgTable(
  "vq_releases",
  {
    id: serial("id").primaryKey(),
    version: text("version").notNull().unique(),
    setCode: text("set_code").notNull().default("GNV"),
    cardsJsonR2Key: text("cards_json_r2_key").notNull(),
    cardCount: integer("card_count").notNull().default(0),
    isCurrent: boolean("is_current").notNull().default(false),
    publishedAt: timestamp("published_at").notNull().defaultNow(),
  },
  (t) => ({ currentIdx: uniqueIndex("vq_releases_current_idx").on(t.setCode).where(sql`${t.isCurrent}`) }),
);

// ---- insert schemas + types (drizzle-zod, matching shared/schema.ts convention) ----
export const insertVqSetSchema = createInsertSchema(vqSets).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqFamilySchema = createInsertSchema(vqFamilies).omit({ id: true, createdAt: true });
export const insertVqCardSchema = createInsertSchema(vqCards).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqElementSchema = createInsertSchema(vqElements).omit({ id: true });
export const insertVqGameConfigSchema = createInsertSchema(vqGameConfig).omit({ id: true });
export const insertVqReleaseSchema = createInsertSchema(vqReleases).omit({ id: true, publishedAt: true });

export type VqSet = typeof vqSets.$inferSelect;
export type VqFamily = typeof vqFamilies.$inferSelect;
export type VqCardRow = typeof vqCards.$inferSelect;
export type VqCardRevision = typeof vqCardRevisions.$inferSelect;
export type VqElementRow = typeof vqElements.$inferSelect;
export type VqGameConfigRow = typeof vqGameConfig.$inferSelect;
export type VqRelease = typeof vqReleases.$inferSelect;

export type InsertVqCard = z.infer<typeof insertVqCardSchema>;
export type InsertVqFamily = z.infer<typeof insertVqFamilySchema>;
export type InsertVqSet = z.infer<typeof insertVqSetSchema>;
