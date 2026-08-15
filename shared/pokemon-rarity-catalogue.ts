/**
 * Structured Pokémon rarity + variant catalogue (grading admin).
 *
 * The existing grader uses ONE flat `variant` field / `VARIANT_OPTIONS` list that mixes
 * rarities, finishes and subsets together ("Reverse Holo", "Illustration Rare",
 * "Trainer Gallery", "1st Edition", "Full Art" …). This module replaces that with FOUR
 * independent classifications so each concept is stored + rendered separately:
 *
 *   1. Language / Region   (POKEMON_LANGUAGES)
 *   2. Printed Rarity      (POKEMON_RARITIES — symbol shape + colour + code)
 *   3. Finish / Variant    (POKEMON_FINISHES)
 *   4. Promo / Subset      (POKEMON_PROMOS)
 *
 * PURE + shared: data + deterministic helpers only (no DOM, no network, no Node APIs).
 * The visual picker renders the symbol metadata; the server stores each classification
 * in its own column. Nothing here changes existing certificates — {@link mapLegacyVariant}
 * only PROPOSES a structured mapping for historical `variant` codes, flagging ambiguous
 * ones for admin review.
 */

// ── 1 · Language / Region ────────────────────────────────────────────────────────
export interface PokemonLanguage {
  value: string;
  label: string;
  /** ISO-ish region hint used for rarity filtering (rarity codes differ by region). */
  region: "western" | "japan" | "korea" | "china" | "sea" | "other";
  aliases: string[];
}

export const POKEMON_LANGUAGES: readonly PokemonLanguage[] = [
  { value: "en", label: "English", region: "western", aliases: ["english", "eng", "en", "us", "uk"] },
  { value: "es", label: "Spanish", region: "western", aliases: ["spanish", "es", "espanol", "español", "castellano"] },
  { value: "fr", label: "French", region: "western", aliases: ["french", "fr", "francais", "français"] },
  { value: "de", label: "German", region: "western", aliases: ["german", "de", "deutsch"] },
  { value: "it", label: "Italian", region: "western", aliases: ["italian", "it", "italiano"] },
  { value: "pt", label: "Portuguese", region: "western", aliases: ["portuguese", "pt", "portugues", "português"] },
  { value: "ja", label: "Japanese", region: "japan", aliases: ["japanese", "jp", "ja", "japan", "nihongo"] },
  { value: "ko", label: "Korean", region: "korea", aliases: ["korean", "ko", "kr", "korea", "hangul"] },
  { value: "zh-cn", label: "Simplified Chinese", region: "china", aliases: ["simplified chinese", "simplified", "zh-hans", "zh-cn", "s-chinese", "cn"] },
  { value: "zh-tw", label: "Traditional Chinese", region: "china", aliases: ["traditional chinese", "traditional", "zh-hant", "zh-tw", "t-chinese", "tw", "hk"] },
  { value: "id", label: "Indonesian", region: "sea", aliases: ["indonesian", "id", "indonesia", "bahasa"] },
  { value: "th", label: "Thai", region: "sea", aliases: ["thai", "th", "thailand"] },
  { value: "other", label: "Other", region: "other", aliases: ["other", "misc", "unknown"] },
] as const;

// ── Set era (rarity availability differs by era) ─────────────────────────────────
export type PokemonEra =
  | "vintage" // WotC / e-Card (1999–2003)
  | "ex-dp" // EX → Diamond & Pearl (2003–2010)
  | "bw-xy" // Black&White → XY (2011–2016)
  | "sm" // Sun & Moon (2017–2019)
  | "swsh" // Sword & Shield (2020–2022)
  | "sv"; // Scarlet & Violet (2023+)

export const POKEMON_ERAS: readonly { value: PokemonEra; label: string }[] = [
  { value: "vintage", label: "Vintage (WotC / e-Card)" },
  { value: "ex-dp", label: "EX – Diamond & Pearl" },
  { value: "bw-xy", label: "Black & White – XY" },
  { value: "sm", label: "Sun & Moon" },
  { value: "swsh", label: "Sword & Shield" },
  { value: "sv", label: "Scarlet & Violet" },
];

// ── 2 · Printed Rarity ───────────────────────────────────────────────────────────
export type SymbolShape = "circle" | "diamond" | "star" | "stars" | "shiny" | "text" | "none";
/** The colour is DATA (not just CSS) so gold vs silver and 2★ vs 1★ are distinguishable
 *  without relying on text colour — the picker fills the symbol with this colour. */
export type SymbolColour = "black" | "white" | "silver" | "gold" | "bronze" | "rainbow" | "none";

export interface RaritySymbol {
  shape: SymbolShape;
  /** Number of stars for shape="stars"/"star" (1, 2 or 3). */
  count?: number;
  colour: SymbolColour;
  /** A glyph fallback for plain-text contexts (the picker draws the real symbol). */
  glyph: string;
}

export type RegionScope = "all" | PokemonLanguage["region"][];

export interface PokemonRarity {
  value: string; // canonical, unique machine value (stored in its own column)
  label: string; // short founder-facing label
  description: string; // plain-English
  symbol: RaritySymbol;
  /** Printed abbreviation codes shown/searched (e.g. "SAR", "RR"). Also used for search. */
  codes: string[];
  /** Regions where this rarity is printed ("all" or a subset). Drives filtering. */
  regions: RegionScope;
  /** Set eras where this rarity exists ("all" or a subset). Drives filtering. */
  eras: PokemonEra[] | "all";
  aliases: string[];
}

const r = (x: PokemonRarity): PokemonRarity => x;

