// =============================================================================
// VAULT QUEST — shared card + deck validation (Phase 3)
// Pure, dependency-free, shared by server (admin save / seed import) and the
// future deck builder. Validates CARD DATA and DECKS for structural + print
// integrity BEFORE it reaches the DB / publish / print.
//
// NOTE: this is distinct from the RENDER-time QA in
// server/vault-quest/lib/qa.ts (which scans the rendered SVG and enforces the
// template stage-lock). This module is the data/print/deck layer.
//
// Numeric RANGE checks are config-driven (see VqValidateConfig) and default to
// lenient, because the canonical stat scale is set by the 150-card master
// (VQ_GENESIS_VAULT_MASTER_SET_LIST_v1.0) + vq_game_config — not assumed here.
// =============================================================================

export type VqIssueLevel = "reject" | "warn";
export interface VqIssue {
  level: VqIssueLevel;
  field: string;
  message: string;
}
export interface VqValidateResult {
  ok: boolean; // true when there are zero "reject" issues
  issues: VqIssue[];
}

// Locked enums (Master Spec §5, §9). Elements/rarities/types are card DATA;
// the render engine owns the visual palette. Kept in sync manually.
export const VQ_ELEMENTS = [
  "Flame",
  "Water",
  "Nature",
  "Storm",
  "Stone",
  "Shadow",
  "Neutral",
] as const;
export type VqElement = (typeof VQ_ELEMENTS)[number];

// Creature = the creature grid; the rest render via the support template.
// Collector/Place are stat-less card types from the 150-card commercial master.
// NOTE: "Core"/"Token" are NOT added here — the locked render engine's QA rejects
// unknown card types, so offering them would create un-renderable cards. They're
// gated on a locked-renderer extension (founder approval).
export const VQ_CARD_TYPES = ["Creature", "Tactic", "Relic", "Vault", "Collector", "Place"] as const;
export type VqCardType = (typeof VQ_CARD_TYPES)[number];
export const VQ_SUPPORT_TYPES: readonly VqCardType[] = ["Tactic", "Relic", "Vault", "Collector", "Place"];

// C/U/R/SR/GR/UR are the base ladder; SRA/RR/FSR/CR are 150-master variant tiers.
export const VQ_RARITIES = ["C", "U", "R", "SR", "GR", "UR", "SRA", "RR", "FSR", "CR"] as const;
export type VqRarity = (typeof VQ_RARITIES)[number];

export const VQ_STAGES = [1, 2, 3] as const;
export type VqStage = (typeof VQ_STAGES)[number];

// Banned terms — the anti-Pokemon lexicon (Master Spec §13). Word-boundary,
// case-insensitive; use the VQ terms (Health/Guard/Shift/Core/Vulnerability).
export const VQ_BANNED_TERMS = [
  "HP",
  "Pokemon",
  "Pokémon",
  "Weakness",
  "Resistance",
  "Retreat",
] as const;

// A normalised (camelCase) card record — the shape the admin editor produces
// and the seed importer maps CSV rows into. Superset; support cards leave the
// creature-only fields undefined.
export interface VqCardData {
  cardId?: string;
  collectorNumber?: string;
  name?: string;
  displayName?: string;
  cardType?: string;
  element?: string;
  rarity?: string;
  familyId?: string;
  stageNumber?: number | null;
  lifeStage?: string | null;
  previousStage?: string | null;
  health?: number | null;
  guard?: number | null;
  shift?: number | null;
  attack1Name?: string | null;
  attack1Cost?: number | null;
  attack1Damage?: number | null;
  attack1Effect?: string | null;
  attack2Name?: string | null;
  attack2Cost?: number | null;
  attack2Damage?: number | null;
  attack2Effect?: string | null;
  vulnerability?: string | null;
  keywords?: string[];
  setCode?: string;
  language?: string;
  year?: number;
  edition?: string;
}

export interface VqValidateConfig {
  setCode: string; // e.g. "GNV"
  year: number; // e.g. 2026
  cardIdPrefix: string; // e.g. "GNV-"
  nameMax: number; // print-layout cap
  attackNameMax: number;
  costMax: number;
  // Range checks run ONLY when the bound is a number (undefined = don't enforce).
  healthMin?: number;
  healthMax?: number;
  damageMin?: number;
  damageMax?: number;
  guardMax?: number;
  shiftMax?: number;
}

// Defaults derived from the build plan's print-layout validators. Numeric stat
// ranges are intentionally left UNENFORCED until the canonical 150-card master
// + vq_game_config lock the stat scale (OPEN-13 / OPEN-15). Callers that know
// the locked scale pass explicit bounds.
export const VQ_DEFAULT_VALIDATE_CONFIG: VqValidateConfig = {
  setCode: "GNV",
  year: 2026,
  cardIdPrefix: "GNV-",
  nameMax: 25,
  attackNameMax: 18,
  costMax: 6,
  // healthMin/Max, damageMin/Max, guardMax, shiftMax: undefined = not enforced yet
};

