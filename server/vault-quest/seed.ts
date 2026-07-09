/**
 * Vault Quest — card master importer / seeder (Phase 3).
 *
 * DATASET-AGNOSTIC BY DESIGN. Point it at ANY Genesis Vault master CSV/JSON and
 * it imports without code changes — so when the canonical 150-card master
 * (VQ_GENESIS_VAULT_MASTER_SET_LIST_v1.0) lands, the same command imports it:
 *
 *     npx tsx server/vault-quest/seed.ts <master.csv>            # dry run (default)
 *     npx tsx server/vault-quest/seed.ts <master.csv> --commit   # write to DB
 *
 * It reuses the existing format-tolerant loader (lib/data.ts loadCards), derives
 * families + Evolves-From links FROM the card data itself (no dependency on a
 * separate registry file/name), validates every row (shared/vq-validate.ts), and
 * seeds vq_sets / vq_families / vq_game_config / vq_cards.
 *
 * SAFETY: dry run touches NO database (the storage/db layer is only imported in
 * --commit mode). --commit requires the vq_ tables to exist (the DB push is a
 * separate, founder-approved gate). Nothing here pushes a migration or deploys.
 */
import { loadCards } from "./lib/data";
import type { VqCard } from "./lib/types";
import {
  validateCardData,
  validateCardStructure,
  VQ_DEFAULT_VALIDATE_CONFIG,
  type VqCardData,
  type VqIssue,
} from "@shared/vq-validate";
import type { InsertVqCard, InsertVqFamily, InsertVqSet } from "@shared/vq-schema";

/**
 * Canonical game config — Rules v0.1 PLAYTEST LOCK (VQ_GAME_CONFIG_v0.1.csv).
 * Seeded into vq_game_config. Update here only when the rules version changes.
 */
export const VQ_GAME_CONFIG_V0_1: Record<string, string> = {
  rules_version: "v0.1",
  deck_size: "40",
  opening_hand: "5",
  copy_limit: "4",
  max_elements: "2",
  seal_count_to_win: "5",
  core_cap: "10",
  starting_core: "1",
  reserve_slots: "2",
  stage_2_ascend_cost: "2",
  stage_3_ascend_cost: "4",
  final_ko_seal_value: "2",
  vulnerability_bonus_damage: "2",
  first_player_skips_first_draw: "true",
};

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
}

/** familyId -> (stageNumber -> creature name), derived from the cards themselves. */
function buildFamilyStageMap(cards: VqCard[]): Map<string, Map<number, string>> {
  const map = new Map<string, Map<number, string>>();
  for (const c of cards) {
    if (c.card_type !== "Creature") continue;
    if ((c.source_base_card ?? "").trim()) continue; // base cards only — variants share family+stage but carry suffixed names
    const fam = (c.family_id ?? "").trim();
    if (!fam || !Number.isFinite(c.stage_number)) continue;
    if (!map.has(fam)) map.set(fam, new Map());
    map.get(fam)!.set(c.stage_number, c.card_name);
  }
  return map;
}

/** Evolves-From name for a card, derived from its family's earlier stage. */
function previousStageName(c: VqCard, familyStages: Map<string, Map<number, string>>): string {
  if (c.card_type !== "Creature" || !Number.isFinite(c.stage_number) || c.stage_number <= 1) return "";
  return familyStages.get((c.family_id ?? "").trim())?.get(c.stage_number - 1) ?? "";
}

/** Engine card -> validator input (camelCase), with a derived previousStage. */
export function cardToData(c: VqCard, previousStage: string): VqCardData {
  return {
    cardId: c.card_id,
    collectorNumber: c.collector_number,
    name: c.card_name,
    displayName: strOrNull(c.display_name) ?? undefined,
    cardType: c.card_type,
    element: c.element,
    rarity: c.rarity,
    familyId: strOrNull(c.family_id) ?? undefined,
    stageNumber: numOrNull(c.stage_number),
    lifeStage: strOrNull(c.life_stage),
    previousStage: strOrNull(previousStage),
    health: numOrNull(c.health),
    guard: numOrNull(c.guard),
    shift: numOrNull(c.shift),
    attack1Name: strOrNull(c.attack_1_name),
    attack1Cost: numOrNull(c.attack_1_cost),
    attack1Damage: numOrNull(c.attack_1_damage),
    attack1Effect: strOrNull(c.attack_1_effect),
    attack2Name: strOrNull(c.attack_2_name),
    attack2Cost: numOrNull(c.attack_2_cost),
    attack2Damage: numOrNull(c.attack_2_damage),
    attack2Effect: strOrNull(c.attack_2_effect),
    vulnerability: strOrNull(c.vulnerable_to),
    keywords: [],
    setCode: c.set_code,
    language: c.language,
    year: c.year,
    edition: c.edition,
  };
}