export const POKEMON_RARITIES: readonly PokemonRarity[] = [
  // ── Modern English (Scarlet & Violet symbol set) ──────────────────────────────
  r({ value: "common", label: "Common", description: "A common card — a filled black circle.", symbol: { shape: "circle", colour: "black", glyph: "●" }, codes: ["C"], regions: "all", eras: "all", aliases: ["common", "circle", "dot"] }),
  r({ value: "uncommon", label: "Uncommon", description: "An uncommon card — a black diamond.", symbol: { shape: "diamond", colour: "black", glyph: "◆" }, codes: ["U"], regions: "all", eras: "all", aliases: ["uncommon", "diamond"] }),
  r({ value: "rare", label: "Rare", description: "A rare card — a single black star.", symbol: { shape: "star", count: 1, colour: "black", glyph: "★" }, codes: ["R"], regions: "all", eras: "all", aliases: ["rare", "star", "one star", "black star"] }),
  r({ value: "holo_rare_v", label: "Holo Rare V", description: "Sword & Shield Pokémon V card class with holo finish tracked separately.", symbol: { shape: "star", count: 1, colour: "silver", glyph: "★" }, codes: ["V"], regions: ["western"], eras: ["swsh"], aliases: ["holo rare v", "holo rara v", "rare holo v", "rare v", "rara v", "pokemon v", "pokémon v"] }),
  r({ value: "double_rare", label: "Double Rare", description: "Two black stars — the modern ex / high-HP rare.", symbol: { shape: "stars", count: 2, colour: "black", glyph: "★★" }, codes: ["RR"], regions: ["western"], eras: ["sv"], aliases: ["double rare", "rr", "two black stars", "2 black", "black double"] }),
  r({ value: "illustration_rare", label: "Illustration Rare", description: "One GOLD star — full-art illustration rare (IR / AR).", symbol: { shape: "star", count: 1, colour: "gold", glyph: "★" }, codes: ["IR", "AR"], regions: ["western", "japan"], eras: ["sv"], aliases: ["illustration rare", "ir", "ar", "art rare", "1 gold", "one gold star", "gold star"] }),
  r({ value: "ultra_rare", label: "Ultra Rare", description: "Two SILVER stars — ex / Supporter ultra rare.", symbol: { shape: "stars", count: 2, colour: "silver", glyph: "★★" }, codes: ["UR"], regions: ["western"], eras: ["sv"], aliases: ["ultra rare", "ur", "two silver stars", "2 silver", "silver double", "silver stars"] }),
  r({ value: "silver_star_rare", label: "Rare (Silver Star)", description: "One SILVER star — a rare marked with a single silver star, distinct from the two-silver-star Ultra Rare and the single BLACK star Rare (seen on some Trainer Gallery / TG-subset cards).", symbol: { shape: "star", count: 1, colour: "silver", glyph: "★" }, codes: ["1SS"], regions: ["western", "japan"], eras: ["swsh", "sv"], aliases: ["silver star rare", "single silver star", "one silver star", "1 silver star", "silver star", "silver rare", "tg silver star"] }),
  r({ value: "special_illustration_rare", label: "Special Illustration Rare", description: "Two GOLD stars — special illustration rare (SIR / SAR).", symbol: { shape: "stars", count: 2, colour: "gold", glyph: "★★" }, codes: ["SIR", "SAR"], regions: ["western", "japan"], eras: ["sv"], aliases: ["special illustration rare", "sir", "sar", "two gold stars", "2 gold", "gold double", "special art rare"] }),
  r({ value: "hyper_rare", label: "Hyper Rare", description: "Three GOLD stars — gold/rainbow hyper rare (HR).", symbol: { shape: "stars", count: 3, colour: "gold", glyph: "★★★" }, codes: ["HR"], regions: ["western", "japan"], eras: ["sv", "swsh"], aliases: ["hyper rare", "hr", "three gold stars", "3 gold", "gold rare", "rainbow rare"] }),
  r({ value: "shiny_rare", label: "Shiny Rare", description: "Shiny Pokémon rare (shiny symbol).", symbol: { shape: "shiny", colour: "silver", glyph: "✦" }, codes: ["SR"], regions: ["western"], eras: ["swsh", "sv"], aliases: ["shiny rare", "shiny", "baby shiny"] }),
  r({ value: "shiny_ultra_rare", label: "Shiny Ultra Rare", description: "Shiny Pokémon ultra rare (two shiny symbols).", symbol: { shape: "shiny", count: 2, colour: "gold", glyph: "✦✦" }, codes: ["SSR"], regions: ["western"], eras: ["swsh", "sv"], aliases: ["shiny ultra rare", "shiny ur", "ssr", "shiny double"] }),
  r({ value: "ace_spec", label: "ACE SPEC", description: "ACE SPEC rare — a red 'ACE SPEC' marker.", symbol: { shape: "text", colour: "black", glyph: "ACE" }, codes: ["ACE"], regions: ["western", "japan"], eras: ["sv", "bw-xy"], aliases: ["ace spec", "ace", "acespec"] }),
  // ── Older / cross-era English ─────────────────────────────────────────────────
  r({ value: "rare_holo", label: "Rare Holo (classic)", description: "Classic single-star rare (holo finish tracked separately).", symbol: { shape: "star", count: 1, colour: "black", glyph: "★" }, codes: ["R"], regions: ["western"], eras: ["vintage", "ex-dp", "bw-xy", "sm"], aliases: ["rare holo", "classic rare"] }),
  // ── EX-era Gold Star ──────────────────────────────────────────────────────────
  // The classic ☆ Gold Star chase card (EX Team Rocket Returns → EX Power Keepers).
  //
  // WHY THIS ENTRY EXISTS. Every other legacy rarity in client/src/lib/rarityOptions.ts
  // already has a structured counterpart (RARE_HOLO↔rare_holo, HYPER_RARE↔hyper_rare,
  // and so on). GOLD_STAR was the ONLY printed rarity with no structured value, which
  // left a grader on a vintage card with nothing correct to pick — searching
  // "gold star" surfaced the MODERN one/two/three-gold-star rarities instead. This
  // completes the existing pattern; it does NOT introduce a second rarity model.
  //
  // It is deliberately scoped to the EX era. Its symbol is a single GOLD star, which
  // is visually identical to Illustration Rare (Scarlet & Violet) — the ERA is what
  // separates them, which is why search must apply era eligibility rather than
  // matching on symbol or alias text alone.
  r({ value: "gold_star", label: "Gold Star (EX era)", description: "The classic ☆ Gold Star chase card (EX Team Rocket Returns – EX Power Keepers). One GOLD star, vintage EX era — NOT the modern Illustration Rare.", symbol: { shape: "star", count: 1, colour: "gold", glyph: "☆" }, codes: [], regions: ["western", "japan"], eras: ["ex-dp"], aliases: ["gold star", "goldstar", "ex gold star", "gold star pokemon", "shining gold star"] }),
  r({ value: "amazing_rare", label: "Amazing Rare", description: "Amazing Rare (rainbow 'A' rarity, SwSh).", symbol: { shape: "text", colour: "rainbow", glyph: "A" }, codes: ["A", "AR"], regions: ["western", "japan"], eras: ["swsh"], aliases: ["amazing rare", "amazing", "a rare"] }),
  r({ value: "radiant_rare", label: "Radiant Rare", description: "Radiant Pokémon (K) — etched shiny rare.", symbol: { shape: "shiny", colour: "gold", glyph: "◈" }, codes: ["K"], regions: ["western", "japan"], eras: ["swsh"], aliases: ["radiant", "radiant rare", "k rare"] }),
  r({ value: "prism_star", label: "Prism Star", description: "Prism Star (♢) — one-per-deck prism card (Sun & Moon).", symbol: { shape: "diamond", colour: "white", glyph: "♢" }, codes: [], regions: ["western", "japan"], eras: ["sm"], aliases: ["prism star", "prism", "prism rare"] }),
  // ── International / code-based (region-gated) ──────────────────────────────────
  r({ value: "jp_super_rare", label: "Super Rare (SR)", description: "Japanese Super Rare — full-art (SR).", symbol: { shape: "text", colour: "silver", glyph: "SR" }, codes: ["SR"], regions: ["japan", "korea", "china"], eras: ["bw-xy", "sm", "swsh", "sv"], aliases: ["super rare", "sr"] }),
  r({ value: "jp_double_rare", label: "Double Rare (RR)", description: "Japanese Double Rare (RR).", symbol: { shape: "text", colour: "black", glyph: "RR" }, codes: ["RR"], regions: ["japan", "korea", "china"], eras: ["bw-xy", "sm", "swsh", "sv"], aliases: ["double rare rr", "rr jp"] }),
  r({ value: "jp_triple_rare", label: "Triple Rare (RRR)", description: "Japanese Triple Rare (RRR).", symbol: { shape: "text", colour: "black", glyph: "RRR" }, codes: ["RRR"], regions: ["japan", "korea", "china"], eras: ["bw-xy", "sm"], aliases: ["triple rare", "rrr"] }),
  r({ value: "jp_hyper_rare", label: "Hyper Rare (HR)", description: "Japanese Hyper Rare — gold (HR).", symbol: { shape: "text", colour: "gold", glyph: "HR" }, codes: ["HR"], regions: ["japan", "korea", "china"], eras: ["bw-xy", "sm", "swsh", "sv"], aliases: ["hyper rare hr", "hr jp"] }),
  r({ value: "jp_ultra_rare", label: "Ultra Rare (UR)", description: "Japanese Ultra Rare — gold (UR).", symbol: { shape: "text", colour: "gold", glyph: "UR" }, codes: ["UR"], regions: ["japan", "korea", "china"], eras: ["sm", "swsh", "sv"], aliases: ["ultra rare ur jp", "ur jp"] }),
  r({ value: "jp_art_rare", label: "Art Rare (AR)", description: "Japanese Art Rare — illustration (AR).", symbol: { shape: "text", colour: "gold", glyph: "AR" }, codes: ["AR"], regions: ["japan", "korea", "china"], eras: ["sv"], aliases: ["art rare", "ar jp"] }),
  r({ value: "jp_special_art_rare", label: "Special Art Rare (SAR)", description: "Japanese Special Art Rare (SAR).", symbol: { shape: "text", colour: "gold", glyph: "SAR" }, codes: ["SAR"], regions: ["japan", "korea", "china"], eras: ["sv"], aliases: ["special art rare", "sar jp"] }),
  r({ value: "character_rare", label: "Character Rare (CHR)", description: "Character Rare — trainer/character art (CHR).", symbol: { shape: "text", colour: "silver", glyph: "CHR" }, codes: ["CHR"], regions: ["japan", "korea", "china"], eras: ["sm", "swsh"], aliases: ["character rare", "chr"] }),
  r({ value: "character_super_rare", label: "Character Super Rare (CSR)", description: "Character Super Rare (CSR).", symbol: { shape: "text", colour: "gold", glyph: "CSR" }, codes: ["CSR"], regions: ["japan", "korea", "china"], eras: ["swsh"], aliases: ["character super rare", "csr"] }),
  r({ value: "jp_shiny", label: "Shiny (S)", description: "Japanese Shiny rarity (S).", symbol: { shape: "shiny", colour: "silver", glyph: "S" }, codes: ["S"], regions: ["japan", "korea", "china"], eras: ["swsh", "sv"], aliases: ["shiny s", "s rare"] }),
  r({ value: "jp_shiny_super_rare", label: "Shiny Super Rare (SSR)", description: "Japanese Shiny Super Rare (SSR).", symbol: { shape: "shiny", colour: "gold", glyph: "SSR" }, codes: ["SSR"], regions: ["japan", "korea", "china"], eras: ["swsh", "sv"], aliases: ["shiny super rare", "ssr jp"] }),
  r({ value: "jp_ace_spec", label: "ACE SPEC (Japan)", description: "Japanese ACE SPEC (ACE).", symbol: { shape: "text", colour: "black", glyph: "ACE" }, codes: ["ACE"], regions: ["japan", "korea", "china"], eras: ["sv", "bw-xy"], aliases: ["ace spec jp"] }),
  r({ value: "jp_promo_rarity", label: "Promo (PR)", description: "Japanese Promo rarity marker (PR).", symbol: { shape: "text", colour: "black", glyph: "PR" }, codes: ["PR"], regions: ["japan", "korea", "china"], eras: "all", aliases: ["promo rarity", "pr"] }),
  r({ value: "jp_training_rare", label: "Trainer Rare (TR)", description: "Japanese Trainer/‘TR’ rarity marker.", symbol: { shape: "text", colour: "black", glyph: "TR" }, codes: ["TR"], regions: ["japan", "korea", "china"], eras: ["swsh"], aliases: ["tr rare", "trainer rare tr"] }),
  r({ value: "bw_rare", label: "Rare (BWR)", description: "Black & White-era rare marker (BWR).", symbol: { shape: "text", colour: "black", glyph: "BWR" }, codes: ["BWR"], regions: ["japan", "china"], eras: ["bw-xy"], aliases: ["bwr", "black white rare"] }),
  r({ value: "mega_ultra_rare", label: "Mega Ultra Rare (MUR)", description: "Mega-era Ultra Rare marker (MUR).", symbol: { shape: "text", colour: "gold", glyph: "MUR" }, codes: ["MUR"], regions: ["china", "japan"], eras: ["sv"], aliases: ["mega ultra rare", "mur"] }),
  r({ value: "masterpiece_rare", label: "Masterpiece (MA)", description: "Masterpiece / master-art rarity marker (MA).", symbol: { shape: "text", colour: "gold", glyph: "MA" }, codes: ["MA"], regions: ["china", "japan"], eras: ["sv"], aliases: ["masterpiece", "ma rare"] }),
  r({ value: "no_printed_symbol", label: "No Printed Symbol", description: "No rarity symbol is printed on the card.", symbol: { shape: "none", colour: "none", glyph: "—" }, codes: [], regions: "all", eras: "all", aliases: ["no symbol", "no printed symbol", "none", "blank", "unmarked"] }),
  // Stable fallback for a genuine printed rarity/variant not yet in this list. The
  // canonical VALUE never changes (so it always validates + displays correctly);
  // the grader's free-text description of the actual printed rarity is stored
  // separately in the certificate's existing `rarityOther` field — see the
  // RarityVariantPicker "Add missing rarity" flow. Never silently mapped onto
  // another rarity (e.g. a black/gold star or a different star count).
  r({ value: "custom_unlisted", label: "Custom / Unlisted", description: "A printed rarity that isn't in this list yet — described via “Add missing rarity”.", symbol: { shape: "text", colour: "white", glyph: "?" }, codes: ["CUSTOM"], regions: "all", eras: "all", aliases: ["custom", "unlisted", "other rarity", "add missing rarity", "not listed"] }),
];