const bannedRegexes = VQ_BANNED_TERMS.map(
  (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
);

function scanBanned(field: string, value: string | null | undefined, issues: VqIssue[]): void {
  if (!value) return;
  const v = value.normalize("NFC"); // fold decomposed accents (e.g. Pokémon → Pokémon)
  for (let i = 0; i < bannedRegexes.length; i++) {
    if (bannedRegexes[i].test(v)) {
      issues.push({
        level: "reject",
        field,
        message: `contains banned term "${VQ_BANNED_TERMS[i]}" — use the Vault Quest lexicon (Health/Guard/Shift/Core/Vulnerability)`,
      });
    }
  }
}

function req(
  field: string,
  value: string | number | null | undefined,
  issues: VqIssue[],
): void {
  if (value === undefined || value === null || value === "") {
    issues.push({ level: "reject", field, message: "is required" });
  }
}

function inRange(
  field: string,
  value: number | null | undefined,
  min: number | undefined,
  max: number | undefined,
  issues: VqIssue[],
): void {
  if (value === undefined || value === null) return;
  if (min !== undefined && value < min) {
    issues.push({ level: "reject", field, message: `must be ≥ ${min} (got ${value})` });
  }
  if (max !== undefined && value > max) {
    issues.push({ level: "reject", field, message: `must be ≤ ${max} (got ${value})` });
  }
}

/**
 * Validate a single card record. Returns `ok: false` if any "reject" issue.
 */
export function validateCardData(
  card: VqCardData,
  cfg: VqValidateConfig = VQ_DEFAULT_VALIDATE_CONFIG,
): VqValidateResult {
  const issues: VqIssue[] = [];

  // Identity + locked constants
  req("cardId", card.cardId, issues);
  req("name", card.name, issues);
  req("cardType", card.cardType, issues);
  req("element", card.element, issues);
  req("rarity", card.rarity, issues);

  if (card.cardId && !card.cardId.startsWith(cfg.cardIdPrefix)) {
    issues.push({ level: "reject", field: "cardId", message: `must start with "${cfg.cardIdPrefix}"` });
  }
  if (card.setCode && card.setCode !== cfg.setCode) {
    issues.push({ level: "reject", field: "setCode", message: `must be "${cfg.setCode}"` });
  }
  if (card.year !== undefined && card.year !== cfg.year) {
    issues.push({ level: "reject", field: "year", message: `must be ${cfg.year}` });
  }
  if (card.collectorNumber && !/^\d{3}\/\d{3}$/.test(card.collectorNumber)) {
    issues.push({ level: "warn", field: "collectorNumber", message: "expected NNN/NNN" });
  }

  // Enum membership
  if (card.cardType && !(VQ_CARD_TYPES as readonly string[]).includes(card.cardType)) {
    issues.push({ level: "reject", field: "cardType", message: `not one of ${VQ_CARD_TYPES.join(", ")}` });
  }
  if (card.element && !(VQ_ELEMENTS as readonly string[]).includes(card.element)) {
    issues.push({ level: "reject", field: "element", message: `not a Vault Quest element` });
  }
  if (card.rarity && !(VQ_RARITIES as readonly string[]).includes(card.rarity)) {
    issues.push({ level: "reject", field: "rarity", message: `not one of ${VQ_RARITIES.join(", ")}` });
  }

  // Print-layout caps
  if (card.name && card.name.length > cfg.nameMax) {
    issues.push({ level: "reject", field: "name", message: `over ${cfg.nameMax} chars` });
  }
  for (const [f, v] of [
    ["attack1Name", card.attack1Name],
    ["attack2Name", card.attack2Name],
  ] as const) {
    if (v && v.length > cfg.attackNameMax) {
      issues.push({ level: "reject", field: f, message: `over ${cfg.attackNameMax} chars` });
    }
  }

  const isSupport = card.cardType !== undefined && VQ_SUPPORT_TYPES.includes(card.cardType as VqCardType);

  if (!isSupport && card.cardType === "Creature") {
    // Creature-only structural rules
    req("stageNumber", card.stageNumber, issues);
    req("health", card.health, issues);
    if (card.stageNumber !== undefined && card.stageNumber !== null) {
      if (!(VQ_STAGES as readonly number[]).includes(card.stageNumber)) {
        issues.push({ level: "reject", field: "stageNumber", message: "must be 1, 2 or 3" });
      }
      // Stage-lock (Master Spec §6/§7)
      if (card.stageNumber === 1 && card.previousStage) {
        issues.push({ level: "reject", field: "previousStage", message: "Stage 1 must not have a previous stage" });
      }
      if ((card.stageNumber === 2 || card.stageNumber === 3) && !card.previousStage) {
        issues.push({ level: "reject", field: "previousStage", message: `Stage ${card.stageNumber} must name its previous stage (Evolves From)` });
      }
      // life-stage vocabulary (warn — display name is OPEN-04)
      const expected = card.stageNumber === 1 ? "BABY" : card.stageNumber === 2 ? "TEEN" : "FINAL";
      if (card.lifeStage && card.lifeStage.toUpperCase() !== expected) {
        issues.push({ level: "warn", field: "lifeStage", message: `expected ${expected} for stage ${card.stageNumber}` });
      }
    }
    if (card.guard === undefined || card.guard === null) issues.push({ level: "warn", field: "guard", message: "Guard not set" });
    if (card.shift === undefined || card.shift === null) issues.push({ level: "warn", field: "shift", message: "Shift not set" });
    if (!card.vulnerability) issues.push({ level: "warn", field: "vulnerability", message: "Vulnerability not set" });

    // Config-driven numeric ranges (only enforced when bounds are provided)
    inRange("health", card.health, cfg.healthMin, cfg.healthMax, issues);
    inRange("guard", card.guard, 0, cfg.guardMax, issues);
    inRange("shift", card.shift, 0, cfg.shiftMax, issues);
    inRange("attack1Damage", card.attack1Damage, cfg.damageMin, cfg.damageMax, issues);
    inRange("attack2Damage", card.attack2Damage, cfg.damageMin, cfg.damageMax, issues);
  }

  // Attack Core cost cap (both card types may carry costs)
  inRange("attack1Cost", card.attack1Cost, 0, cfg.costMax, issues);
  inRange("attack2Cost", card.attack2Cost, 0, cfg.costMax, issues);

  // Banned terms across every text field
  scanBanned("name", card.name, issues);
  scanBanned("displayName", card.displayName, issues);
  scanBanned("attack1Name", card.attack1Name, issues);
  scanBanned("attack1Effect", card.attack1Effect, issues);
  scanBanned("attack2Name", card.attack2Name, issues);
  scanBanned("attack2Effect", card.attack2Effect, issues);
  scanBanned("vulnerability", card.vulnerability, issues);

  return { ok: !issues.some((i) => i.level === "reject"), issues };
}

/**
 * STRUCTURE / draft validation — for importing a SET LIST (collector numbers,
 * names, families, stages, rarity, variant tier) as draft card shells whose
 * gameplay stats + final element/rarity/type taxonomy are authored/reconciled
 * later. Deliberately does NOT enforce the gameplay enums (element/rarity/type)
 * or require stats — those are checked when a card is authored and approved, not
 * when the canonical set list is first imported. Still enforces identity, the
 * card-id prefix, print name cap (as a warning), and the banned-term lexicon.
 */
export function validateCardStructure(
  card: VqCardData,
  cfg: VqValidateConfig = VQ_DEFAULT_VALIDATE_CONFIG,
): VqValidateResult {
  const issues: VqIssue[] = [];
  req("cardId", card.cardId, issues);
  req("collectorNumber", card.collectorNumber, issues);
  req("name", card.name, issues);
  req("cardType", card.cardType, issues);
  req("element", card.element, issues);
  req("rarity", card.rarity, issues);

  if (card.cardId && !card.cardId.startsWith(cfg.cardIdPrefix)) {
    issues.push({ level: "reject", field: "cardId", message: `must start with "${cfg.cardIdPrefix}"` });
  }
  if (card.collectorNumber && !/^\d{3}\/\d{3}$/.test(card.collectorNumber)) {
    issues.push({ level: "warn", field: "collectorNumber", message: "expected NNN/NNN" });
  }
  if (card.name && card.name.length > cfg.nameMax) {
    issues.push({ level: "warn", field: "name", message: `over ${cfg.nameMax} chars (print cap)` });
  }
  scanBanned("name", card.name, issues);
  scanBanned("displayName", card.displayName, issues);
  scanBanned("vulnerability", card.vulnerability, issues);

  return { ok: !issues.some((i) => i.level === "reject"), issues };
}

// --------------------------- deck validation --------------------------------
// Config-driven (rules-as-data, Master Spec §11/§16). Values come from
// vq_game_config; no rule number is hard-coded here.
export interface VqDeckConfig {
  deckSize: number; // e.g. 40
  copyLimit: number; // e.g. 4 (per distinct card)
  maxElements: number; // e.g. 2
}

export interface VqDeckEntry {
  cardId: string;
  count: number;
  element?: string;
  cardType?: string;
}

export function validateDeck(entries: VqDeckEntry[], cfg: VqDeckConfig): VqValidateResult {
  const issues: VqIssue[] = [];
  // Core cards are excluded from the deck count (Master Spec §16); "Vault" rules
  // are pending the Vault card-type definition (TODO / OPEN).
  const counted = entries.filter((e) => e.cardType !== "Core");
  const total = counted.reduce((s, e) => s + e.count, 0);

  if (total !== cfg.deckSize) {
    issues.push({ level: "reject", field: "deck", message: `deck must be exactly ${cfg.deckSize} cards (got ${total})` });
  }
  for (const e of counted) {
    if (e.count > cfg.copyLimit) {
      issues.push({ level: "reject", field: e.cardId, message: `max ${cfg.copyLimit} copies (got ${e.count})` });
    }
  }
  const elements = new Set(counted.map((e) => e.element).filter(Boolean));
  if (elements.size > cfg.maxElements) {
    issues.push({ level: "reject", field: "deck", message: `at most ${cfg.maxElements} elements (got ${elements.size})` });
  }
  return { ok: !issues.some((i) => i.level === "reject"), issues };
}
