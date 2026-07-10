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
    // Workflow status — the authoritative vocabulary is VQ_STATUSES in
    // shared/vq-workflow.ts (draft → … → export_ready/printed_proxy); every write
    // goes through setCardStatusAudited, gated by isVqStatus + canTransition.
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

/** Permanent creature identity registry. One row per base stage creature. */
export const vqCharacters = pgTable(
  "vq_characters",
  {
    id: serial("id").primaryKey(),
    characterId: text("character_id").notNull().unique(), // GNV-F01-S1
    setCode: text("set_code").notNull().default("GNV"),
    familyId: text("family_id").notNull(),
    familyName: text("family_name"),
    cardId: text("card_id").notNull().unique(), // base card for this stage
    stageNumber: integer("stage_number").notNull(),
    characterName: text("character_name").notNull(),
    element: text("element").notNull(),
    role: text("role"),
    variantCardIds: jsonb("variant_card_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    evolvesFromCharacterId: text("evolves_from_character_id"),
    sourceNotes: text("source_notes"),
    characterDna: text("character_dna"),
    visualDescription: text("visual_description"),
    bodyShape: text("body_shape"),
    colours: text("colours"),
    markings: text("markings"),
    eyes: text("eyes"),
    tailAccessories: text("tail_accessories"),
    personality: text("personality"),
    stageProgressionNotes: text("stage_progression_notes"),
    elementIdentity: text("element_identity"),
    negativePrompt: text("negative_prompt"),
    masterArtworkPrompt: text("master_artwork_prompt"),
    referenceArtworkR2Key: text("reference_artwork_r2_key"),
    approvedArtworkR2Key: text("approved_artwork_r2_key"),
    // Reference Pack: per-type approved reference artwork (master_portrait, action_pose, …).
    // TCG needs master_portrait + action_pose; the rest are future game/3D-ready extras.
    referencePack: jsonb("reference_pack").$type<VqReferencePack>().notNull().default(sql`'{}'::jsonb`),
    // Future game/3D/merch asset slots — metadata only, nothing reads it yet.
    gameMetadata: jsonb("game_metadata").$type<VqGameMetadata>().notNull().default(sql`'{}'::jsonb`),
    // Description workflow: draft → approved (→ needs_review when DNA edited after approval).
    // Artwork generation requires an APPROVED description — text before pixels.
    descriptionStatus: text("description_status").notNull().default("draft"),
    approvalStatus: text("approval_status").notNull().default("draft"),
    locked: boolean("locked").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index("vq_characters_family_idx").on(t.familyId),
    setIdx: index("vq_characters_set_idx").on(t.setCode),
    familyStageUq: uniqueIndex("vq_characters_family_stage_uq").on(t.familyId, t.stageNumber),
  }),
);

// ── Reference Pack (Character Bible) ─────────────────────────────────────────
// One approved reference image per TYPE. The 2D TCG requires only the first two;
// the rest keep the data model ready for a future game/plush/3D pipeline without
// overbuilding now. Shared so client + server agree on values and completeness.
export const VQ_REFERENCE_TYPES = [
  { value: "master_portrait", label: "Master Reference", tier: "required" },
  { value: "action_pose", label: "Action Pose", tier: "required" },
  { value: "face_closeup", label: "Face Close-up", tier: "recommended" },
  { value: "colour_sheet", label: "Colour Sheet", tier: "recommended" },
  { value: "turnaround_sheet", label: "Turnaround Sheet", tier: "optional" },
] as const;
export type VqReferenceType = (typeof VQ_REFERENCE_TYPES)[number]["value"];
export const VQ_REQUIRED_REFERENCE_TYPES: VqReferenceType[] = ["master_portrait", "action_pose"];
export type VqReferencePack = Partial<
  Record<VqReferenceType, { r2Key: string; candidateId?: number | null; approvedAt?: string; identityScore?: number | null }>
>;

