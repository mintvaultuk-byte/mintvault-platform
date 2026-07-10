/**
 * Vault Quest — Genesis Production Studio schema (Phase 4).
 *
 * ISOLATION: every table is prefixed `vq_`, additive-only, in its own file so the
 * core vq-schema.ts stays untouched. Powers the set-centric production pipeline:
 * set settings, production-stage state, packaging, pack config, print exports, QA
 * checks, release, and the approved-asset library. Nothing here touches grading.
 *
 * The matching migration is migrations-vq/0007_production_studio.sql. It is
 * additive (CREATE TABLE IF NOT EXISTS) and is NOT applied to any database by
 * this branch — the Studio degrades gracefully when these tables are absent.
 */
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  serial,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// ── Shared production vocab ──────────────────────────────────────────────────
export const PRODUCTION_STAGE_STATES = [
  "not_started",
  "in_progress",
  "needs_review",
  "approved",
  "locked",
  "completed",
] as const;
export type ProductionStageState = (typeof PRODUCTION_STAGE_STATES)[number];

/** The permanent 10-stage production pipeline, in order. Later stages lock until
 *  their prerequisite (the previous stage) is complete. */
export const PRODUCTION_STAGES = [
  { key: "set_setup", title: "Set Setup", stage: 1 },
  { key: "characters", title: "Characters", stage: 2 },
  { key: "families", title: "Families", stage: 3 },
  { key: "standard_cards", title: "Standard Cards", stage: 4 },
  { key: "support_cards", title: "Support Cards", stage: 5 },
  { key: "variant_cards", title: "Variant Cards", stage: 6 },
  { key: "packaging", title: "Packaging", stage: 7 },
  { key: "print_files", title: "Print Files", stage: 8 },
  { key: "qa", title: "QA", stage: 9 },
  { key: "release", title: "Release", stage: 10 },
] as const;
export type ProductionStageKey = (typeof PRODUCTION_STAGES)[number]["key"];

export const PACKAGING_TYPES = [
  "booster_wrapper",
  "booster_box",
  "starter_deck",
  "elite_box",
  "promo_pack",
  "shipping_carton",
] as const;
export type PackagingType = (typeof PACKAGING_TYPES)[number];

export const PRINT_EXPORT_TYPES = ["cards", "wrappers", "boxes", "rule_books", "tokens", "stickers", "posters"] as const;
export const ASSET_CATEGORIES = [
  "characters",
  "backgrounds",
  "logos",
  "effects",
  "textures",
  "fonts",
  "icons",
  "pack_art",
  "templates",
  "print_files",
] as const;
export const QA_CHECKLIST_ITEMS = [
  "dimensions",
  "bleed",
  "resolution",
  "colour_profile",
  "fonts",
  "grammar",
  "card_numbers",
  "artwork",
  "packaging",
  "barcode",
  "legal",
] as const;

// ── Tables ───────────────────────────────────────────────────────────────────