// ── 3 · Finish / Variant (kept separate from rarity) ─────────────────────────────
export interface PokemonFinish {
  value: string;
  label: string;
  description: string;
  aliases: string[];
}
const f = (value: string, label: string, description: string, aliases: string[]): PokemonFinish => ({ value, label, description, aliases });
export const POKEMON_FINISHES: readonly PokemonFinish[] = [
  f("non_holo", "Non-Holo", "No holo foil — a flat/regular finish.", ["non holo", "nonholo", "regular", "none", "flat"]),
  f("holo", "Holo", "Holofoil in the artwork window.", ["holo", "holographic", "foil"]),
  f("reverse_holo", "Reverse Holo", "Holofoil on the card body, not the artwork.", ["reverse holo", "reverse", "rev holo", "reverse foil"]),
  f("cosmos_holo", "Cosmos Holo", "Galaxy/cosmos holo pattern.", ["cosmos holo", "cosmos", "galaxy holo"]),
  f("cracked_ice_holo", "Cracked Ice Holo", "Cracked-ice holo pattern.", ["cracked ice", "cracked ice holo", "ice holo"]),
  f("pokeball_reverse", "Poké Ball Reverse", "Reverse holo with a Poké Ball pattern.", ["poke ball reverse", "pokeball reverse", "poke ball", "pokeball holo"]),
  f("masterball_reverse", "Master Ball Reverse", "Reverse holo with a Master Ball pattern.", ["master ball reverse", "masterball reverse", "master ball", "masterball holo"]),
  f("first_edition", "First Edition", "1st Edition stamp present.", ["first edition", "1st edition", "1st ed", "first ed"]),
  f("unlimited", "Unlimited", "Unlimited print (no 1st Edition stamp).", ["unlimited", "unlimited print"]),
  f("shadowless", "Shadowless", "Shadowless Base-set print.", ["shadowless"]),
  f("staff_stamp", "Staff Stamp", "Staff prerelease stamp.", ["staff stamp", "staff"]),
  f("prerelease_stamp", "Prerelease Stamp", "Prerelease event stamp.", ["prerelease stamp", "prerelease", "pre-release"]),
  f("pokemon_center_stamp", "Pokémon Center Stamp", "Pokémon Center stamp.", ["pokemon center stamp", "pokemon center", "poke center"]),
  f("league_stamp", "League Stamp", "Play! Pokémon League stamp.", ["league stamp", "league"]),
  f("championship_stamp", "Championship Stamp", "Championship event stamp.", ["championship stamp", "championship", "worlds stamp"]),
  f("other_stamp", "Other Stamp", "Another stamp not listed.", ["other stamp", "stamp", "stamped"]),
  // Knowledge-engine additions (provisional — see shared/pokemon-knowledge.ts provenance).
  f("mirror_holo", "Mirror Holo", "Uniform mirror sheen across the card body, no pattern.", ["mirror holo", "mirror", "mirror reverse"]),
  f("crosshatch_holo", "Crosshatch Holo", "Crosshatch-pattern holo (often prize/league cards).", ["crosshatch holo", "crosshatch", "cross hatch"]),
  f("confetti_holo", "Confetti Holo", "Confetti-speckle holo pattern.", ["confetti holo", "confetti"]),
  f("glitter_holo", "Glitter Holo", "Glitter-dust holo pattern.", ["glitter holo", "glitter"]),
  f("textured", "Textured", "Embossed textured foil surface (modern ultra rares).", ["textured", "texture", "embossed"]),
  f("full_texture", "Full Texture", "Full-surface texture embossing.", ["full texture", "fully textured"]),
  f("gold_foil", "Gold Foil", "Gold-foil card treatment.", ["gold foil", "gold card", "gold etched"]),
  f("silver_foil", "Silver Foil", "Silver-foil card treatment.", ["silver foil", "silver card"]),
];