/**
 * Future-game metadata slots (Phase 2 — METADATA ONLY, no gameplay). Reserved keys
 * so a future game/3D/merch pipeline can attach assets without a schema change:
 * idle/walk/run/jump/attack/hurt/celebrate animations, portrait, inventoryIcon,
 * model3d, voiceProfile, soundEffects, npcDialogue. All optional; empty by default.
 */
export type VqGameMetadata = Partial<{
  idleAnimation: string;
  walkAnimation: string;
  runAnimation: string;
  jumpAnimation: string;
  attackAnimation: string;
  hitAnimation: string;
  deathAnimation: string;
  hurtAnimation: string;
  celebrateAnimation: string;
  portrait: string;
  icon: string;
  inventoryIcon: string;
  spriteSheet: string;
  model3d: string;
  voiceProfile: string;
  soundEffects: string[];
  lore: string;
  npcDialogue: string[];
  aiBehaviour: string;
  spawnRules: string;
  evolutionTrigger: string;
  statGrowth: string;
}>;
// ── Image generation model choices ──────────────────────────────────────────
// creditsPerImage is a DISPLAY estimate (never billed). refCapable = supports
// image_references (the Phase-2 identity lock); z_image does NOT, so referenced
// generations auto-upgrade it to nano_banana server-side.
export const VQ_IMAGE_MODELS = [
  { value: "z_image", label: "Cheap / Fast", provider: "higgsfield", creditsPerImage: 0.15, refCapable: false },
  { value: "nano_banana", label: "Nano Banana", provider: "higgsfield", creditsPerImage: 1, refCapable: true },
  { value: "nano_banana_pro", label: "Nano Banana Pro", provider: "higgsfield", creditsPerImage: 2, refCapable: true },
] as const;
export type VqImageModel = (typeof VQ_IMAGE_MODELS)[number]["value"];
export const VQ_QUALITY_MODEL: Record<"draft" | "standard" | "premium", VqImageModel> = {
  draft: "z_image", standard: "nano_banana", premium: "nano_banana_pro",
};
export function vqCreditsPerImage(model: string): number {
  return VQ_IMAGE_MODELS.find((m) => m.value === model)?.creditsPerImage ?? 2;
}
export function vqModelRefCapable(model: string): boolean {
  return VQ_IMAGE_MODELS.find((m) => m.value === model)?.refCapable ?? true;
}
/**
 * Display-estimate of the credits a generate response actually cost.
 * Counts EVERY billed image — auto-rejected (identity drift) and bg-rejected images
 * were generated and charged too — at the model the server ACTUALLY used (an attached
 * reference silently upgrades z_image → nano_banana), falling back to the requested
 * model. Prevents the on-screen spend tiles from under-reporting real spend.
 */
export function vqChargedCredits(
  resp: { created?: { model?: string | null }[] | null; autoRejected?: number | null; bgRejected?: number | null },
  fallbackModel: string,
): number {
  const made = resp.created?.length ?? 0;
  const billedImages = made + (resp.autoRejected ?? 0) + (resp.bgRejected ?? 0);
  const effModel = resp.created?.[0]?.model ?? fallbackModel;
  return billedImages * vqCreditsPerImage(effModel);
}
export function vqValidImageModel(model: string | undefined): VqImageModel | undefined {
  return VQ_IMAGE_MODELS.find((m) => m.value === model)?.value;
}

/** Pack completeness for the TCG workflow: required types only (turnaround never required). */
export function vqPackCompleteness(pack: VqReferencePack | null | undefined): "missing" | "partial" | "complete" {
  const p = pack ?? {};
  const haveRequired = VQ_REQUIRED_REFERENCE_TYPES.filter((t) => p[t]?.r2Key).length;
  if (haveRequired === VQ_REQUIRED_REFERENCE_TYPES.length) return "complete";
  const haveAny = Object.values(p).some((v) => v?.r2Key);
  return haveAny ? "partial" : "missing";
}

