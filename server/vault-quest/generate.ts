/**
 * Vault Quest — "Generate from the locked template" (Card Studio production entry).
 *
 * The canonical 150-card Genesis Vault set already exists as draft shells (seeded
 * by the importer) — those are OPENED from the board, not generated. This module
 * is for creating NEW cards/families beyond the seeded set (expansions, gap-fills)
 * straight from the locked template, so the founder never hand-builds a blank row:
 *
 *   • generateCard   → one draft card, creature stats pre-filled from STAT_SCALE.
 *   • generateFamily → a full evolution family (Baby/Teen/Final) as three linked
 *     draft creatures + the family row, stage names + rarity ladder + stat scale
 *     from the template.
 *
 * CREATE-ONLY and collision-safe: ids/collector numbers are computed to the next
 * free slot and every target is asserted absent before writing, so it can never
 * overwrite an existing card (saveCard upserts, so a naive write WOULD clobber).
 * Everything lands as `draft` — nothing is auto-approved or published.
 */
import { vqStorage } from "./storage";
import { STAT_SCALE } from "./seed";
import { VQ_ELEMENTS } from "./lib/vq-constants";
import { VQ_CARD_TYPES } from "@shared/vq-validate";
import type { InsertVqCard, InsertVqFamily, VqCardRow, VqFamily } from "@shared/vq-schema";

const VALID_RARITIES = new Set(["C", "U", "R", "SR", "GR", "UR", "SRA", "RR", "FSR", "CR"]);

export type GenerateMode = "card" | "family";

export interface GenerateReq {
  mode: GenerateMode;
  name: string;
  element: string;
  cardType?: string; // card mode only; default Creature
  rarity?: string; // card mode only; default derived
  stageNumber?: number; // card mode only (creature); default 1
  setCode?: string; // default GNV
}

export interface GenerateResult {
  created: string[]; // card ids created (in order)
  familyId?: string; // set for family mode
  openCardId: string; // the card the UI should open
}

const pad3 = (n: number) => String(n).padStart(3, "0");
const RARITY_LADDER: Record<number, string> = { 1: "C", 2: "U", 3: "RR" };

function nextCardNum(cards: VqCardRow[]): number {
  let max = 0;
  for (const c of cards) {
    const m = /^GNV-(\d+)$/.exec(c.cardId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function nextCollector(cards: VqCardRow[], count: number): { start: number; denom: number } {
  let maxN = 0;
  let denom = 0;
  for (const c of cards) {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(c.collectorNumber ?? "");
    if (m) {
      maxN = Math.max(maxN, Number(m[1]));
      denom = Math.max(denom, Number(m[2]));
    }
  }
  const start = maxN + 1;
  // grow the denominator so the numerator can never exceed it (no "151/150")
  return { start, denom: Math.max(denom, cards.length, start + count - 1) };
}

function nextFamilyNum(families: VqFamily[]): number {
  let max = 0;
  for (const f of families) {
    const m = /F(\d+)/.exec(f.familyId ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function draftCard(fields: Partial<InsertVqCard> & Pick<InsertVqCard, "cardId" | "name" | "cardType" | "element">): InsertVqCard {
  return {
    collectorNumber: "", // always overridden by callers below
    displayName: null,
    rarity: null,
    familyId: null,
    stageNumber: null,
    lifeStage: null,
    health: null,
    guard: null,
    shift: null,
    attack1Name: null,
    attack1Cost: null,
    attack1Damage: null,
    attack1Effect: null,
    attack2Name: null,
    attack2Cost: null,
    attack2Damage: null,
    attack2Effect: null,
    vulnerability: null,
    keywords: [],
    variantTier: null,
    baseCardId: null,
    artR2Key: null,
    prevArtR2Key: null,
    setCode: "GNV",
    language: "EN",
    year: 2026,
    edition: "FIRST EDITION",
    status: "draft",
    notes: null,
    ...fields,
  };
}

export async function generate(req: GenerateReq): Promise<GenerateResult> {
  const name = (req.name ?? "").trim();
  const element = (req.element ?? "").trim();
  const setCode = (req.setCode ?? "GNV").trim() || "GNV";
  if (!name) throw new Error("name is required");
  // own-property check (not `in`) so prototype keys like "constructor" can't pass
  if (!element || !Object.prototype.hasOwnProperty.call(VQ_ELEMENTS, element)) throw new Error(`unknown element "${element}"`);
  if (!/^[A-Za-z0-9]{1,8}$/.test(setCode)) throw new Error(`invalid setCode "${setCode}"`);

  const cards = await vqStorage.listCards({ setCode });
  const num0 = nextCardNum(cards);

  if (req.mode === "card") {
    const cardType = (req.cardType ?? "Creature").trim() || "Creature";
    if (!(VQ_CARD_TYPES as readonly string[]).includes(cardType)) throw new Error(`unknown card type "${cardType}"`);
    const rarityIn = req.rarity?.trim();
    if (rarityIn && !VALID_RARITIES.has(rarityIn)) throw new Error(`unknown rarity "${rarityIn}"`);
    const col = nextCollector(cards, 1);
    const cardId = `${setCode}-${pad3(num0)}`;
    const isCreature = cardType === "Creature";
    const stage = isCreature ? (req.stageNumber && [1, 2, 3].includes(req.stageNumber) ? req.stageNumber : 1) : null;
    const scale = stage ? STAT_SCALE[stage] : null;
    const row = draftCard({
      cardId,
      collectorNumber: `${col.start}/${col.denom}`,
      name,
      cardType,
      element,
      rarity: (rarityIn || (stage ? RARITY_LADDER[stage] : null)) ?? null,
      stageNumber: stage,
      health: scale?.health ?? null,
      guard: scale?.guard ?? null,
      shift: scale?.shift ?? null,
      setCode,
    });
    // atomic + create-only (won't overwrite; no TOCTOU)
    await vqStorage.createFamilyAndCards(null, [row]);
    return { created: [cardId], openCardId: cardId };
  }

  // ---- family mode: base Baby/Teen/Final ----
  const families = await vqStorage.listFamilies(setCode);
  const famId = `${setCode}-F${String(nextFamilyNum(families)).padStart(2, "0")}`;
  if (families.some((f) => f.familyId === famId)) throw new Error(`family ${famId} already exists`);

  const col = nextCollector(cards, 3);
  const stageNames = [`${name} I`, `${name} II`, `${name} III`];
  const ids = [0, 1, 2].map((i) => `${setCode}-${pad3(num0 + i)}`);

  const family: InsertVqFamily = {
    familyId: famId,
    setCode,
    element,
    name,
    stage1Name: stageNames[0],
    stage2Name: stageNames[1],
    stage3Name: stageNames[2],
  };
  const cardRows = [0, 1, 2].map((i) => {
    const stage = i + 1;
    const scale = STAT_SCALE[stage];
    return draftCard({
      cardId: ids[i],
      collectorNumber: `${col.start + i}/${col.denom}`,
      name: stageNames[i],
      cardType: "Creature",
      element,
      rarity: RARITY_LADDER[stage],
      familyId: famId,
      stageNumber: stage,
      health: scale.health,
      guard: scale.guard,
      shift: scale.shift,
      setCode,
    });
  });
  // one transaction: family + 3 cards, create-only (rolls back if anything exists)
  await vqStorage.createFamilyAndCards(family, cardRows);

  return { created: ids, familyId: famId, openCardId: ids[0] };
}
