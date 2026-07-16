/**
 * Starter Pokémon set dataset for the Knowledge Engine.
 *
 * IMPORTANT: this is NOT written to the canonical directory directly — it is
 * only importable as a DRAFT import run (Phase 17 workflow) that the founder
 * reviews and approves in the Knowledge Hub. Every record is marked
 * provisional with trusted_catalogue/community provenance; card counts are
 * only present where well-established (never guessed — unknown stays null).
 *
 * Set keys are the normalised, widely-used set codes (PTCGO/TCG-Live style for
 * English, official-style for Japanese). Regional editions are SEPARATE
 * records (e.g. EN 151 sv3pt5 vs JP 151 sv2a) linked via parentSetKey.
 */
import { normalizeSetCode } from "./set-code";

export interface StarterSetRecord {
  setKey: string;
  language: string; // catalogue language value ("en", "ja")
  canonicalName: string;
  setCode: string;
  series: string | null;
  era: "vintage" | "ex-dp" | "bw-xy" | "sm" | "swsh" | "sv";
  region: "western" | "japan";
  year: string;
  mainCount: number | null;
  secretCount: number | null;
  collectorNumberFormat: string | null;
  parentSetKey?: string | null;
  aliases?: { aliasType: "printed_code" | "ptcgo" | "market_name" | "jp_english_name"; aliasValue: string }[];
  notes?: string;
}

const s = (
  setCode: string,
  canonicalName: string,
  era: StarterSetRecord["era"],
  year: string,
  opts: Partial<StarterSetRecord> = {},
): StarterSetRecord => ({
  setKey: normalizeSetCode(setCode),
  language: opts.language ?? "en",
  canonicalName,
  setCode,
  series: opts.series ?? null,
  era,
  region: opts.region ?? "western",
  year,
  mainCount: opts.mainCount ?? null,
  secretCount: opts.secretCount ?? null,
  collectorNumberFormat: opts.collectorNumberFormat ?? null,
  parentSetKey: opts.parentSetKey ?? null,
  aliases: opts.aliases,
  notes: opts.notes,
});