/** Per-set production settings (locked after approval). One row per set. */
export const vqSetSettings = pgTable("vq_set_settings", {
  id: serial("id").primaryKey(),
  setCode: text("set_code").notNull().unique(),
  name: text("name"),
  code: text("code"),
  releaseYear: integer("release_year"),
  cardCount: integer("card_count"),
  elements: jsonb("elements").$type<string[]>(),
  rarityStructure: jsonb("rarity_structure").$type<{ code: string; label: string; perPack?: number }[]>(),
  fonts: jsonb("fonts").$type<{ role: string; family: string }[]>(),
  colourPalette: jsonb("colour_palette").$type<{ name: string; hex: string }[]>(),
  setLogoR2Key: text("set_logo_r2_key"),
  boosterSize: integer("booster_size"),
  cardsPerPack: integer("cards_per_pack"),
  description: text("description"),
  locked: boolean("locked").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Manual production-stage state overrides / notes. Most stage state is DERIVED
 *  from real data; this stores explicit approvals/locks/reviews a founder sets. */
export const vqProductionStages = pgTable(
  "vq_production_stages",
  {
    id: serial("id").primaryKey(),
    setCode: text("set_code").notNull(),
    stageKey: text("stage_key").notNull(),
    status: text("status").notNull().default("not_started"),
    note: text("note"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ setStageIdx: index("vq_prod_stage_set_idx").on(t.setCode, t.stageKey) }),
);

/** Packaging Studio items (wrapper, box, starter, elite, promo, carton). */
export const vqPackagingItems = pgTable(
  "vq_packaging_items",
  {
    id: serial("id").primaryKey(),
    setCode: text("set_code").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    artworkR2Key: text("artwork_r2_key"),
    mockupR2Key: text("mockup_r2_key"),
    printPdfR2Key: text("print_pdf_r2_key"),
    dielineR2Key: text("dieline_r2_key"),
    status: text("status").notNull().default("not_started"),
    approvalStatus: text("approval_status").notNull().default("draft"),
    locked: boolean("locked").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ setIdx: index("vq_packaging_set_idx").on(t.setCode) }),
);

/** Pack configuration — separated from packaging ARTWORK. */
export const vqPackConfig = pgTable(
  "vq_pack_config",
  {
    id: serial("id").primaryKey(),
    setCode: text("set_code").notNull(),
    name: text("name").notNull().default("Standard Booster"),
    cardsPerPack: integer("cards_per_pack"),
    guaranteedRarity: text("guaranteed_rarity"),
    variantSlots: integer("variant_slots"),
    holoSlots: integer("holo_slots"),
    cardPool: jsonb("card_pool").$type<string[]>(),
    duplicateRules: text("duplicate_rules"),
    sku: text("sku"),
    barcode: text("barcode"),
    wrapperVersion: text("wrapper_version"),
    printQuantity: integer("print_quantity"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ setIdx: index("vq_pack_config_set_idx").on(t.setCode) }),
);

/** Print Studio production exports. */
export const vqPrintExports = pgTable(
  "vq_print_exports",
  {
    id: serial("id").primaryKey(),
    setCode: text("set_code").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull().default("draft"),
    fileR2Key: text("file_r2_key"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ setIdx: index("vq_print_exports_set_idx").on(t.setCode) }),
);

/** QA Studio checks — one per asset under review. */
export const vqQaChecks = pgTable(
  "vq_qa_checks",
  {
    id: serial("id").primaryKey(),
    setCode: text("set_code").notNull(),
    assetType: text("asset_type").notNull(),
    assetRef: text("asset_ref").notNull(),
    checklist: jsonb("checklist").$type<Record<string, boolean>>(),
    status: text("status").notNull().default("not_started"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ setIdx: index("vq_qa_checks_set_idx").on(t.setCode) }),
);

/** Release Manager state — one row per set. */
export const vqReleaseState = pgTable("vq_release_state", {
  id: serial("id").primaryKey(),
  setCode: text("set_code").notNull().unique(),
  cardsComplete: boolean("cards_complete").notNull().default(false),
  packagingComplete: boolean("packaging_complete").notNull().default(false),
  qaPassed: boolean("qa_passed").notNull().default(false),
  printReady: boolean("print_ready").notNull().default(false),
  releaseDate: text("release_date"),
  printQuantity: integer("print_quantity"),
  revisionNumber: integer("revision_number").notNull().default(1),
  finalExportR2Key: text("final_export_r2_key"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Approved-asset library — catalogue of reusable, approved assets. */
export const vqAssetLibrary = pgTable(
  "vq_asset_library",
  {
    id: serial("id").primaryKey(),
    setCode: text("set_code").notNull(),
    category: text("category").notNull(),
    name: text("name").notNull(),
    r2Key: text("r2_key"),
    approved: boolean("approved").notNull().default(false),
    sourceType: text("source_type"),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ setCatIdx: index("vq_asset_library_set_cat_idx").on(t.setCode, t.category) }),
);

// ── insert schemas + types ───────────────────────────────────────────────────
export const insertVqSetSettingsSchema = createInsertSchema(vqSetSettings).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqPackagingItemSchema = createInsertSchema(vqPackagingItems).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqPackConfigSchema = createInsertSchema(vqPackConfig).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqPrintExportSchema = createInsertSchema(vqPrintExports).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqQaCheckSchema = createInsertSchema(vqQaChecks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqReleaseStateSchema = createInsertSchema(vqReleaseState).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqAssetSchema = createInsertSchema(vqAssetLibrary).omit({ id: true, createdAt: true, updatedAt: true });

export type VqSetSettings = typeof vqSetSettings.$inferSelect;
export type VqPackagingItem = typeof vqPackagingItems.$inferSelect;
export type VqPackConfig = typeof vqPackConfig.$inferSelect;
export type VqPrintExport = typeof vqPrintExports.$inferSelect;
export type VqQaCheck = typeof vqQaChecks.$inferSelect;
export type VqReleaseState = typeof vqReleaseState.$inferSelect;
export type VqAsset = typeof vqAssetLibrary.$inferSelect;
export type VqProductionStageRow = typeof vqProductionStages.$inferSelect;
