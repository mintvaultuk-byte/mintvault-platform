/**
 * Vault Quest — AI Creature Designer (Phase 2) shared concept model.
 *
 * PURE + shared (client dropdown/review + server generator/creation agree on shape):
 * the founder types one plain idea and receives a full, editable 3-stage FAMILY
 * concept BEFORE any artwork is generated. This module holds the concept types, the
 * founder input shape, the Random-Inspiration list, and pure validation + name-
 * collision helpers. No network, no DOM, no Node APIs — safe on both sides.
 *
 * The per-stage "drawable" fields intentionally mirror the server's
 * DESCRIPTION_FIELD_KEYS (server/vault-quest/ai/generators.ts) so an approved concept
 * drops straight onto vq_characters and each stage is immediately artwork-ready. The
 * family-level concept (theme/lore/palette/evolutionDirection) is recorded in the
 * existing vq_ai_generations audit (owner decision: audit-only, no migration).
 */

/** Simple element choices offered on the idea panel (a friendly subset — the full
 *  element taxonomy still lives in shared/vq-schema; these are the founder-facing six). */
export const VQ_CONCEPT_ELEMENTS = ["Flame", "Tide", "Terra", "Volt", "Gale", "Crystal"] as const;
export const VQ_CONCEPT_TEMPERAMENTS = [
  "Cute", "Brave", "Shy", "Mischievous", "Playful", "Noble", "Protective", "Ancient",
] as const;

/** What the founder types on Step 1. Only `idea` is required. */
export interface CreatureIdeaInput {
  idea: string;
  element?: string;
  temperament?: string;
  colours?: string;
  habitat?: string;
  size?: string;
  specialTrait?: string;
}

/** The 12 drawable identity fields — MUST match server DESCRIPTION_FIELD_KEYS so an
 *  approved stage maps 1:1 onto vq_characters. */
export const CONCEPT_STAGE_DRAWABLE_KEYS = [
  "characterDna", "visualDescription", "bodyShape", "colours", "markings", "eyes",
  "tailAccessories", "personality", "stageProgressionNotes", "elementIdentity",
  "negativePrompt", "masterArtworkPrompt",
] as const;
export type ConceptDrawableKey = (typeof CONCEPT_STAGE_DRAWABLE_KEYS)[number];
export type ConceptDrawableFields = Record<ConceptDrawableKey, string>;

/** Founder-facing narrative extras shown in the review (stored in audit, not columns). */
export const CONCEPT_STAGE_NARRATIVE_KEYS = ["shortDescription", "signatureAbility", "flavourText"] as const;

export interface StageConcept extends ConceptDrawableFields {
  stageNumber: 1 | 2 | 3;
  name: string;
  shortDescription: string;
  signatureAbility: string;
  flavourText: string;
}

export interface FamilyLevelConcept {
  name: string; // family working title
  element: string;
  theme: string;
  evolutionDirection: string;
  palette: string;
  sharedTraits: string;
  lore: string;
}

export interface FamilyConcept {
  family: FamilyLevelConcept;
  stages: StageConcept[]; // exactly 3, stage 1/2/3
}

/** Random-Inspiration ideas — populates the idea box only; creates/saves nothing. */
export const RANDOM_INSPIRATION_IDEAS: readonly string[] = [
  "Crystal hedgehog",
  "Lava turtle",
  "Bubble axolotl",
  "Ghost mushroom",
  "Electric owl",
  "Marshmallow sheep",
  "Moon fox",
  "Tiny rock monster",
  "Coral whale",
  "Forest spirit",
  "Baby cloud dragon",
  "Glass butterfly",
  "Pebble hermit crab",
  "Lantern jellyfish",
  "Mossy stone turtle",
] as const;

/** Deterministic pick (index-based) so it is trivially unit-testable; the client
 *  passes an incrementing counter or a random index. */
export function pickRandomInspiration(index: number): string {
  const list = RANDOM_INSPIRATION_IDEAS;
  const n = Number.isFinite(index) ? Math.trunc(index) : 0;
  return list[((n % list.length) + list.length) % list.length];
}