/**
 * Starting playtest balance = the deprecated 90-card set's stage scale
 * (OPEN-20 ruling: reuse it as the starting model, do NOT invent final balance).
 * Applied to creature BASE cards that arrive without stats; variants inherit
 * from their base and are left blank.
 */
export const STAT_SCALE: Record<number, { health: number; guard: number; shift: number }> = {
  1: { health: 5, guard: 0, shift: 0 },
  2: { health: 8, guard: 1, shift: 1 },
  3: { health: 12, guard: 3, shift: 2 },
};

export interface InsertCtx {
  variantTier?: string | null;
  baseCardId?: string | null;
  /** starting stats to apply if a creature base card has none (structure import). */
  statScale?: { health: number; guard: number; shift: number } | null;
}

/** Engine card -> DB insert row. Artwork R2 keys are set later via upload, not here. */
export function cardToInsert(c: VqCard, ctx: InsertCtx = {}): InsertVqCard {
  let health = numOrNull(c.health);
  let guard = numOrNull(c.guard);
  let shift = numOrNull(c.shift);
  // apply the starting scale only to a base creature that has no stats yet
  if (ctx.statScale && c.card_type === "Creature") {
    if (health === null) health = ctx.statScale.health;
    if (guard === null) guard = ctx.statScale.guard;
    if (shift === null) shift = ctx.statScale.shift;
  }
  return {
    cardId: c.card_id,
    collectorNumber: c.collector_number,
    name: c.card_name,
    displayName: strOrNull(c.display_name),
    cardType: c.card_type,
    element: c.element,
    rarity: strOrNull(c.rarity),
    familyId: strOrNull(c.family_id),
    stageNumber: numOrNull(c.stage_number),
    lifeStage: strOrNull(c.life_stage),
    health,
    guard,
    shift,
    attack1Name: strOrNull(c.attack_1_name),
    attack1Cost: numOrNull(c.attack_1_cost),
    attack1Damage: numOrNull(c.attack_1_damage),
    attack1Effect: strOrNull(c.attack_1_effect),
    attack2Name: strOrNull(c.attack_2_name),
    attack2Cost: numOrNull(c.attack_2_cost),
    attack2Damage: numOrNull(c.attack_2_damage),
    attack2Effect: strOrNull(c.attack_2_effect),
    vulnerability: strOrNull(c.vulnerable_to),
    keywords: [],
    variantTier: ctx.variantTier ?? strOrNull(c.variant_tier),
    baseCardId: ctx.baseCardId ?? null,
    setCode: c.set_code || "GNV",
    language: c.language || "EN",
    year: Number.isFinite(c.year) ? c.year : 2026,
    edition: c.edition || "FIRST EDITION",
    status: "draft",
  };
}

/** Derive family rows from the card data (no separate registry file needed). */
export function familiesFromCards(cards: VqCard[]): InsertVqFamily[] {
  const map = new Map<string, InsertVqFamily>();
  for (const c of cards) {
    if (c.card_type !== "Creature") continue;
    if (strOrNull(c.source_base_card)) continue; // only BASE cards define the family's stage names (variants carry suffixed names)
    const fam = strOrNull(c.family_id);
    if (!fam) continue;
    const row: InsertVqFamily =
      map.get(fam) ?? {
        familyId: fam,
        setCode: c.set_code || "GNV",
        element: c.element,
        name: strOrNull(c.family) ?? fam,
        stage1Name: null,
        stage2Name: null,
        stage3Name: null,
      };
    if (c.stage_number === 1) row.stage1Name = c.card_name;
    else if (c.stage_number === 2) row.stage2Name = c.card_name;
    else if (c.stage_number === 3) row.stage3Name = c.card_name;
    map.set(fam, row);
  }
  return [...map.values()];
}

/**
 * Cross-row integrity checks a single-card validator can't see: duplicate
 * card_id, duplicate collector number, or duplicate stage within a family
 * (all silent-data-loss traps in a hand-maintained master).
 */