export const STARTER_SETS: readonly StarterSetRecord[] = [
  // ── Vintage / WOTC ─────────────────────────────────────────────────────────
  s("base1", "Base Set", "vintage", "1999", { series: "Base", mainCount: 102, collectorNumberFormat: "58/102", aliases: [{ aliasType: "market_name", aliasValue: "base set" }] }),
  s("base2", "Jungle", "vintage", "1999", { series: "Base", mainCount: 64, collectorNumberFormat: "48/64" }),
  s("base3", "Fossil", "vintage", "1999", { series: "Base", mainCount: 62, collectorNumberFormat: "15/62" }),
  s("base4", "Base Set 2", "vintage", "2000", { series: "Base" }),
  s("base5", "Team Rocket", "vintage", "2000", { series: "Base" }),
  s("gym1", "Gym Heroes", "vintage", "2000", { series: "Gym" }),
  s("gym2", "Gym Challenge", "vintage", "2000", { series: "Gym" }),
  s("neo1", "Neo Genesis", "vintage", "2000", { series: "Neo" }),
  s("neo2", "Neo Discovery", "vintage", "2001", { series: "Neo" }),
  s("neo3", "Neo Revelation", "vintage", "2001", { series: "Neo" }),
  s("neo4", "Neo Destiny", "vintage", "2002", { series: "Neo" }),
  s("ecard1", "Expedition Base Set", "vintage", "2002", { series: "e-Card" }),
  s("ecard2", "Aquapolis", "vintage", "2003", { series: "e-Card" }),
  s("ecard3", "Skyridge", "vintage", "2003", { series: "e-Card" }),
  // ── EX / DP ────────────────────────────────────────────────────────────────
  s("ex1", "Ruby & Sapphire", "ex-dp", "2003", { series: "EX" }),
  s("ex7", "Team Rocket Returns", "ex-dp", "2004", { series: "EX" }),
  s("ex14", "Crystal Guardians", "ex-dp", "2006", { series: "EX" }),
  s("dp1", "Diamond & Pearl", "ex-dp", "2007", { series: "Diamond & Pearl" }),
  s("pl4", "Arceus", "ex-dp", "2009", { series: "Platinum" }),
  s("hgss1", "HeartGold & SoulSilver", "ex-dp", "2010", { series: "HGSS" }),
  // ── BW / XY ────────────────────────────────────────────────────────────────
  s("bw1", "Black & White", "bw-xy", "2011", { series: "Black & White" }),
  s("bw11", "Legendary Treasures", "bw-xy", "2013", { series: "Black & White", notes: "Radiant Collection subset (RC)." }),
  s("xy1", "XY Base", "bw-xy", "2014", { series: "XY" }),
  s("xy7", "Ancient Origins", "bw-xy", "2015", { series: "XY" }),
  s("xy12", "Evolutions", "bw-xy", "2016", { series: "XY", aliases: [{ aliasType: "ptcgo", aliasValue: "evo" }] }),
  s("g1", "Generations", "bw-xy", "2016", { series: "XY", notes: "Radiant Collection subset (RC)." }),
  // ── SM ─────────────────────────────────────────────────────────────────────
  s("sm1", "Sun & Moon Base", "sm", "2017", { series: "Sun & Moon" }),
  s("sm3", "Burning Shadows", "sm", "2017", { series: "Sun & Moon" }),
  s("sm35", "Shining Legends", "sm", "2017", { series: "Sun & Moon" }),
  s("sm9", "Team Up", "sm", "2019", { series: "Sun & Moon" }),
  s("sm115", "Hidden Fates", "sm", "2019", { series: "Sun & Moon", notes: "Shiny Vault subset (SV numbers)." }),
  s("sm12", "Cosmic Eclipse", "sm", "2019", { series: "Sun & Moon" }),
  // ── SWSH ───────────────────────────────────────────────────────────────────
  s("swsh1", "Sword & Shield Base", "swsh", "2020", { series: "Sword & Shield", aliases: [{ aliasType: "ptcgo", aliasValue: "ssh" }] }),
  s("swsh3", "Darkness Ablaze", "swsh", "2020", { series: "Sword & Shield" }),
  s("swsh35", "Champion's Path", "swsh", "2020", { series: "Sword & Shield" }),
  s("swsh4", "Vivid Voltage", "swsh", "2020", { series: "Sword & Shield" }),
  s("swsh45", "Shining Fates", "swsh", "2021", { series: "Sword & Shield", notes: "Shiny Vault subset (SV numbers)." }),
  s("swsh6", "Chilling Reign", "swsh", "2021", { series: "Sword & Shield" }),
  s("swsh7", "Evolving Skies", "swsh", "2021", { series: "Sword & Shield", aliases: [{ aliasType: "ptcgo", aliasValue: "evs" }] }),
  s("cel25", "Celebrations", "swsh", "2021", { series: "Sword & Shield", notes: "Classic Collection subset (CLC)." }),
  s("swsh8", "Fusion Strike", "swsh", "2021", { series: "Sword & Shield" }),
  s("swsh9", "Brilliant Stars", "swsh", "2022", { series: "Sword & Shield", collectorNumberFormat: "TG12/TG30", notes: "Trainer Gallery subset (TG)." }),
  s("swsh10", "Astral Radiance", "swsh", "2022", { series: "Sword & Shield", notes: "Trainer Gallery subset (TG)." }),
  s("pgo", "Pokémon GO", "swsh", "2022", { series: "Sword & Shield" }),
  s("swsh11", "Lost Origin", "swsh", "2022", { series: "Sword & Shield", notes: "Trainer Gallery subset (TG)." }),
  s("swsh12", "Silver Tempest", "swsh", "2022", { series: "Sword & Shield", notes: "Trainer Gallery subset (TG)." }),
  s("swsh12pt5", "Crown Zenith", "swsh", "2023", { series: "Sword & Shield", aliases: [{ aliasType: "ptcgo", aliasValue: "crz" }], notes: "Galarian Gallery subset (GG)." }),
  // ── SV ─────────────────────────────────────────────────────────────────────
  s("sv1", "Scarlet & Violet Base", "sv", "2023", { series: "Scarlet & Violet" }),
  s("sv2", "Paldea Evolved", "sv", "2023", { series: "Scarlet & Violet" }),
  s("sv3", "Obsidian Flames", "sv", "2023", { series: "Scarlet & Violet" }),
  s("sv3pt5", "151", "sv", "2023", { series: "Scarlet & Violet", aliases: [{ aliasType: "market_name", aliasValue: "151" }, { aliasType: "ptcgo", aliasValue: "mew" }], notes: "Poké Ball + Master Ball reverse finishes.", parentSetKey: normalizeSetCode("sv2a") }),
  s("sv4", "Paradox Rift", "sv", "2023", { series: "Scarlet & Violet" }),
  s("sv4pt5", "Paldean Fates", "sv", "2024", { series: "Scarlet & Violet", notes: "Shiny-heavy subset structure." }),
  s("sv5", "Temporal Forces", "sv", "2024", { series: "Scarlet & Violet" }),
  s("sv6", "Twilight Masquerade", "sv", "2024", { series: "Scarlet & Violet" }),
  s("sv6pt5", "Shrouded Fable", "sv", "2024", { series: "Scarlet & Violet" }),
  s("sv7", "Stellar Crown", "sv", "2024", { series: "Scarlet & Violet" }),
  s("sv8", "Surging Sparks", "sv", "2024", { series: "Scarlet & Violet" }),
  s("sv8pt5", "Prismatic Evolutions", "sv", "2025", { series: "Scarlet & Violet", notes: "Poké Ball + Master Ball reverse finishes." }),
  // ── Japanese editions (SEPARATE records; related via parentSetKey) ─────────
  s("sv2a", "Pokémon Card 151 (JP)", "sv", "2023", { language: "ja", region: "japan", series: "Scarlet & Violet (JP)", aliases: [{ aliasType: "jp_english_name", aliasValue: "pokemon card 151" }], notes: "Japanese source set for EN 151 (sv3pt5). Counts differ from EN — kept separate." }),
  s("s12a", "VSTAR Universe (JP)", "swsh", "2022", { language: "ja", region: "japan", series: "Sword & Shield (JP)", aliases: [{ aliasType: "jp_english_name", aliasValue: "vstar universe" }], notes: "Japanese source set for Crown Zenith." }),
  s("s8b", "VMAX Climax (JP)", "swsh", "2021", { language: "ja", region: "japan", series: "Sword & Shield (JP)", aliases: [{ aliasType: "jp_english_name", aliasValue: "vmax climax" }] }),
  s("sv4a", "Shiny Treasure ex (JP)", "sv", "2023", { language: "ja", region: "japan", series: "Scarlet & Violet (JP)", aliases: [{ aliasType: "jp_english_name", aliasValue: "shiny treasure ex" }] }),
];