/** Every field that must be present + non-empty for a concept to be approvable. */
export function validateFamilyConcept(c: FamilyConcept | null | undefined): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c || !c.family || !Array.isArray(c.stages)) return { ok: false, missing: ["concept"] };
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  for (const k of ["name", "element", "theme", "evolutionDirection", "palette", "sharedTraits", "lore"] as const) {
    if (!nonEmpty(c.family[k])) missing.push(`family.${k}`);
  }
  if (c.stages.length !== 3) missing.push("stages.length!=3");
  c.stages.forEach((s, i) => {
    const stage = i + 1;
    if (s.stageNumber !== stage) missing.push(`stages[${i}].stageNumber`);
    if (!nonEmpty(s.name)) missing.push(`stages[${i}].name`);
    for (const k of CONCEPT_STAGE_DRAWABLE_KEYS) if (!nonEmpty(s[k])) missing.push(`stages[${i}].${k}`);
    for (const k of CONCEPT_STAGE_NARRATIVE_KEYS) if (!nonEmpty((s as unknown as Record<string, unknown>)[k])) missing.push(`stages[${i}].${k}`);
  });
  return { ok: missing.length === 0, missing };
}

// ── Per-field creative suggestions (Phase 2 Rev 2) ──────────────────────────
// Every creative field can offer AI suggestions and a "Surprise Me". Selecting one
// changes ONLY that field (field isolation) via the pure applyConceptField below.

/** Fields the suggestion engine can propose values for. `family_*` target the
 *  family-level concept; `stage_*` target one stage (by index). */
export const SUGGEST_FIELDS = [
  "family_name", "stage_name", "family_theme", "family_palette", "family_lore",
  "family_evolution", "family_traits", "signature_ability", "flavour_text",
  "stage_colours", "stage_personality",
] as const;
export type SuggestField = (typeof SUGGEST_FIELDS)[number];

/** Lore tones the founder can switch between without regenerating the family. */
export const LORE_STYLES = ["Cute", "Funny", "Mysterious", "Legendary", "Adventure"] as const;
export type LoreStyle = (typeof LORE_STYLES)[number];

/** A precise pointer to ONE editable concept field. */
export type ConceptFieldTarget =
  | { scope: "family"; key: keyof FamilyLevelConcept }
  | { scope: "stage"; index: number; key: keyof StageConcept };

/**
 * PURE, immutable single-field update — the guarantee behind "changing one field must
 * NEVER overwrite unrelated work". Returns a NEW concept in which ONLY the targeted
 * field differs; every other family field and every other stage/field is untouched
 * (structurally shared). Used by every Select / Surprise Me action.
 */
export function applyConceptField(concept: FamilyConcept, target: ConceptFieldTarget, value: string): FamilyConcept {
  if (target.scope === "family") {
    return { ...concept, family: { ...concept.family, [target.key]: value } };
  }
  return {
    ...concept,
    stages: concept.stages.map((s, i) => (i === target.index ? { ...s, [target.key]: value } : s)),
  };
}

/** Existing names to check a proposed family against (case-insensitive). */
export interface ExistingNames {
  familyNames: string[];
  characterNames: string[];
  familyIds: string[];
}

/** Pure collision report — the founder can never silently overwrite/attach to an
 *  unrelated existing family. Compares the proposed family name + the 3 stage names
 *  (and, if given, a proposed family id) against what already exists. */
export function collisionReport(
  existing: ExistingNames,
  proposed: { familyName: string; stageNames: string[]; familyId?: string },
): { collides: boolean; conflicts: string[] } {
  const norm = (s: string) => s.trim().toLowerCase();
  const famSet = new Set(existing.familyNames.map(norm));
  const charSet = new Set(existing.characterNames.map(norm));
  const idSet = new Set(existing.familyIds.map(norm));
  const conflicts: string[] = [];
  if (proposed.familyName && famSet.has(norm(proposed.familyName))) conflicts.push(`family name "${proposed.familyName}"`);
  if (proposed.familyId && idSet.has(norm(proposed.familyId))) conflicts.push(`family code "${proposed.familyId}"`);
  for (const n of proposed.stageNames) {
    if (n && charSet.has(norm(n))) conflicts.push(`stage name "${n}"`);
  }
  return { collides: conflicts.length > 0, conflicts };
}