export function findDuplicates(cards: VqCard[], checkFamilyStage = true): { cardId: string; issues: VqIssue[] }[] {
  const out: { cardId: string; issues: VqIssue[] }[] = [];
  // card_id + collector_number must ALWAYS be unique (real integrity).
  const idCounts = new Map<string, number>();
  for (const c of cards) idCounts.set(c.card_id, (idCounts.get(c.card_id) ?? 0) + 1);
  for (const [id, n] of idCounts) {
    if (n > 1) out.push({ cardId: id, issues: [{ level: "reject", field: "cardId", message: `duplicate card_id (${n} rows)` }] });
  }
  const collectorFirst = new Map<string, string>();
  const famStageFirst = new Map<string, string>();
  for (const c of cards) {
    const col = (c.collector_number ?? "").trim();
    if (col) {
      const prev = collectorFirst.get(col);
      if (prev && prev !== c.card_id) {
        out.push({ cardId: c.card_id, issues: [{ level: "reject", field: "collectorNumber", message: `duplicate collector number ${col} (also ${prev})` }] });
      } else if (!prev) collectorFirst.set(col, c.card_id);
    }
    // Family/stage uniqueness only holds for a full gameplay dataset. A set LIST
    // legitimately has alt-rarity VARIANTS that share family + stage with their
    // base card (e.g. "Flammi CHR" and "Flammi SRA" are both family F01 stage 1),
    // so this check is skipped in structure mode.
    if (checkFamilyStage && c.card_type === "Creature" && (c.family_id ?? "").trim() && Number.isFinite(c.stage_number)) {
      const key = `${(c.family_id ?? "").trim()}|${c.stage_number}`;
      const prev = famStageFirst.get(key);
      if (prev) {
        out.push({ cardId: c.card_id, issues: [{ level: "reject", field: "stageNumber", message: `duplicate stage ${c.stage_number} in family ${c.family_id} (also ${prev})` }] });
      } else famStageFirst.set(key, c.card_id);
    }
  }
  return out;
}

/** Derive the single set row. */
export function setFromCards(cards: VqCard[], rulesVersion = "v0.1"): InsertVqSet {
  const first = cards[0];
  return {
    setCode: first?.set_code || "GNV",
    name: "Genesis Vault",
    year: first && Number.isFinite(first.year) ? first.year : 2026,
    edition: first?.edition || "FIRST EDITION",
    rulesVersion,
    cardCount: cards.length,
  };
}

export interface ImportReport {
  file: string;
  /** "full" gameplay dataset (has stats) vs "structure" set-list (draft shells, stats authored later). */
  mode: "full" | "structure";
  note?: string;
  total: number;
  valid: number;
  invalid: number;
  warnings: number;
  byType: Record<string, number>;
  families: number;
  baseCreaturesWithStats: number;
  variantsLinked: number;
  sample: { cardId: string; variantTier: string | null; baseCardId: string | null; health: number | null; guard: number | null; shift: number | null }[];
  gameConfigKeys: number;
  rejects: { cardId: string; issues: VqIssue[] }[];
  committed: boolean;
  wrote: number;
}

/**
 * Parse + validate a master file and (optionally) seed the DB.
 * @param opts.commit  when true, writes set/families/config/cards to the DB
 *                     (requires the vq_ tables to exist — the push is gated).
 */
