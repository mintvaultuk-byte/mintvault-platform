/**
 * AI Creature Designer (Phase 2) — turn an APPROVED, edited family concept into real
 * records. Orchestration only: it reads existing families/cards, computes non-colliding
 * ids, maps the concept onto family + 3 stage cards + 3 stage characters (+ an audit
 * row), and calls the ONE create-only transaction in storage. TEXT ONLY — this module
 * never contacts Higgsfield and never writes R2.
 *
 * Pure helpers (planFamilyIds, deriveAlternativeNames) are exported for unit testing.
 */
import { vqStorage } from "./storage";
import { STAT_SCALE } from "./seed";
import { planFamilyIds, deriveAlternativeNames } from "./lib/creature-plan";
import {
  CONCEPT_STAGE_DRAWABLE_KEYS,
  collisionReport,
  type CreatureIdeaInput,
  type FamilyConcept,
  type ExistingNames,
} from "@shared/vq-creature-concept";
import type { InsertVqCard, InsertVqCharacter, InsertVqFamily, InsertVqAiGeneration } from "@shared/vq-schema";

const RARITY_LADDER: Record<number, string> = { 1: "C", 2: "U", 3: "RR" };

// Pure planning/naming helpers live in ./lib/creature-plan (DB-free, unit-tested).
export { planFamilyIds, deriveAlternativeNames } from "./lib/creature-plan";

export type CreateFromConceptResult =
  | { ok: true; familyId: string; stageCharacterIds: string[]; cardIds: string[]; stageNames: string[] }
  | { ok: false; reason: "collision"; conflicts: string[]; suggestion: { familyName: string; stageNames: string[] } | null }
  | { ok: false; reason: "exists"; message: string };

export interface CreateFromConceptOpts {
  setCode?: string;
  founderInput: CreatureIdeaInput;
  provider: string;
  model: string;
  createdBy?: string;
}

/**
 * Create the family from an approved concept. Collision-checked (never overwrites /
 * attaches to an unrelated family) and fully transactional (all-or-nothing). Returns a
 * structured collision result (with a suggested alternative) instead of throwing when
 * names clash, so the founder can rename or regenerate.
 */
export async function createFamilyFromConcept(
  concept: FamilyConcept,
  opts: CreateFromConceptOpts,
): Promise<CreateFromConceptResult> {
  const setCode = (opts.setCode ?? "GNV").trim() || "GNV";
  const [cards, families, characters] = await Promise.all([
    vqStorage.listCards({ setCode }),
    vqStorage.listFamilies(setCode),
    vqStorage.listCharacters(setCode),
  ]);

  const existingNames: ExistingNames = {
    familyNames: families.map((f) => f.name).filter((n): n is string => !!n),
    characterNames: characters.map((c) => c.characterName).filter((n): n is string => !!n),
    familyIds: families.map((f) => f.familyId),
  };
  const stageNames = concept.stages.map((s) => s.name);
  const collide = collisionReport(existingNames, { familyName: concept.family.name, stageNames });
  if (collide.collides) {
    return {
      ok: false,
      reason: "collision",
      conflicts: collide.conflicts,
      suggestion: deriveAlternativeNames(concept.family.name, stageNames, existingNames),
    };
  }

  const plan = planFamilyIds({ cards, families }, setCode);
  const element = concept.family.element;

  const family: InsertVqFamily = {
    familyId: plan.familyId,
    setCode,
    element,
    name: concept.family.name,
    stage1Name: stageNames[0],
    stage2Name: stageNames[1],
    stage3Name: stageNames[2],
  };

  const cardRows: InsertVqCard[] = concept.stages.map((s, i) => {
    const stage = i + 1;
    const scale = STAT_SCALE[stage];
    return {
      cardId: plan.cardIds[i],
      collectorNumber: plan.collectorNumbers[i],
      name: s.name,
      displayName: null,
      cardType: "Creature",
      element,
      rarity: RARITY_LADDER[stage],
      familyId: plan.familyId,
      stageNumber: stage,
      lifeStage: null,
      health: scale.health,
      guard: scale.guard,
      shift: scale.shift,
      attack1Name: null, attack1Cost: null, attack1Damage: null, attack1Effect: null,
      attack2Name: null, attack2Cost: null, attack2Damage: null, attack2Effect: null,
      vulnerability: null,
      keywords: [],
      variantTier: null,
      baseCardId: null,
      artR2Key: null,
      prevArtR2Key: null,
      setCode,
      language: "EN",
      year: 2026,
      edition: "FIRST EDITION",
      status: "draft",
      notes: null,
    };
  });

  const characterRows: InsertVqCharacter[] = concept.stages.map((s, i) => {
    const stage = i + 1;
    const drawable = Object.fromEntries(CONCEPT_STAGE_DRAWABLE_KEYS.map((k) => [k, s[k]]));
    return {
      characterId: `${plan.familyId}-S${stage}`,
      setCode,
      familyId: plan.familyId,
      familyName: concept.family.name,
      cardId: plan.cardIds[i],
      stageNumber: stage,
      characterName: s.name,
      element,
      role: null,
      variantCardIds: [],
      evolvesFromCharacterId: stage > 1 ? `${plan.familyId}-S${stage - 1}` : null,
      // Narrative extras that have no dedicated column are preserved here so nothing is lost.
      sourceNotes: `AI Creature Designer. Ability: ${s.signatureAbility}. Flavour: ${s.flavourText}`,
      ...(drawable as Record<(typeof CONCEPT_STAGE_DRAWABLE_KEYS)[number], string>),
      // The founder approved the CONCEPT text, so the description is approved (text
      // before pixels — artwork generation is unlocked, but no images exist yet).
      descriptionStatus: "approved",
      approvalStatus: "draft",
      locked: false,
    };
  });

  const audit: InsertVqAiGeneration = {
    cardId: null,
    kind: "family-concept",
    mode: "create",
    provider: opts.provider,
    model: opts.model,
    generatedBy: opts.createdBy ?? "admin",
    prompt: "creature-designer:family-concept",
    output: {
      founderInput: opts.founderInput,
      concept,
      familyId: plan.familyId,
      cardIds: plan.cardIds,
      characterIds: characterRows.map((c) => c.characterId),
    },
    applied: true,
  };

  try {
    await vqStorage.createFamilyFromConcept(family, cardRows, characterRows, audit);
  } catch (err) {
    // A concurrent create grabbed one of the ids between our read and write — surface
    // it as a retryable "exists" outcome; NOTHING was created (transaction rolled back).
    return { ok: false, reason: "exists", message: err instanceof Error ? err.message : "family already exists" };
  }

  return {
    ok: true,
    familyId: plan.familyId,
    stageCharacterIds: characterRows.map((c) => c.characterId),
    cardIds: plan.cardIds,
    stageNames,
  };
}