/** Revision log for Character Bible edits. */
export const vqCharacterRevisions = pgTable(
  "vq_character_revisions",
  {
    id: serial("id").primaryKey(),
    characterId: text("character_id").notNull(),
    revisionJson: jsonb("revision_json").notNull(),
    editedBy: text("edited_by"),
    reason: text("reason"),
    editedAt: timestamp("edited_at").notNull().defaultNow(),
  },
  (t) => ({ characterIdx: index("vq_character_revisions_character_idx").on(t.characterId) }),
);

/** Artwork generated or uploaded for review. Candidates are never approved artwork. */
export const vqArtworkCandidates = pgTable(
  "vq_artwork_candidates",
  {
    id: serial("id").primaryKey(),
    characterId: text("character_id"),
    cardId: text("card_id"),
    slot: text("slot").notNull().default("main"),
    // Which Reference Pack slot this candidate targets (master_portrait, action_pose, …).
    referenceType: text("reference_type").notNull().default("master_portrait"),
    // Character Identity Score (0-100) vs the approved references + per-trait breakdown.
    // Null = not scored (bootstrap generation with nothing to compare against).
    identityScore: integer("identity_score"),
    identityBreakdown: jsonb("identity_breakdown"),
    source: text("source").notNull().default("generated"),
    provider: text("provider"),
    model: text("model"),
    prompt: text("prompt"),
    r2Key: text("r2_key").notNull().unique(),
    width: integer("width"),
    height: integer("height"),
    status: text("status").notNull().default("candidate"),
    aiGenerationId: integer("ai_generation_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    characterIdx: index("vq_artwork_candidates_character_idx").on(t.characterId),
    cardIdx: index("vq_artwork_candidates_card_idx").on(t.cardId),
    statusIdx: index("vq_artwork_candidates_status_idx").on(t.status),
  }),
);

/** Family-level guardrails for future gameplay generation. */
export const vqFamilyRules = pgTable(
  "vq_family_rules",
  {
    id: serial("id").primaryKey(),
    familyId: text("family_id").notNull().unique(),
    element: text("element").notNull(),
    allowedAttackThemes: jsonb("allowed_attack_themes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    forbiddenAttackTerms: jsonb("forbidden_attack_terms").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    statProfile: jsonb("stat_profile"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ elementIdx: index("vq_family_rules_element_idx").on(t.element) }),
);

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
export const insertVqCharacterSchema = createInsertSchema(vqCharacters).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqArtworkCandidateSchema = createInsertSchema(vqArtworkCandidates).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVqFamilyRuleSchema = createInsertSchema(vqFamilyRules).omit({ id: true, createdAt: true, updatedAt: true });

export type VqSet = typeof vqSets.$inferSelect;
export type VqFamily = typeof vqFamilies.$inferSelect;
export type VqCardRow = typeof vqCards.$inferSelect;
export type VqCardRevision = typeof vqCardRevisions.$inferSelect;
export type VqCharacter = typeof vqCharacters.$inferSelect;
export type VqCharacterRevision = typeof vqCharacterRevisions.$inferSelect;
export type VqArtworkCandidate = typeof vqArtworkCandidates.$inferSelect;
export type VqFamilyRule = typeof vqFamilyRules.$inferSelect;
export type VqElementRow = typeof vqElements.$inferSelect;
export type VqGameConfigRow = typeof vqGameConfig.$inferSelect;
export type VqRelease = typeof vqReleases.$inferSelect;

export type InsertVqCard = z.infer<typeof insertVqCardSchema>;
export type InsertVqFamily = z.infer<typeof insertVqFamilySchema>;
export type InsertVqSet = z.infer<typeof insertVqSetSchema>;
export type InsertVqCharacter = z.infer<typeof insertVqCharacterSchema>;
export type InsertVqArtworkCandidate = z.infer<typeof insertVqArtworkCandidateSchema>;
export type InsertVqFamilyRule = z.infer<typeof insertVqFamilyRuleSchema>;
