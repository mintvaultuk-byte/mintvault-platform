/**
 * Vault Quest storage layer (Phase 1a).
 *
 * The ONLY VQ file that touches the database. It imports the shared `db` pool
 * (server/db.ts) and the vq_ tables (shared/vq-schema.ts) — nothing from the
 * grading storage layer, and nothing here is imported by a route yet, so no
 * customer-facing surface changes in 1a.
 *
 * Card writes always snapshot into vq_card_revisions first (the git-diff
 * substitute for a DB-edited card).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  vqCards,
  vqCardRevisions,
  vqCharacters,
  vqCharacterRevisions,
  vqArtworkCandidates,
  vqFamilyRules,
  vqFamilies,
  vqSets,
  vqElements,
  vqGameConfig,
  vqReleases,
  vqAiGenerations,
  type InsertVqCard,
  type InsertVqFamily,
  type InsertVqSet,
  type VqCardRow,
  type VqFamily,
  type VqRelease,
  type InsertVqAiGeneration,
  type InsertVqArtworkCandidate,
  type InsertVqCharacter,
  type VqElementRow,
  type VqCharacter,
  type VqArtworkCandidate,
  type VqReferenceType,
} from "@shared/vq-schema";
import { referencePackMergeJson } from "./lib/write-sanitize";

export interface CardFilter {
  setCode?: string;
  status?: string;
  cardType?: string;
  element?: string;
}

const CANONICAL_FAMILY_IDS = new Set([
  "GNV-F01", "GNV-F02", "GNV-F03", "GNV-F04", "GNV-F05", "GNV-F06",
  "GNV-F07", "GNV-F08", "GNV-F09", "GNV-F10", "GNV-F11", "GNV-F12",
]);

const FAMILY_SEED_NOTES: Record<string, { vibe: string; source: string }> = {
  "GNV-F01": { vibe: "Energetic / Loyal / Brave", source: "Approved Family 01 sheet" },
  "GNV-F02": { vibe: "Calm / Loyal / Playful", source: "Approved Family 02 sheet" },
  "GNV-F03": { vibe: "Gentle / Natural / Nurturing", source: "Approved Family 03 sheet" },
  "GNV-F04": { vibe: "Energetic / Bold / Electric", source: "Approved Family 04 sheet" },
  "GNV-F05": { vibe: "Steady / Strong / Loyal", source: "Approved Family 05 sheet" },
  "GNV-F06": { vibe: "Mystical / Wise / Dreamy", source: "Generated Family 06 sheet - Option B update" },
  "GNV-F07": { vibe: "Free / Agile / Playful", source: "Generated Family 07 sheet - Option B update" },
  "GNV-F08": { vibe: "Energetic / Bold / Confident", source: "Generated Family 08 sheet - Option B update" },
  "GNV-F09": { vibe: "Calm / Wise / Resilient", source: "Generated Family 09 sheet - Option B update" },
  "GNV-F10": { vibe: "Mysterious / Sneaky / Loyal", source: "Generated Family 10 sheet - Option B update" },
  "GNV-F11": { vibe: "Steady / Strong / Nurturing", source: "Generated Family 11 sheet - Option B update" },
  "GNV-F12": { vibe: "Adaptable / Playful / Fluid", source: "Generated Family 12 sheet - Option B update" },
};

function characterIdFor(familyId: string, stageNumber: number): string {
  return `${familyId}-S${stageNumber}`;
}

function attackThemesFor(element: string): string[] {
  const themes: Record<string, string[]> = {
    Blaze: ["fire", "flame", "ember", "heat"],
    Tide: ["water", "wave", "tidal", "ocean"],
    Blossom: ["nature", "petal", "bloom", "vine"],
    Spark: ["spark", "jolt", "static", "electric"],
    Earth: ["earth", "rock", "stone", "boulder"],
    Cosmos: ["cosmic", "star", "gravity", "nebula"],
    Wind: ["wind", "gust", "gale", "air"],
    Electric: ["lightning", "shock", "volt", "thunder"],
    Ice: ["ice", "frost", "snow", "glacial"],
    Dark: ["shadow", "night", "dark", "umbral"],
    Water: ["water", "current", "splash", "aqua"],
  };
  return themes[element] ?? [`${element.toLowerCase()}-themed`];
}

export type CharacterBiblePatch = Partial<Pick<
  VqCharacter,
  | "characterDna"
  | "visualDescription"
  | "bodyShape"
  | "colours"
  | "markings"
  | "eyes"
  | "tailAccessories"
  | "personality"
  | "stageProgressionNotes"
  | "elementIdentity"
  | "negativePrompt"
  | "masterArtworkPrompt"
  | "referenceArtworkR2Key"
  | "approvedArtworkR2Key"
  | "approvalStatus"
  | "locked"
>>;

export interface CharacterBibleContext {
  card: VqCardRow;
  baseCard: VqCardRow | null;
  character: VqCharacter | null;
  previousCharacter: VqCharacter | null;
  family: VqFamily | undefined;
}

export const vqStorage = {
  // ---- Character Bible ----
  async listCharacters(setCode = "GNV"): Promise<VqCharacter[]> {
    const rows = await db.select().from(vqCharacters).where(eq(vqCharacters.setCode, setCode));
    return rows.sort((a, b) => a.familyId.localeCompare(b.familyId) || a.stageNumber - b.stageNumber);
  },

  async getCharacter(characterId: string): Promise<VqCharacter | undefined> {
    const [row] = await db.select().from(vqCharacters).where(eq(vqCharacters.characterId, characterId));
    return row;
  },

  async getCharacterByBaseCardId(cardId: string): Promise<VqCharacter | undefined> {
    const [row] = await db.select().from(vqCharacters).where(eq(vqCharacters.cardId, cardId));
    return row;
  },

  async getCharacterBibleForCard(cardId: string): Promise<CharacterBibleContext | undefined> {
    const card = await this.getCard(cardId);
    if (!card) return undefined;
    const baseCard = card.baseCardId ? (await this.getCard(card.baseCardId)) ?? null : null;
    const identityCard = baseCard ?? card;
    const character = await this.getCharacterByBaseCardId(identityCard.cardId);
    const previousCharacter = character?.evolvesFromCharacterId ? (await this.getCharacter(character.evolvesFromCharacterId)) ?? null : null;
    const family = identityCard.familyId ? await this.getFamily(identityCard.familyId) : undefined;
    return { card, baseCard, character: character ?? null, previousCharacter, family };
  },

  async seedCharactersFromCards(setCode = "GNV"): Promise<{ created: number; familyRulesCreated: number }> {
    const cards = await this.listCards({ setCode });
    const families = await this.listFamilies(setCode);
    const familiesById = new Map(families.map((f) => [f.familyId, f]));
    const variantsByBase = new Map<string, string[]>();
    for (const card of cards) {
      if (card.baseCardId) {
        const list = variantsByBase.get(card.baseCardId) ?? [];
        list.push(card.cardId);
        variantsByBase.set(card.baseCardId, list);
      }
    }

    let created = 0;
    let familyRulesCreated = 0;
    await db.transaction(async (tx) => {
      for (const card of cards) {
        if (card.cardType !== "Creature" || card.baseCardId || !card.familyId || !card.stageNumber) continue;
        if (!CANONICAL_FAMILY_IDS.has(card.familyId)) continue;
        const family = familiesById.get(card.familyId);
        const notes = FAMILY_SEED_NOTES[card.familyId];
        const row: InsertVqCharacter = {
          characterId: characterIdFor(card.familyId, card.stageNumber),
          setCode: card.setCode,
          familyId: card.familyId,
          familyName: family?.name ?? null,
          cardId: card.cardId,
          stageNumber: card.stageNumber,
          characterName: card.name,
          element: card.element,
          role: card.lifeStage ?? null,
          variantCardIds: (variantsByBase.get(card.cardId) ?? []).sort(),
          evolvesFromCharacterId: card.stageNumber > 1 ? characterIdFor(card.familyId, card.stageNumber - 1) : null,
          sourceNotes: notes ? `${notes.vibe}. ${notes.source}.` : null,
          personality: notes?.vibe ?? null,
          approvalStatus: "draft",
          locked: false,
        };
        const inserted = await tx.insert(vqCharacters).values(row).onConflictDoNothing().returning({ id: vqCharacters.id });
        if (inserted.length) created++;
      }

      for (const family of families) {
        if (!CANONICAL_FAMILY_IDS.has(family.familyId)) continue;
        const inserted = await tx.insert(vqFamilyRules).values({
          familyId: family.familyId,
          element: family.element,
          allowedAttackThemes: attackThemesFor(family.element),
          forbiddenAttackTerms: [],
          statProfile: {
            stage1: { health: 5, guard: 0, shift: 0 },
            stage2: { health: 8, guard: 1, shift: 1 },
            stage3: { health: 12, guard: 3, shift: 2 },
          },
          notes: "Seeded from canonical family element; refine after playtest.",
        }).onConflictDoNothing().returning({ id: vqFamilyRules.id });
        if (inserted.length) familyRulesCreated++;
      }
    });

    return { created, familyRulesCreated };
  },

  async updateCharacterBible(characterId: string, patch: CharacterBiblePatch, editedBy?: string, reason?: string): Promise<VqCharacter> {
    const existing = await this.getCharacter(characterId);
    if (!existing) throw new Error("character not found");
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as CharacterBiblePatch;
    if (Object.keys(cleanPatch).length === 0) return existing;
    if (existing.locked && cleanPatch.locked !== false) {
      throw new Error("Character is locked — unlock before editing its Bible fields.");
    }
    await db.insert(vqCharacterRevisions).values({
      characterId,
      revisionJson: existing as unknown as Record<string, unknown>,
      editedBy,
      reason: reason ?? null,
    });
    // Editing identity fields after description approval demotes the description to
    // needs_review — the founder must re-approve before more artwork is generated.
    const DESCRIPTION_KEYS = ["characterDna", "visualDescription", "bodyShape", "colours", "markings", "eyes", "tailAccessories", "personality", "stageProgressionNotes", "elementIdentity", "negativePrompt", "masterArtworkPrompt"];
    const touchesDescription = Object.entries(cleanPatch).some(([k, v]) => DESCRIPTION_KEYS.includes(k) && v !== (existing as unknown as Record<string, unknown>)[k]);
    const demote = existing.descriptionStatus === "approved" && touchesDescription ? { descriptionStatus: "needs_review" } : {};
    const [updated] = await db
      .update(vqCharacters)
      .set({ ...cleanPatch, ...demote, updatedAt: new Date() })
      .where(eq(vqCharacters.characterId, characterId))
      .returning();
    if (!updated) throw new Error("character update failed");
    return updated;
  },

  async setCharacterDescriptionStatus(characterId: string, status: "draft" | "approved" | "needs_review", editedBy?: string): Promise<VqCharacter> {
    const existing = await this.getCharacter(characterId);
    if (!existing) throw new Error("character not found");
    await db.insert(vqCharacterRevisions).values({
      characterId,
      revisionJson: existing as unknown as Record<string, unknown>,
      editedBy,
      reason: `description ${status}`,
    });
    const [updated] = await db.update(vqCharacters).set({ descriptionStatus: status, updatedAt: new Date() }).where(eq(vqCharacters.characterId, characterId)).returning();
    if (!updated) throw new Error("description status update failed");
    return updated;
  },

  async setCharacterArtworkKey(characterId: string, kind: "reference" | "approved", key: string, editedBy?: string): Promise<VqCharacter> {
    const existing = await this.getCharacter(characterId);
    if (!existing) throw new Error("character not found");
    await db.insert(vqCharacterRevisions).values({
      characterId,
      revisionJson: existing as unknown as Record<string, unknown>,
      editedBy,
      reason: kind === "approved" ? "approved artwork set" : "reference artwork set",
    });
    const patch = kind === "approved"
      ? { approvedArtworkR2Key: key, approvalStatus: "artwork_approved", updatedAt: new Date() }
      : { referenceArtworkR2Key: key, approvalStatus: existing.approvalStatus === "draft" ? "reference_uploaded" : existing.approvalStatus, updatedAt: new Date() };
    const [updated] = await db.update(vqCharacters).set(patch).where(eq(vqCharacters.characterId, characterId)).returning();
    if (!updated) throw new Error("character artwork update failed");
    return updated;
  },

  async setCharacterLocked(characterId: string, locked: boolean, editedBy?: string): Promise<VqCharacter> {
    const existing = await this.getCharacter(characterId);
    if (!existing) throw new Error("character not found");
    await db.insert(vqCharacterRevisions).values({
      characterId,
      revisionJson: existing as unknown as Record<string, unknown>,
      editedBy,
      reason: locked ? "character locked" : "character unlocked",
    });
    const [updated] = await db.update(vqCharacters).set({ locked, updatedAt: new Date() }).where(eq(vqCharacters.characterId, characterId)).returning();
    if (!updated) throw new Error("character lock update failed");
    return updated;
  },

  async listCharacterRevisions(characterId: string) {
    return db.select().from(vqCharacterRevisions).where(eq(vqCharacterRevisions.characterId, characterId)).orderBy(desc(vqCharacterRevisions.editedAt));
  },

  async recordArtworkCandidate(row: InsertVqArtworkCandidate): Promise<VqArtworkCandidate> {
    const [created] = await db.insert(vqArtworkCandidates).values(row).returning();
    return created;
  },

  async markArtworkCandidateStatusByKey(r2Key: string, status: string): Promise<void> {
    await db.update(vqArtworkCandidates).set({ status, updatedAt: new Date() }).where(eq(vqArtworkCandidates.r2Key, r2Key));
  },

  async listArtworkCandidates(characterId: string, referenceType?: string): Promise<VqArtworkCandidate[]> {
    const where = referenceType
      ? and(eq(vqArtworkCandidates.characterId, characterId), eq(vqArtworkCandidates.referenceType, referenceType))
      : eq(vqArtworkCandidates.characterId, characterId);
    return db.select().from(vqArtworkCandidates).where(where).orderBy(desc(vqArtworkCandidates.createdAt));
  },

  /**
   * Approve a reference image for ONE pack slot (master_portrait, action_pose, …).
   * Master Reference (master_portrait slot) doubles as the legacy single reference: it also syncs
   * referenceArtworkR2Key/approvedArtworkR2Key so the Full Card gate keeps working.
   * Character-level only — never touches vq_cards.
   */
  async setCharacterReferencePack(characterId: string, referenceType: VqReferenceType, key: string, candidateId: number | null, editedBy?: string, identityScore?: number | null): Promise<VqCharacter> {
    const existing = await this.getCharacter(characterId);
    if (!existing) throw new Error("character not found");
    await db.insert(vqCharacterRevisions).values({
      characterId,
      revisionJson: existing as unknown as Record<string, unknown>,
      editedBy,
      reason: `reference pack: ${referenceType} approved`,
    });
    // ATOMIC top-level jsonb merge — approve only ever sets ONE reference-type key,
    // so a concurrent approval of a DIFFERENT type can't clobber this slot (the old
    // read-modify-write of the whole referencePack column lost the sibling slot).
    // `||` is a documented shallow merge; verified on the engine. Sibling keys survive.
    const slotJson = referencePackMergeJson(referenceType, key, candidateId, identityScore, new Date().toISOString());
    const mergeExpr = sql`coalesce(${vqCharacters.referencePack}, '{}'::jsonb) || ${slotJson}::jsonb`;
    const [updated] = await db
      .update(vqCharacters)
      .set(
        referenceType === "master_portrait"
          ? { referencePack: mergeExpr, referenceArtworkR2Key: key, approvedArtworkR2Key: key, approvalStatus: "artwork_approved", updatedAt: new Date() }
          : { referencePack: mergeExpr, updatedAt: new Date() },
      )
      .where(eq(vqCharacters.characterId, characterId))
      .returning();
    if (!updated) throw new Error("reference pack update failed");
    return updated;
  },

  async getArtworkCandidate(id: number): Promise<VqArtworkCandidate | undefined> {
    const [row] = await db.select().from(vqArtworkCandidates).where(eq(vqArtworkCandidates.id, id));
    return row;
  },

  async markArtworkCandidateStatusById(id: number, status: string): Promise<void> {
    await db.update(vqArtworkCandidates).set({ status, updatedAt: new Date() }).where(eq(vqArtworkCandidates.id, id));
  },

  async setArtworkCandidateIdentity(id: number, identityScore: number | null, identityBreakdown: Record<string, unknown>): Promise<void> {
    await db.update(vqArtworkCandidates).set({ identityScore, identityBreakdown, updatedAt: new Date() }).where(eq(vqArtworkCandidates.id, id));
  },

  // ---- sets ----
  async getSet(setCode: string): Promise<typeof vqSets.$inferSelect | undefined> {
    const [row] = await db.select().from(vqSets).where(eq(vqSets.setCode, setCode));
    return row;
  },
  async upsertSet(set: InsertVqSet): Promise<void> {
    await db
      .insert(vqSets)
      .values(set)
      .onConflictDoUpdate({ target: vqSets.setCode, set: { ...set, updatedAt: new Date() } });
  },

  // ---- families ----
  async listFamilies(setCode = "GNV"): Promise<VqFamily[]> {
    return db.select().from(vqFamilies).where(eq(vqFamilies.setCode, setCode));
  },
  async getFamily(familyId: string): Promise<VqFamily | undefined> {
    const [row] = await db.select().from(vqFamilies).where(eq(vqFamilies.familyId, familyId));
    return row;
  },
  async upsertFamily(family: InsertVqFamily): Promise<void> {
    await db
      .insert(vqFamilies)
      .values(family)
      .onConflictDoUpdate({ target: vqFamilies.familyId, set: family });
  },

  // ---- cards ----
  async listCards(filter: CardFilter = {}): Promise<VqCardRow[]> {
    const clauses = [
      filter.setCode ? eq(vqCards.setCode, filter.setCode) : undefined,
      filter.status ? eq(vqCards.status, filter.status) : undefined,
      filter.cardType ? eq(vqCards.cardType, filter.cardType) : undefined,
      filter.element ? eq(vqCards.element, filter.element) : undefined,
    ].filter(Boolean);
    const q = db.select().from(vqCards);
    const rows = clauses.length ? await q.where(and(...(clauses as [ReturnType<typeof eq>]))) : await q;
    return rows.sort((a, b) => a.collectorNumber.localeCompare(b.collectorNumber));
  },
  async getCard(cardId: string): Promise<VqCardRow | undefined> {
    const [row] = await db.select().from(vqCards).where(eq(vqCards.cardId, cardId));
    return row;
  },

  /**
   * Editor payload for a single card: the row + family-derived previousStage and
   * familyName (Stage 2/3 evolve-from is DERIVED from vq_families, not a stored
   * column — matches the importer's previousStageName logic), plus the base card
   * for variants (baseCardId). Zero schema; used to hydrate the Studio editor.
   */
  async getStudioCard(
    cardId: string,
  ): Promise<{ card: VqCardRow; previousStage: string | null; familyName: string | null; base: VqCardRow | null } | undefined> {
    const card = await this.getCard(cardId);
    if (!card) return undefined;
    let previousStage: string | null = null;
    let familyName: string | null = null;
    if (card.familyId) {
      const fam = await this.getFamily(card.familyId);
      if (fam) {
        familyName = fam.name;
        if (card.stageNumber === 2) previousStage = fam.stage1Name ?? null;
        else if (card.stageNumber === 3) previousStage = fam.stage2Name ?? null;
      }
    }
    const base = card.baseCardId ? (await this.getCard(card.baseCardId)) ?? null : null;
    return { card, previousStage, familyName, base };
  },

  /**
   * Batch version of getStudioCard — 2 queries total (all cards + all families)
   * regardless of N, resolving previousStage/familyName/base in memory. Used by
   * every batch route (qa/proxy/export) to kill the per-card N+1.
   */
  async getStudioCardsBatch(
    ids?: string[],
  ): Promise<{ card: VqCardRow; previousStage: string | null; familyName: string | null; base: VqCardRow | null }[]> {
    // Set-agnostic (matches getStudioCard): load every card + family so a base/
    // family lookup resolves regardless of set, not just GNV.
    const all = await this.listCards({});
    const families = await db.select().from(vqFamilies);
    const byId = new Map(all.map((c) => [c.cardId, c]));
    const famById = new Map(families.map((f) => [f.familyId, f]));
    const wanted = ids?.length ? (ids.map((id) => byId.get(id)).filter(Boolean) as VqCardRow[]) : all;
    return wanted.map((card) => {
      let previousStage: string | null = null;
      let familyName: string | null = null;
      if (card.familyId) {
        const fam = famById.get(card.familyId);
        if (fam) {
          familyName = fam.name;
          if (card.stageNumber === 2) previousStage = fam.stage1Name ?? null;
          else if (card.stageNumber === 3) previousStage = fam.stage2Name ?? null;
        }
      }
      const base = card.baseCardId ? byId.get(card.baseCardId) ?? null : null;
      return { card, previousStage, familyName, base };
    });
  },

  /** Insert or update a card, snapshotting the prior state into vq_card_revisions. */
  async saveCard(card: InsertVqCard, editedBy?: string): Promise<VqCardRow> {
    const existing = await this.getCard(card.cardId);
    if (existing) {
      await db.insert(vqCardRevisions).values({ cardId: existing.cardId, revisionJson: existing as unknown as Record<string, unknown>, editedBy });
      const [updated] = await db
        .update(vqCards)
        .set({ ...card, updatedAt: new Date() })
        .where(eq(vqCards.cardId, card.cardId))
        .returning();
      return updated;
    }
    const [created] = await db.insert(vqCards).values(card).returning();
    return created;
  },

  /**
   * Atomically create a family row (optional) + new card rows, CREATE-ONLY.
   * Runs in one transaction with onConflictDoNothing so it can never overwrite an
   * existing family/card; if any target already exists the whole thing rolls back
   * and throws. This is the safe path for "generate" (saveCard upserts, which
   * would clobber, and a plain check-then-insert is a TOCTOU race).
   */
  // ---- AI Assist audit trail (preview-only content is logged, never auto-applied) ----
  async recordAiGeneration(row: InsertVqAiGeneration): Promise<number> {
    const [created] = await db.insert(vqAiGenerations).values(row).returning({ id: vqAiGenerations.id });
    return created.id;
  },
  async markAiGenerationApplied(id: number): Promise<void> {
    const [updated] = await db.update(vqAiGenerations).set({ applied: true }).where(eq(vqAiGenerations.id, id)).returning({ id: vqAiGenerations.id });
    if (!updated) throw new Error("AI generation audit row not found");
  },
  /** Flip the audit flag for the artwork generation that produced this candidate — used
   *  when the candidate is actually PROMOTED into draft art on Save Draft (not on Use). */
  async markAiGenerationAppliedByCandidate(candidateKey: string): Promise<void> {
    await db
      .update(vqAiGenerations)
      .set({ applied: true })
      .where(sql`${vqAiGenerations.output}->>'candidateKey' = ${candidateKey}`);
  },

  /** Create a new element with a placeholder palette (create-only, marks unknown → NEEDS_APPROVAL by convention). */
  async createElement(name: string): Promise<VqElementRow> {
    const placeholder = { name, border: "#6B7280", accent: "#9CA3AF", dark: "#1F2937", crestKey: null };
    const [created] = await db.insert(vqElements).values(placeholder).onConflictDoNothing().returning();
    if (created) return created;
    const [existing] = await db.select().from(vqElements).where(eq(vqElements.name, name));
    return existing;
  },
  async listElementNames(): Promise<string[]> {
    const rows = await db.select({ name: vqElements.name }).from(vqElements);
    return rows.map((r) => r.name);
  },

  async createFamilyAndCards(family: InsertVqFamily | null, cards: InsertVqCard[]): Promise<void> {
    await db.transaction(async (tx) => {
      if (family) {
        const f = await tx.insert(vqFamilies).values(family).onConflictDoNothing().returning();
        if (f.length === 0) throw new Error(`family ${family.familyId} already exists`);
      }
      for (const card of cards) {
        const r = await tx.insert(vqCards).values(card).onConflictDoNothing().returning();
        if (r.length === 0) throw new Error(`card ${card.cardId} already exists — generate is create-only`);
      }
    });
  },

  async listRevisions(cardId: string) {
    return db.select().from(vqCardRevisions).where(eq(vqCardRevisions.cardId, cardId)).orderBy(desc(vqCardRevisions.editedAt));
  },

  // ---- elements + config ----
  async listElements() {
    return db.select().from(vqElements);
  },
  async upsertElement(el: typeof vqElements.$inferInsert): Promise<void> {
    await db.insert(vqElements).values(el).onConflictDoUpdate({ target: vqElements.name, set: el });
  },
  async getConfig(): Promise<Record<string, string>> {
    const rows = await db.select().from(vqGameConfig);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  async setConfig(key: string, value: string): Promise<void> {
    await db.insert(vqGameConfig).values({ key, value }).onConflictDoUpdate({ target: vqGameConfig.key, set: { value } });
  },

  // ---- releases (Phase 1d publish target; rows only in 1a) ----
  async listReleases(setCode = "GNV"): Promise<VqRelease[]> {
    return db.select().from(vqReleases).where(eq(vqReleases.setCode, setCode)).orderBy(desc(vqReleases.publishedAt));
  },
  async getCurrentRelease(setCode = "GNV"): Promise<VqRelease | undefined> {
    const [row] = await db.select().from(vqReleases).where(and(eq(vqReleases.setCode, setCode), eq(vqReleases.isCurrent, true)));
    return row;
  },

  // ---- workflow status (audited via vq_card_revisions; no schema change) ----
  /** Snapshot the prior state (with the transition note) then set the new status. */
  async setCardStatusAudited(cardId: string, to: string, note?: string, by?: string, expectedFrom?: string): Promise<VqCardRow> {
    const existing = await this.getCard(cardId);
    if (!existing) throw new Error("card not found");
    if (expectedFrom !== undefined && existing.status !== expectedFrom) {
      throw new Error(`card status changed to "${existing.status}" — reload before retrying`);
    }
    await db.insert(vqCardRevisions).values({
      cardId,
      revisionJson: { ...existing, _transition: { from: existing.status, to, note: note ?? null, at: new Date().toISOString() } } as unknown as Record<string, unknown>,
      editedBy: by,
    });
    // compare-and-set on the status we just read — a concurrent transition loses.
    const [updated] = await db
      .update(vqCards)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(vqCards.cardId, cardId), eq(vqCards.status, existing.status)))
      .returning();
    if (!updated) throw new Error("status changed concurrently — reload before retrying");
    return updated;
  },

  async listVariantsOf(baseCardId: string): Promise<VqCardRow[]> {
    const rows = await db.select().from(vqCards).where(eq(vqCards.baseCardId, baseCardId));
    return rows.sort((a, b) => a.collectorNumber.localeCompare(b.collectorNumber));
  },

  /** All cards in a family, grouped by stage + variants (base cards first). */
  async familyTree(familyId: string): Promise<{ family: VqFamily | undefined; stages: Record<string, VqCardRow[]>; variants: VqCardRow[] }> {
    const family = await this.getFamily(familyId);
    const rows = (await db.select().from(vqCards).where(eq(vqCards.familyId, familyId)))
      .sort((a, b) => a.collectorNumber.localeCompare(b.collectorNumber));
    const stages: Record<string, VqCardRow[]> = { "1": [], "2": [], "3": [] };
    const variants: VqCardRow[] = [];
    for (const c of rows) {
      if (c.baseCardId) variants.push(c);
      else if (c.stageNumber && stages[String(c.stageNumber)]) stages[String(c.stageNumber)].push(c);
    }
    return { family, stages, variants };
  },

  /** Fast, render-free dashboard aggregates + a per-card summary row for the board. */
  async dashboardSummary(setCode = "GNV") {
    const SUPPORT = new Set(["Tactic", "Relic", "Vault", "Collector", "Place"]);
    const NEEDS_APPROVAL_ELEMENTS = new Set(["Blaze", "Tide", "Blossom", "Spark", "Earth", "Cosmos", "Wind", "Electric", "Ice", "Dark", "Light", "Brand", "Crystal"]);
    const cards = await this.listCards({ setCode });
    const families = await this.listFamilies(setCode);
    const byId = new Map(cards.map((c) => [c.cardId, c]));

    const lightData = (c: VqCardRow): boolean => {
      // identity (matches evaluateCard.dataComplete) + gameplay
      if (!(c.cardId && c.collectorNumber && c.name && c.cardType && c.element && c.rarity)) return false;
      if (SUPPORT.has(c.cardType)) return true;
      const base = c.baseCardId ? byId.get(c.baseCardId) : undefined;
      const health = c.health ?? base?.health ?? null;
      const a1n = c.attack1Name ?? base?.attack1Name ?? null;
      const a1d = c.attack1Damage ?? base?.attack1Damage ?? null;
      return health != null && !!a1n && a1d != null;
    };

    const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byElement: Record<string, number> = {};
    const byRarity: Record<string, number> = {};
    let variants = 0, base = 0, needsData = 0, needsArtwork = 0, placeholderElements = 0;

    const summary = cards.map((c) => {
      inc(byStatus, c.status);
      inc(byType, c.cardType);
      inc(byElement, c.element);
      if (c.rarity) inc(byRarity, c.rarity);
      const isVariant = !!c.baseCardId;
      if (isVariant) variants++; else base++;
      const hasData = lightData(c);
      const hasArt = !!c.artR2Key;
      if (!hasData) needsData++;
      if (!hasArt) needsArtwork++;
      if (NEEDS_APPROVAL_ELEMENTS.has(c.element)) placeholderElements++;
      let readiness = 0;
      if (hasData) readiness += 35;
      if (hasArt) readiness += 25;
      if (hasData) readiness += 25; // render proxy: renders if data complete (refined by full QA)
      if (["approved", "export_ready", "printed_proxy"].includes(c.status)) readiness += 15;
      return {
        cardId: c.cardId, collectorNumber: c.collectorNumber, name: c.name, cardType: c.cardType,
        element: c.element, rarity: c.rarity, stageNumber: c.stageNumber, familyId: c.familyId,
        variantTier: c.variantTier, baseCardId: c.baseCardId, status: c.status,
        hasData, hasArt, placeholderElement: NEEDS_APPROVAL_ELEMENTS.has(c.element), readiness: Math.min(100, readiness),
      };
    });

    // families complete = every stage 1/2/3 base card present + has data + has art
    let familiesComplete = 0;
    for (const fam of families) {
      const kids = cards.filter((c) => c.familyId === fam.familyId && !c.baseCardId);
      const stages = new Set(kids.map((c) => c.stageNumber));
      const allData = kids.every(lightData);
      const allArt = kids.every((c) => !!c.artR2Key);
      if (stages.has(1) && stages.has(2) && stages.has(3) && allData && allArt) familiesComplete++;
    }

    return {
      total: cards.length, byStatus, byType, byElement, byRarity,
      variants, base, needsData, needsArtwork, placeholderElements,
      families: families.length, familiesComplete,
      cards: summary,
    };
  },
};