// ── 4 · Promo / Subset (kept separate from rarity) ───────────────────────────────
export interface PokemonPromo {
  value: string;
  label: string;
  description: string;
  /** "promo" for standalone promos; "subset" for gallery/collection subsets within a set. */
  kind: "promo" | "subset";
  aliases: string[];
}
const p = (value: string, label: string, kind: "promo" | "subset", description: string, aliases: string[]): PokemonPromo => ({ value, label, kind, description, aliases });
export const POKEMON_PROMOS: readonly PokemonPromo[] = [
  p("black_star_promo", "Black Star Promo", "promo", "English Black Star Promo.", ["black star promo", "black star", "promo", "swsh promo", "sv promo"]),
  p("japanese_promo", "Japanese Promo", "promo", "Japanese promotional card.", ["japanese promo", "jp promo", "promo card jp"]),
  p("trainer_gallery", "Trainer Gallery", "subset", "Trainer Gallery subset (TG).", ["trainer gallery", "tg", "gallery"]),
  p("galarian_gallery", "Galarian Gallery", "subset", "Galarian Gallery subset (GG).", ["galarian gallery", "gg"]),
  p("shiny_vault", "Shiny Vault", "subset", "Shiny Vault subset (SV).", ["shiny vault", "sv subset", "sh vault"]),
  p("radiant_collection", "Radiant Collection", "subset", "Radiant Collection subset (RC).", ["radiant collection", "rc"]),
  p("classic_collection", "Classic Collection", "subset", "Classic Collection subset (CLC).", ["classic collection", "clc"]),
  p("mcdonalds_promo", "McDonald’s Promo", "promo", "McDonald’s collection promo.", ["mcdonalds promo", "mcdonald's", "mcdonalds", "happy meal"]),
  p("league_promo", "League Promo", "promo", "League / organised-play promo.", ["league promo", "league"]),
  p("event_promo", "Event Promo", "promo", "Event / championship promo.", ["event promo", "event", "championship"]),
  // Knowledge-engine additions (provisional — see shared/pokemon-knowledge.ts provenance).
  p("world_championships_promo", "World Championships", "promo", "World Championships event promo.", ["world championships", "worlds", "wcs promo"]),
  p("play_pokemon_promo", "Play! Pokémon", "promo", "Play! Pokémon organised-play promo.", ["play pokemon", "play! pokemon", "op promo"]),
  p("illustration_contest_promo", "Illustration Contest", "promo", "Illustration contest prize promo.", ["illustration contest", "illus contest", "art contest"]),
  p("ana_promo", "ANA Promo", "promo", "ANA airline promotional card (Japan).", ["ana", "ana promo", "airline promo"]),
  p("corocoro_promo", "CoroCoro Promo", "promo", "CoroCoro magazine promo (Japan).", ["corocoro", "coro coro", "magazine promo"]),
  p("cd_promo", "CD Promo", "promo", "CD/media pack-in promo (Japan).", ["cd promo", "cd", "media promo"]),
  p("other_promo", "Other", "promo", "Another promo/subset not listed.", ["other promo", "other subset"]),
];