export async function importMaster(
  csvPath: string,
  opts: { commit?: boolean; editedBy?: string } = {},
): Promise<ImportReport> {
  const cards = loadCards(csvPath);
  const familyStages = buildFamilyStageMap(cards);

  // A set-LIST (no creature carries stats) imports as draft shells; a full
  // gameplay dataset (creatures have stats) gets the strict gameplay validation.
  const hasStats = cards.some((c) => c.card_type === "Creature" && Number.isFinite(c.health));
  const mode: "full" | "structure" = hasStats ? "full" : "structure";

  const results = cards.map((c) => {
    const data = cardToData(c, previousStageName(c, familyStages));
    const result =
      mode === "structure"
        ? validateCardStructure(data, VQ_DEFAULT_VALIDATE_CONFIG)
        : validateCardData(data, VQ_DEFAULT_VALIDATE_CONFIG);
    return { card: c, result };
  });

  // Variant linkage + starting-stat context (OPEN-20 / OPEN-22): base creatures
  // get the 90-card starting scale; variants link to their base and inherit.
  const cardIdByCollector = new Map<string, string>();
  for (const c of cards) {
    const col = (c.collector_number ?? "").trim();
    if (col && !cardIdByCollector.has(col)) cardIdByCollector.set(col, c.card_id);
  }
  const ctxFor = (c: VqCard): InsertCtx => {
    const baseCollector = strOrNull(c.source_base_card);
    const isVariant = baseCollector !== null;
    const stage = c.stage_number;
    return {
      variantTier: strOrNull(c.variant_tier),
      baseCardId: isVariant ? cardIdByCollector.get(baseCollector) ?? null : null,
      statScale:
        mode === "structure" && c.card_type === "Creature" && !isVariant && Number.isFinite(stage) && STAT_SCALE[stage]
          ? STAT_SCALE[stage]
          : null,
    };
  };
  const inserts = cards.map((c) => cardToInsert(c, ctxFor(c)));

  const byType: Record<string, number> = {};
  for (const c of cards) byType[c.card_type] = (byType[c.card_type] ?? 0) + 1;

  const cardRejects = results
    .filter((r) => !r.result.ok)
    .map((r) => ({ cardId: r.card.card_id, issues: r.result.issues.filter((i) => i.level === "reject") }));
  const rejects = [...cardRejects, ...findDuplicates(cards, mode === "full")];
  const warnings = results.reduce((n, r) => n + r.result.issues.filter((i) => i.level === "warn").length, 0);
  const families = familiesFromCards(cards);

  const report: ImportReport = {
    file: csvPath,
    mode,
    note:
      mode === "structure"
        ? "Set-LIST import (draft shells): this file has no gameplay stats/effects, and element/rarity/type taxonomy is NOT enforced here — author stats and reconcile the element roster before any card can render, be approved, or be played."
        : undefined,
    total: cards.length,
    valid: cards.length - new Set(rejects.map((r) => r.cardId)).size,
    invalid: rejects.length,
    warnings,
    byType,
    families: families.length,
    baseCreaturesWithStats: inserts.filter((i) => i.cardType === "Creature" && i.baseCardId == null && i.health != null).length,
    variantsLinked: inserts.filter((i) => i.baseCardId != null).length,
    sample: inserts.slice(0, 3).map((i) => ({
      cardId: i.cardId,
      variantTier: i.variantTier ?? null,
      baseCardId: i.baseCardId ?? null,
      health: i.health ?? null,
      guard: i.guard ?? null,
      shift: i.shift ?? null,
    })),
    gameConfigKeys: Object.keys(VQ_GAME_CONFIG_V0_1).length,
    rejects,
    committed: false,
    wrote: 0,
  };

  if (opts.commit) {
    if (rejects.length > 0) {
      throw new Error(`Refusing to commit: ${rejects.length} card(s) fail validation. Run without --commit to see them.`);
    }
    // storage (and the DB pool) is only imported in commit mode, so dry runs
    // never require a database connection.
    const { vqStorage } = await import("./storage");
    await vqStorage.upsertSet(setFromCards(cards, VQ_GAME_CONFIG_V0_1.rules_version));
    for (const f of families) await vqStorage.upsertFamily(f);
    for (const [key, value] of Object.entries(VQ_GAME_CONFIG_V0_1)) await vqStorage.setConfig(key, value);
    let wrote = 0;
    for (const ins of inserts) {
      await vqStorage.saveCard(ins, opts.editedBy ?? "seed");
      wrote++;
    }
    report.committed = true;
    report.wrote = wrote;
  }

  return report;
}

// ---- CLI entry (runs only when invoked directly, not when imported) ----
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  const commit = args.includes("--commit");
  if (!csvPath) {
    console.error("usage: tsx server/vault-quest/seed.ts <master.csv|json> [--commit]");
    process.exit(1);
  }
  const report = await importMaster(csvPath, { commit });
  const { rejects, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  if (rejects.length) {
    console.log(`\n${rejects.length} card(s) failed validation:`);
    for (const r of rejects.slice(0, 25)) {
      console.log(`  ${r.cardId}: ${r.issues.map((i) => `${i.field} ${i.message}`).join("; ")}`);
    }
    if (!commit) console.log("\n(dry run — nothing written. Fix rejects, then re-run with --commit once the vq_ tables exist.)");
    process.exit(commit ? 1 : 0);
  }
  if (!commit) console.log("\nAll cards valid. Dry run — nothing written. Re-run with --commit (after the DB push) to seed.");
}

if (process.argv[1] && /vault-quest[/\\]seed\.(ts|js|cjs)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
