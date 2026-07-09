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
  type VqElementRow,
} from "@shared/vq-schema";

export interface CardFilter {
  setCode?: string;
  status?: string;
  cardType?: string;
  element?: string;
}

export const vqStorage = {
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

  async setCardStatus(cardId: string, status: "draft" | "approved" | "published"): Promise<void> {
    await db.update(vqCards).set({ status, updatedAt: new Date() }).where(eq(vqCards.cardId, cardId));
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