// ── Catalogue snapshot (DB-backed data uses the SAME helpers as the seed) ────────
/**
 * A snapshot of the four classification lists. The hard-coded arrays above are the
 * SEED snapshot ({@link SEED_CATALOGUE}); the DB-backed Catalogue Manager produces a
 * live snapshot of the same shape. Every helper below takes an optional snapshot and
 * DEFAULTS to the seed — so existing callers are unchanged, and DB-driven callers pass
 * the live snapshot. This keeps ONE implementation over both data sources.
 */
/** A designation / optional attribute chip. `code` is the persisted value —
 *  it is NEVER derived from the label, so renaming a label in the Catalogue
 *  Manager cannot change what is already stored on a certificate. */
export interface PokemonDesignation {
  code: string;
  label: string;
  help: string;
}

/** Seed designations — the historical hard-coded list, now the offline fallback
 *  for the DB-backed `designation` catalogue category. */
export const POKEMON_DESIGNATIONS: readonly PokemonDesignation[] = [
  { code: "PROMO", label: "Promo", help: "Not from regular booster packs; promotional distribution." },
  { code: "TOURNAMENT_STAMP", label: "Tournament / Event Stamp", help: "Stamped for tournament/event (often has year/stamp)." },
  { code: "PRERELEASE", label: "Prerelease", help: "Prerelease stamp/marking." },
  { code: "STAFF", label: "Staff", help: "Staff stamp/edition." },
  { code: "ERROR_MISCUT", label: "Error / Miscut / Misprint", help: "Manufacturing error; document clearly." },
  { code: "FIRST_EDITION", label: "1st Edition", help: "1st Edition marking (WOTC era)." },
  { code: "SHADOWLESS", label: "Shadowless", help: "WOTC shadowless print variant." },
  { code: "UNLIMITED", label: "Unlimited", help: "Unlimited print run variant." },
  { code: "JAPANESE_PRINT", label: "Japanese Print", help: "Card is Japanese (language should also be set)." },
  { code: "OTHER_LANGUAGE", label: "Other Language", help: "Non-English/Japanese language print." },
];

/** Seed optional attributes. Empty by default — the `attribute` catalogue
 *  category exists so the owner can add their own without a code change. */
export const POKEMON_ATTRIBUTES: readonly PokemonDesignation[] = [];

export interface CatalogueSnapshot {
  languages: readonly PokemonLanguage[];
  rarities: readonly PokemonRarity[];
  finishes: readonly PokemonFinish[];
  promos: readonly PokemonPromo[];
  eras: readonly { value: PokemonEra | string; label: string }[];
  designations: readonly PokemonDesignation[];
  attributes: readonly PokemonDesignation[];
}

export const SEED_CATALOGUE: CatalogueSnapshot = {
  languages: POKEMON_LANGUAGES,
  rarities: POKEMON_RARITIES,
  finishes: POKEMON_FINISHES,
  promos: POKEMON_PROMOS,
  eras: POKEMON_ERAS,
  designations: POKEMON_DESIGNATIONS,
  attributes: POKEMON_ATTRIBUTES,
};

// ── Helpers ──────────────────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function scopeIncludesRegion(scope: RegionScope, region: PokemonLanguage["region"]): boolean {
  return scope === "all" || scope.includes(region);
}

