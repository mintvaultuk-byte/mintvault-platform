import fs from "fs";
import nodePath from "path";
import type { VqCard } from "./types";

// Minimal RFC-4180-ish CSV parser (quoted fields, embedded commas/quotes). No deps.
function parseCsv(raw: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && raw[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const NUMERIC_FIELDS = [
  "stage_number", "health", "guard", "shift", "year",
  "attack_1_cost", "attack_1_damage", "attack_2_cost", "attack_2_damage",
] as const;

function toCard(rec: Record<string, unknown>): VqCard {
  const card = { ...rec } as Record<string, unknown>;
  for (const f of NUMERIC_FIELDS) {
    const v = String(card[f] ?? "").trim();
    card[f] = v === "" ? NaN : Number(v);
  }
  for (const [k, v] of Object.entries(card)) if (typeof v === "string") card[k] = v.trim();
  return card as unknown as VqCard;
}

/** Locked constants applied to every card built from the Genesis Vault master. */
export const LOCKED_CONSTANTS = { set_code: "GNV", year: 2026, edition: "FIRST EDITION", language: "EN" } as const;

/** Detects the official 90-card master format by its distinctive header columns. */
function isMasterFormat(rec: Record<string, unknown>): boolean {
  return "Card No" in rec && "Stage Role" in rec && "Attack 1 Damage" in rec;
}

const LIFE_STAGE = new Map<string, string>([["Baby", "BABY"], ["Teen", "TEEN"], ["Final", "FINAL"]]);

/** slug for artwork filename convention: 001 + flammi -> "001_flammi" (matches the pack's art/ files). */
function artSlug(collector: string, name: string): string {
  const num = collector.split("/")[0];
  return `${num}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
}

/**
 * Maps a row from VQ_GENESIS_VAULT_SET001_90_CARD_MASTER onto the builder's card
 * shape. previous_stage + previous artwork come from the family registry (a
 * deterministic join, not a guess); set_code/year/edition/language come from the
 * locked constants; attack cost + effect are read from the master when those
 * columns exist (e.g. "Attack 1 Cost" / "Attack 1 Effect"), else default to 0 /
 * blank — the 90-card master prints neither (Rules v0.1 §11: attacks are free
 * unless a printed Core cost is stated).
 */
function fromMasterRow(rec: Record<string, string>, registry: Map<string, string[]>, collectorByName: Map<string, string>): VqCard {
  const s = (k: string) => String(rec[k] ?? "").trim();
  const n = (k: string) => Number(s(k) || "NaN");
  const stage = n("Stage");
  const familyId = s("Family ID");
  const stages = registry.get(familyId) ?? []; // [stage1name, stage2name, stage3name]
  const prevName = stage >= 2 ? (stages[stage - 2] ?? "") : "";
  const prevCollector = prevName ? (collectorByName.get(prevName) ?? "") : "";
  const collector = s("Card No");
  const name = s("Card Name");

  return {
    collector_number: collector,
    card_id: s("Card ID"),
    card_name: name,
    display_name: name,
    card_type: s("Card Type"),
    element: s("Element"),
    family_id: familyId,
    family: s("Family"),
    stage_number: stage,
    life_stage: LIFE_STAGE.get(s("Stage Role")) ?? s("Stage Role").toUpperCase(),
    previous_stage: prevName,
    health: n("Health"),
    guard: n("Guard"),
    shift: n("Shift"),
    vulnerable_to: s("Vulnerability"),
    attack_1_cost: Number(s("Attack 1 Cost")) || 0,
    attack_1_name: s("Attack 1"),
    attack_1_damage: n("Attack 1 Damage"),
    attack_1_effect: s("Attack 1 Effect"),
    attack_2_cost: Number(s("Attack 2 Cost")) || 0,
    attack_2_name: s("Attack 2"),
    attack_2_damage: n("Attack 2 Damage"),
    attack_2_effect: s("Attack 2 Effect"),
    rarity: s("Rarity"),
    set_code: LOCKED_CONSTANTS.set_code,
    language: LOCKED_CONSTANTS.language,
    year: LOCKED_CONSTANTS.year,
    edition: LOCKED_CONSTANTS.edition,
    artwork_file: `${artSlug(collector, name)}.png`,
    prev_artwork_file: prevName && prevCollector ? `${artSlug(prevCollector, prevName)}.png` : "",
  };
}

/** Loads the family registry (Family ID -> [stage1, stage2, stage3] names) if present next to the master. */
function loadRegistry(masterPath: string): Map<string, string[]> {
  const dir = nodePath.dirname(masterPath);
  const regPath = nodePath.join(dir, "VQ_SET001_FAMILY_REGISTRY_18_LINES_v1.0.csv");
  const map = new Map<string, string[]>();
  if (!fs.existsSync(regPath)) return map;
  for (const r of parseCsv(fs.readFileSync(regPath, "utf8"))) {
    map.set(r["Family ID"], [r["Stage 1"], r["Stage 2"], r["Stage 3"]]);
  }
  return map;
}

/** Cards are generated from CSV/JSON data ONLY — there is no other input path. */
export function loadCards(path: string): VqCard[] {
  const raw = fs.readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed.cards;
    if (!Array.isArray(arr)) throw new Error("JSON input must be an array of cards or {cards:[...]}");
    return arr.map(toCard);
  }
  if (path.endsWith(".csv")) {
    const rows = parseCsv(raw);
    if (rows.length && isMasterFormat(rows[0])) {
      const registry = loadRegistry(path);
      const collectorByName = new Map(rows.map((r) => [String(r["Card Name"] ?? "").trim(), String(r["Card No"] ?? "").trim()]));
      return rows.map((r) => fromMasterRow(r, registry, collectorByName));
    }
    return rows.map(toCard);
  }
  throw new Error(`Unsupported input: ${path} — cards are generated from CSV/JSON data only`);
}