export function languageByValue(
  value: string | null | undefined,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): PokemonLanguage | undefined {
  return cat.languages.find((l) => l.value === value);
}

/** Resolve a language from its catalogue code ("en"), display label ("English"),
 *  or any alias — so the picker (codes) and the existing `language` column
 *  (display names) both map to the same entry. */
export function languageByValueOrLabel(
  value: string | null | undefined,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): PokemonLanguage | undefined {
  if (value == null) return undefined;
  const q = norm(String(value));
  if (!q) return undefined;
  return cat.languages.find(
    (l) => norm(l.value) === q || norm(l.label) === q || l.aliases.some((a) => norm(a) === q),
  );
}

export function normalizePokemonLanguage(
  value: string | null | undefined,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): PokemonLanguage | undefined {
  return languageByValueOrLabel(value, cat);
}

export function languageLabel(value: string | null | undefined, fallback = "English"): string {
  return normalizePokemonLanguage(value)?.label ?? fallback;
}

export function tcgdexLanguageCode(value: string | null | undefined): string | null {
  const lang = normalizePokemonLanguage(value);
  if (!lang || lang.value === "other") return null;
  return lang.value;
}

/** Rarities available for a given language + era + (optional) explicit region override. */
export function filterRarities(
  opts: { language?: string | null; era?: PokemonEra | null },
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): PokemonRarity[] {
  const lang = languageByValue(opts.language ?? "en", cat);
  const region = lang?.region ?? "western";
  return cat.rarities.filter((rr) => {
    if (!scopeIncludesRegion(rr.regions, region)) return false;
    if (opts.era && rr.eras !== "all" && !rr.eras.includes(opts.era)) return false;
    return true;
  });
}

/** True when a rarity is printed for the given region (used for dropdown filtering). */
export function rarityAvailableForRegion(rarity: PokemonRarity, region: PokemonLanguage["region"]): boolean {
  return scopeIncludesRegion(rarity.regions, region);
}

export interface CatalogueSearchResult {
  rarities: PokemonRarity[];
  finishes: PokemonFinish[];
  promos: PokemonPromo[];
}

/** Fuzzy alias/label/code search across ALL four classifications. */
/**
 * Optional card context. When supplied, RARITY results are restricted to the
 * rarities actually printed for that language/region and era — the SAME
 * eligibility rule the browse lists apply via {@link filterRarities}.
 *
 * WHY. Search previously took no context at all, so its results bypassed the era
 * gate that the browse lists enforce, and every hit rendered as a directly
 * selectable chip. On a vintage card, searching "gold star" offered Illustration
 * Rare / Special Illustration Rare / Hyper Rare — all Scarlet & Violet rarities
 * the era filter would otherwise have hidden. Passing context closes that bypass.
 *
 * `showAll` mirrors the picker's existing "Show all compatible options" override,
 * so nothing is ever permanently unreachable when set data is incomplete.
 */
export interface CatalogueSearchContext {
  language?: string | null;
  era?: PokemonEra | null;
  showAll?: boolean;
}

export function searchCatalogue(
  query: string,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
  context?: CatalogueSearchContext,
): CatalogueSearchResult {
  const q = norm(query);
  if (!q) return { rarities: [], finishes: [], promos: [] };
  const hit = (label: string, aliases: string[], codes: string[] = []) =>
    norm(label).includes(q) ||
    codes.some((c) => norm(c) === q || norm(c).includes(q)) ||
    aliases.some((a) => {
      const na = norm(a);
      // Forward: the alias contains what was typed ("one gold star" ⊃ "gold star").
      if (na.includes(q)) return true;
      // Reverse: what was typed contains the alias, so a longer phrase still finds
      // its rarity ("reverse holo foil" → "reverse holo"). Restricted to MULTI-WORD
      // aliases: a bare one-word alias such as "star" would otherwise match every
      // query containing that word, which is exactly how a "gold star" search came
      // to offer plain Rare. An exact match is always honoured.
      if (na === q) return true;
      return na.includes(" ") && q.includes(na);
    });
  const rarityEligible = (x: PokemonRarity): boolean => {
    if (!context) return true;
    const lang = languageByValue(context.language ?? "en", cat);
    const region = lang?.region ?? "western";
    if (!scopeIncludesRegion(x.regions, region)) return false;
    if (context.showAll) return true;
    if (context.era && x.eras !== "all" && !x.eras.includes(context.era)) return false;
    return true;
  };
  return {
    rarities: cat.rarities.filter((x) => hit(x.label, x.aliases, x.codes) && rarityEligible(x)),
    finishes: cat.finishes.filter((x) => hit(x.label, x.aliases)),
    promos: cat.promos.filter((x) => hit(x.label, x.aliases)),
  };
}

const COUNT_WORD: Record<number, string> = { 1: "one", 2: "two", 3: "three" };

/**
 * Plain-English description of a printed symbol for screen readers + tests —
 * always naming the COUNT and COLOUR so gold vs silver and 1★ vs 2★ vs 3★ are
 * distinguishable without seeing the graphic. E.g. "two gold stars".
 */
export function describeSymbol(symbol: RaritySymbol): string {
  const colour = symbol.colour === "none" ? "" : symbol.colour;
  switch (symbol.shape) {
    case "star":
    case "stars": {
      const n = symbol.count ?? 1;
      const plural = n === 1 ? "star" : "stars";
      return `${COUNT_WORD[n] ?? n} ${colour} ${plural}`.replace(/\s+/g, " ").trim();
    }
    case "circle":
      return `${colour} circle`.trim();
    case "diamond":
      return `${colour} diamond`.trim();
    case "shiny": {
      const n = symbol.count ?? 1;
      return `${n === 1 ? "" : COUNT_WORD[n] ?? n} ${colour} shiny symbol`.replace(/\s+/g, " ").trim();
    }
    case "text":
      return `${colour} “${symbol.glyph}” marker`.trim();
    case "none":
    default:
      return "no printed symbol";
  }
}

export function rarityByValue(
  value: string | null | undefined,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): PokemonRarity | undefined {
  return cat.rarities.find((x) => x.value === value);
}
export function finishByValue(
  value: string | null | undefined,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): PokemonFinish | undefined {
  return cat.finishes.find((x) => x.value === value);
}
export function promoByValue(
  value: string | null | undefined,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): PokemonPromo | undefined {
  return cat.promos.find((x) => x.value === value);
}

// ── Legacy migration mapping (audit — never auto-applied) ─────────────────────────
export type LegacyClassification = "rarity" | "finish" | "promo" | "subset" | "ambiguous";
export interface LegacyMapping {
  classification: LegacyClassification;
  /** The proposed canonical value in the relevant catalogue (null when ambiguous). */
  value: string | null;
  /** Set when the historical value could mean more than one thing — needs admin review. */
  ambiguous: boolean;
  note?: string;
}

/**
 * Map an existing flat `variant` CODE (from client/src/lib/variantOptions.ts) to the
 * structured catalogue. NEVER mutates a certificate — this only PROPOSES a mapping and
 * marks genuinely ambiguous historical values for admin review.
 */
export function mapLegacyVariant(code: string | null | undefined): LegacyMapping {
  const c = String(code ?? "").trim().toUpperCase();
  const clear: Record<string, LegacyMapping> = {
    NONE: { classification: "finish", value: "non_holo", ambiguous: false },
    HOLO: { classification: "finish", value: "holo", ambiguous: false },
    REVERSE_HOLO: { classification: "finish", value: "reverse_holo", ambiguous: false },
    COSMOS_HOLO: { classification: "finish", value: "cosmos_holo", ambiguous: false },
    CRACKED_ICE_HOLO: { classification: "finish", value: "cracked_ice_holo", ambiguous: false },
    FIRST_EDITION: { classification: "finish", value: "first_edition", ambiguous: false },
    UNLIMITED: { classification: "finish", value: "unlimited", ambiguous: false },
    SHADOWLESS: { classification: "finish", value: "shadowless", ambiguous: false },
    MIRROR_HOLO: { classification: "finish", value: "mirror_holo", ambiguous: false },
    GLITTER_HOLO: { classification: "finish", value: "glitter_holo", ambiguous: false },
    PATTERN_HOLO: { classification: "finish", value: "holo", ambiguous: true, note: "Pattern holo — confirm exact finish (cosmos / cracked ice / crosshatch / confetti)." },
    TEXTURED: { classification: "finish", value: "textured", ambiguous: false },
    DOUBLE_RARE: { classification: "rarity", value: "double_rare", ambiguous: false },
    ILLUSTRATION_RARE: { classification: "rarity", value: "illustration_rare", ambiguous: false },
    ULTRA_RARE: { classification: "rarity", value: "ultra_rare", ambiguous: false },
    SPECIAL_ILLUSTRATION_RARE: { classification: "rarity", value: "special_illustration_rare", ambiguous: false },
    HYPER_RARE: { classification: "rarity", value: "hyper_rare", ambiguous: false },
    AMAZING_RARE: { classification: "rarity", value: "amazing_rare", ambiguous: false },
    ACE_SPEC_RARE: { classification: "rarity", value: "ace_spec", ambiguous: false },
    CHARACTER_RARE: { classification: "rarity", value: "character_rare", ambiguous: false },
    CHARACTER_SUPER_RARE: { classification: "rarity", value: "character_super_rare", ambiguous: false },
    SECRET_RARE: { classification: "rarity", value: "jp_super_rare", ambiguous: true, note: "‘Secret Rare’ is a bucket (SR/UR/HR) — confirm exact printed rarity." },
    SHINY: { classification: "rarity", value: "shiny_rare", ambiguous: false },
    RADIANT: { classification: "rarity", value: "radiant_rare", ambiguous: true, note: "Could be the Radiant rarity OR the Radiant Collection subset — confirm." },
    TRAINER_GALLERY: { classification: "subset", value: "trainer_gallery", ambiguous: false },
    GALARIAN_GALLERY: { classification: "subset", value: "galarian_gallery", ambiguous: false },
    BLACK_STAR_PROMO: { classification: "promo", value: "black_star_promo", ambiguous: false },
    // Genuinely ambiguous art-type / generic values → admin review.
    FULL_ART: { classification: "ambiguous", value: null, ambiguous: true, note: "Full Art is an art style, not a rarity — needs the actual printed rarity." },
    ALT_ART: { classification: "ambiguous", value: null, ambiguous: true, note: "Alt Art is an art style — needs the actual printed rarity." },
    SPECIAL_ART: { classification: "ambiguous", value: null, ambiguous: true, note: "Special Art is an art style — needs the actual printed rarity." },
    RAINBOW: { classification: "ambiguous", value: null, ambiguous: true, note: "Rainbow could be Hyper Rare or a rainbow finish — needs review." },
    GOLD: { classification: "ambiguous", value: null, ambiguous: true, note: "Gold could be a Gold/Hyper rarity or a gold finish — needs review." },
    EX: { classification: "ambiguous", value: null, ambiguous: true, note: "‘ex’ is a card mechanic, not a printed rarity symbol — needs the rarity." },
    PROMO: { classification: "promo", value: "other_promo", ambiguous: true, note: "Generic ‘Promo’ — confirm which promo (Black Star / Japanese / event …)." },
    OTHER: { classification: "ambiguous", value: null, ambiguous: true, note: "Free-text ‘Other’ — needs admin classification." },
  };
  if (clear[c]) return clear[c];
  return { classification: "ambiguous", value: null, ambiguous: true, note: `Unrecognised legacy variant code "${c}" — needs admin review.` };
}

// ── The structured selection the picker produces (each stored in its OWN column) ──
export interface StructuredCardVariant {
  language: string; // e.g. "en"
  region: PokemonLanguage["region"];
  era: PokemonEra | null;
  rarity: string | null; // canonical rarity value
  printedSymbol: string; // glyph, e.g. "★★"
  symbolColour: SymbolColour; // "gold" | "silver" | …
  finish: string | null; // canonical finish value
  promo: string | null; // canonical promo value (kind="promo")
  subset: string | null; // canonical subset value (kind="subset")
}

// ── Favourites / recently-used (pure — the picker persists the returned arrays) ──
/** Move `value` to the front of a recents list, de-duplicated, capped at `max`. */
export function addRecent(list: readonly string[], value: string, max = 8): string[] {
  if (!value) return [...list];
  return [value, ...list.filter((v) => v !== value)].slice(0, max);
}
/** Toggle a favourite value in a list (add if absent, remove if present). */
export function toggleFavourite(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Build the SEPARATE-field selection (never a single combined display string). */
export function buildStructuredVariant(
  sel: {
    language?: string | null;
    era?: PokemonEra | null;
    rarity?: string | null;
    finish?: string | null;
    promoOrSubset?: string | null;
  },
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): StructuredCardVariant {
  const lang = languageByValue(sel.language ?? "en", cat) ?? cat.languages[0] ?? POKEMON_LANGUAGES[0];
  const rarity = rarityByValue(sel.rarity, cat);
  const promoSel = promoByValue(sel.promoOrSubset, cat);
  return {
    language: lang.value,
    region: lang.region,
    era: sel.era ?? null,
    rarity: rarity?.value ?? null,
    printedSymbol: rarity?.symbol.glyph ?? "",
    symbolColour: rarity?.symbol.colour ?? "none",
    finish: finishByValue(sel.finish, cat)?.value ?? null,
    promo: promoSel?.kind === "promo" ? promoSel.value : null,
    subset: promoSel?.kind === "subset" ? promoSel.value : null,
  };
}

export type RarityChangeDecision =
  | { kind: "no_change"; requiresConfirmation: false; reason: string }
  | { kind: "allowed"; requiresConfirmation: false; reason: string }
  | { kind: "confirmation_required"; requiresConfirmation: true; reason: string };

const KNOWN_RARITY_CODES = new Set(POKEMON_RARITIES.map((rarity) => rarity.value));

const RARITY_UPGRADES = new Set<string>([
  "rare->holo_rare_v",
  "silver_star_rare->holo_rare_v",
  "double_rare->ultra_rare",
  "ultra_rare->hyper_rare",
  "illustration_rare->special_illustration_rare",
  "jp_art_rare->jp_special_art_rare",
  "jp_double_rare->jp_super_rare",
  "jp_super_rare->jp_hyper_rare",
  "jp_ultra_rare->jp_hyper_rare",
  "character_rare->character_super_rare",
  "shiny_rare->shiny_ultra_rare",
]);

const RARITY_DOWNGRADES = new Set<string>([
  "holo_rare_v->common",
  "holo_rare_v->uncommon",
  "holo_rare_v->rare",
  "holo_rare_v->silver_star_rare",
  "holo_rare_v->no_printed_symbol",
  "rare_holo->common",
  "rare_holo->uncommon",
  "rare_holo->rare",
  "special_illustration_rare->double_rare",
  "special_illustration_rare->ultra_rare",
  "special_illustration_rare->illustration_rare",
  "hyper_rare->ultra_rare",
  "hyper_rare->double_rare",
  "ultra_rare->double_rare",
  "jp_special_art_rare->jp_art_rare",
  "jp_special_art_rare->jp_double_rare",
  "jp_hyper_rare->jp_super_rare",
  "jp_hyper_rare->jp_double_rare",
  "character_super_rare->character_rare",
  "shiny_ultra_rare->shiny_rare",
]);

const GENERIC_PRINTED_SYMBOLS = new Set(["common", "uncommon", "rare", "silver_star_rare", "no_printed_symbol"]);

/**
 * Decide whether a rarity change can be applied directly or needs an explicit
 * operator confirmation. This is intentionally relational, not a single global
 * rank: Pokemon rarity families do not form a clean total order across English,
 * Japanese, promo/subset and printed-symbol-only cases.
 */
export function decideRarityChange(
  current: string | null | undefined,
  next: string | null | undefined,
): RarityChangeDecision {
  const cur = String(current ?? "").trim();
  const nxt = String(next ?? "").trim();
  if (cur === nxt) return { kind: "no_change", requiresConfirmation: false, reason: "Rarity is unchanged." };
  if (!cur) return { kind: "allowed", requiresConfirmation: false, reason: "No authoritative rarity exists yet." };
  if (!nxt) {
    return {
      kind: "confirmation_required",
      requiresConfirmation: true,
      reason: "Clearing a known rarity removes certificate rarity information.",
    };
  }

  const currentKnown = KNOWN_RARITY_CODES.has(cur);
  const nextKnown = KNOWN_RARITY_CODES.has(nxt);
  if (!currentKnown && nextKnown) {
    return { kind: "allowed", requiresConfirmation: false, reason: "Deliberate correction from a legacy/unknown rarity." };
  }
  if (currentKnown && !nextKnown) {
    return {
      kind: "confirmation_required",
      requiresConfirmation: true,
      reason: "Changing a known authoritative rarity to an unknown code loses structured rarity information.",
    };
  }
  if (!currentKnown && !nextKnown) {
    return { kind: "allowed", requiresConfirmation: false, reason: "Both rarities are legacy/unknown values." };
  }

  const edge = `${cur}->${nxt}`;
  if (RARITY_UPGRADES.has(edge)) {
    return { kind: "allowed", requiresConfirmation: false, reason: "The proposed rarity is a more specific rarity in the same family." };
  }
  if (RARITY_DOWNGRADES.has(edge)) {
    return {
      kind: "confirmation_required",
      requiresConfirmation: true,
      reason: "The proposed rarity is lower-information than the authoritative card rarity.",
    };
  }
  if (cur === "holo_rare_v" && GENERIC_PRINTED_SYMBOLS.has(nxt)) {
    return {
      kind: "confirmation_required",
      requiresConfirmation: true,
      reason: "A printed symbol alone must not silently downgrade Holo Rare V.",
    };
  }

  return { kind: "allowed", requiresConfirmation: false, reason: "No information-losing relation is defined for this rarity change." };
}

export function isLowerInformationRarityChange(current: string | null | undefined, next: string | null | undefined): boolean {
  return decideRarityChange(current, next).requiresConfirmation;
}
