/**
 * MintVault Pokémon Knowledge Engine — shared knowledge layer.
 *
 * ONE catalogue rule: the canonical classification data (rarities, finishes,
 * promos/subsets, languages, eras) lives in shared/pokemon-rarity-catalogue.ts —
 * the SAME module the deployed grading picker + server validation use. This file
 * NEVER duplicates those records; it adds the knowledge metadata around them:
 *
 *   • source provenance + review status (per catalogue record, in code — code
 *     records are versioned by git, so their provenance is code too)
 *   • the era timeline (12 fine-grained periods mapped onto the 6 stable
 *     catalogue era values — the DB CHECK on certificates.era allows exactly
 *     those 6, so the enum itself must not change)
 *   • the language identification guide (reference-only; includes European
 *     languages that map to the picker's western region)
 *   • common-confusion comparison pairs
 *   • identification notes / common mistakes per catalogue value
 *   • catalogue version + deterministic checksum (drives PDF cache busting)
 *
 * PURE + shared: data + deterministic helpers only. No DOM, no network, no DB.
 */
import {
  POKEMON_RARITIES,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  POKEMON_LANGUAGES,
  POKEMON_ERAS,
  type PokemonEra,
} from "./pokemon-rarity-catalogue";

// ── Catalogue version ─────────────────────────────────────────────────────────
/** Bump on any material catalogue/knowledge change. Shown in the Hub + PDFs. */
export const KNOWLEDGE_CATALOGUE_VERSION = "1.1.0";

/** Deterministic FNV-1a checksum of the whole shared catalogue + knowledge data.
 *  Pure (no node:crypto) so client + server compute the identical value; used to
 *  cache generated handbooks and detect drift. */
export function catalogueChecksum(): string {
  const payload = JSON.stringify([
    KNOWLEDGE_CATALOGUE_VERSION,
    POKEMON_RARITIES,
    POKEMON_FINISHES,
    POKEMON_PROMOS,
    POKEMON_LANGUAGES,
    POKEMON_ERAS,
    ERA_TIMELINE,
    LANGUAGE_GUIDE,
    COMPARISON_PAIRS,
    KNOWLEDGE_NOTES,
    CATALOGUE_PROVENANCE_OVERRIDES,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── Source provenance ─────────────────────────────────────────────────────────
export const SOURCE_TYPES = [
  "official_pokemon",
  "official_regional",
  "official_checklist_pdf",
  "official_card_database",
  "trusted_catalogue",
  "founder_confirmed",
  "staff_confirmed",
  "community",
  "inferred",
  "unknown",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const REVIEW_STATUSES_KNOWLEDGE = [
  "verified",
  "provisional",
  "needs_review",
  "disputed",
  "deprecated",
  "archived",
] as const;
export type KnowledgeReviewStatus = (typeof REVIEW_STATUSES_KNOWLEDGE)[number];

export type KnowledgeConfidence = "high" | "medium" | "low";

export interface KnowledgeSource {
  sourceType: SourceType;
  /** Human-readable reference — organisation, document name, or URL. */
  reference?: string;
  verifiedDate?: string; // ISO date
}

export interface KnowledgeProvenance {
  sources: KnowledgeSource[];
  status: KnowledgeReviewStatus;
  confidence: KnowledgeConfidence;
}

/**
 * Default provenance for catalogue records: the classification structure was
 * authored from widely-used collector terminology and confirmed in use by the
 * founder via the deployed picker — but it has NOT been verified against an
 * official Pokémon source, so it is PROVISIONAL, never presented as official.
 */
export const DEFAULT_CATALOGUE_PROVENANCE: KnowledgeProvenance = {
  sources: [{ sourceType: "community", reference: "Collector terminology in common use" }],
  status: "provisional",
  confidence: "medium",
};

/** Per-record overrides where the picture is stronger/weaker than the default.
 *  Keyed "<kind>:<value>", e.g. "rarity:common". */
export const CATALOGUE_PROVENANCE_OVERRIDES: Record<string, KnowledgeProvenance> = {
  // The base symbol system (●/◆/★) is printed on every card back-catalogue-wide;
  // founder uses it daily in grading. Still not cited to an official document.
  "rarity:common": { sources: [{ sourceType: "founder_confirmed", reference: "In daily grading use" }], status: "verified", confidence: "high" },
  "rarity:uncommon": { sources: [{ sourceType: "founder_confirmed", reference: "In daily grading use" }], status: "verified", confidence: "high" },
  "rarity:rare": { sources: [{ sourceType: "founder_confirmed", reference: "In daily grading use" }], status: "verified", confidence: "high" },
  "finish:reverse_holo": { sources: [{ sourceType: "founder_confirmed", reference: "In daily grading use" }], status: "verified", confidence: "high" },
  "finish:holo": { sources: [{ sourceType: "founder_confirmed", reference: "In daily grading use" }], status: "verified", confidence: "high" },
  "finish:first_edition": { sources: [{ sourceType: "founder_confirmed", reference: "In daily grading use" }], status: "verified", confidence: "high" },
  "promo:trainer_gallery": { sources: [{ sourceType: "founder_confirmed", reference: "Graded production certs" }], status: "verified", confidence: "high" },
  "promo:galarian_gallery": { sources: [{ sourceType: "founder_confirmed", reference: "Graded production certs" }], status: "verified", confidence: "high" },
  "promo:black_star_promo": { sources: [{ sourceType: "founder_confirmed", reference: "Graded production certs" }], status: "verified", confidence: "high" },
  // Region-specific code systems are community-documented only — keep low.
  "rarity:bw_rare": { ...structuredCloneLite(), confidence: "low" },
  "rarity:mega_ultra_rare": { ...structuredCloneLite(), confidence: "low" },
  "rarity:masterpiece_rare": { ...structuredCloneLite(), confidence: "low" },
};
function structuredCloneLite(): KnowledgeProvenance {
  return { sources: [{ sourceType: "community", reference: "Collector terminology in common use" }], status: "needs_review", confidence: "medium" };
}

/** Resolve provenance for any catalogue record ("rarity"|"finish"|"promo", value). */
export function provenanceFor(kind: "rarity" | "finish" | "promo" | "language" | "era", value: string): KnowledgeProvenance {
  return CATALOGUE_PROVENANCE_OVERRIDES[`${kind}:${value}`] ?? DEFAULT_CATALOGUE_PROVENANCE;
}

// ── Era timeline (fine periods → the 6 stable catalogue eras) ─────────────────
export interface EraPeriod {
  key: string;
  label: string;
  /** Which stable catalogue era this period belongs to (DB-safe value). */
  catalogueEra: PokemonEra;
  yearsApprox: string;
  raritySystemNotes: string;
  codeFormatNotes: string;
  finishNotes: string;
  promoNotes: string;
}

export const ERA_TIMELINE: readonly EraPeriod[] = [
  { key: "wotc-base", label: "Base / WOTC", catalogueEra: "vintage", yearsApprox: "1999–2001", raritySystemNotes: "●/◆/★ only; holo rares share the single-star symbol.", codeFormatNotes: "No printed set codes; sets identified by symbol. 1st Edition stamps.", finishNotes: "Holo, Shadowless, 1st Edition vs Unlimited.", promoNotes: "Black Star Promos begin (numbered, no set symbol)." },
  { key: "neo", label: "Neo", catalogueEra: "vintage", yearsApprox: "2000–2001", raritySystemNotes: "Same ●/◆/★ system.", codeFormatNotes: "Set symbol only.", finishNotes: "Holo; some prerelease stamps.", promoNotes: "League + prerelease stamps." },
  { key: "e-reader", label: "e-Card / e-Reader", catalogueEra: "vintage", yearsApprox: "2001–2003", raritySystemNotes: "●/◆/★; e-Reader strips on card edges.", codeFormatNotes: "e-Reader dot-code strips are the identifying feature.", finishNotes: "Holo, reverse holo introduced (Legendary Collection 2002).", promoNotes: "Best of game promos." },
  { key: "ex", label: "EX series", catalogueEra: "ex-dp", yearsApprox: "2003–2007", raritySystemNotes: "★ plus 'Rare Holo ex'; gold-star Pokémon (shiny) appear.", codeFormatNotes: "Collector numbers like 001/109.", finishNotes: "Reverse holo standard.", promoNotes: "Nintendo Black Star Promos." },
  { key: "dp", label: "Diamond & Pearl", catalogueEra: "ex-dp", yearsApprox: "2007–2009", raritySystemNotes: "Rare Holo LV.X at set end.", codeFormatNotes: "DP set codes begin appearing on promos (DP01…).", finishNotes: "Cosmos-style holo common.", promoNotes: "DP Black Star Promos." },
  { key: "platinum-hgss", label: "Platinum / HGSS", catalogueEra: "ex-dp", yearsApprox: "2009–2011", raritySystemNotes: "Prime + LEGEND pieces (HGSS).", codeFormatNotes: "HGSS promo codes.", finishNotes: "Cracked-ice style appears in products.", promoNotes: "HGSS Black Star Promos." },
  { key: "bw", label: "Black & White", catalogueEra: "bw-xy", yearsApprox: "2011–2013", raritySystemNotes: "Full Art ultra rares; ACE SPEC introduced (2013).", codeFormatNotes: "BW promo codes (BW01…).", finishNotes: "Full-art textured foils begin.", promoNotes: "BW Black Star Promos; McDonald's collections." },
  { key: "xy", label: "XY", catalogueEra: "bw-xy", yearsApprox: "2014–2016", raritySystemNotes: "Mega EX; Secret rares beyond set number.", codeFormatNotes: "XY promo codes.", finishNotes: "Textured full art.", promoNotes: "XY Black Star Promos." },
  { key: "sm", label: "Sun & Moon", catalogueEra: "sm", yearsApprox: "2017–2019", raritySystemNotes: "GX; Hyper Rare (rainbow) tier; Prism Star; CHR in Japan.", codeFormatNotes: "SM promo codes (SM01…).", finishNotes: "Rainbow textured; Shiny Vault (Hidden Fates) etched.", promoNotes: "SM Black Star Promos; Shiny Vault subset." },
  { key: "swsh", label: "Sword & Shield", catalogueEra: "swsh", yearsApprox: "2020–2022", raritySystemNotes: "V/VMAX/VSTAR; Amazing Rare; Radiant (K); CHR/CSR in Japan; Trainer/Galarian Gallery subsets.", codeFormatNotes: "SWSH promo codes (SWSH001…); Japanese S-series codes.", finishNotes: "Cosmos/cracked-ice product holos; gallery textured.", promoNotes: "SWSH Black Star Promos; TG/GG subsets." },
  { key: "sv", label: "Scarlet & Violet", catalogueEra: "sv", yearsApprox: "2023–", raritySystemNotes: "Modern star system: ★★ black Double Rare, ★ gold IR, ★★ silver UR, ★★ gold SIR, ★★★ gold HR; ACE SPEC returns.", codeFormatNotes: "SV set codes (SV1… SV8, sv4pt5…); silver-bordered cards.", finishNotes: "Poké Ball / Master Ball reverse (151 + selected sets).", promoNotes: "SVP Black Star Promos." },
  { key: "future", label: "Future eras", catalogueEra: "sv", yearsApprox: "TBD", raritySystemNotes: "Added via catalogue data updates — no UI code change needed.", codeFormatNotes: "—", finishNotes: "—", promoNotes: "—" },
];

// ── Language identification guide (reference-only) ────────────────────────────
export interface LanguageGuideEntry {
  key: string;
  label: string;
  /** Picker language value this maps to (POKEMON_LANGUAGES), for filtering. */
  pickerValue: string;
  region: string;
  sampleScript: string; // safe sample text, never card scans
  setCodeFormat: string;
  rarityFormat: string;
  tips: string[];
  commonMistakes: string[];
}

export const LANGUAGE_GUIDE: readonly LanguageGuideEntry[] = [
  { key: "en", label: "English", pickerValue: "en", region: "western", sampleScript: "Pikachu — Basic Pokémon", setCodeFormat: "SV8 / SWSH12 / no code (vintage)", rarityFormat: "Symbols: ● ◆ ★ (+ modern multi-star)", tips: ["Regulation mark (D/E/F/G/H) bottom-left on modern cards.", "'Pokémon TM' copyright line in English."], commonMistakes: ["Confusing UK/US print runs — same English product.", "Assuming an English code exists for vintage sets — they have none."] },
  { key: "ja", label: "Japanese", pickerValue: "ja", region: "japan", sampleScript: "ピカチュウ — たねポケモン", setCodeFormat: "SV8a / S12a / SM12a — letter suffixes common", rarityFormat: "Letter codes: C U R RR RRR SR SAR AR UR HR CHR CSR", tips: ["Rarity is a LETTER CODE bottom-left, not a symbol.", "Card number often like 205/172 (secret)."], commonMistakes: ["Reading AR/SAR as English IR/SIR — same idea, different code and market.", "Treating a JP set as identical to its EN equivalent — counts differ."] },
  { key: "ko", label: "Korean", pickerValue: "ko", region: "korea", sampleScript: "피카츄 — 기본 포켓몬", setCodeFormat: "Mirrors Japanese codes with 'K' variants", rarityFormat: "Japanese-style letter codes", tips: ["Hangul script is distinct from Japanese kana.", "Release usually follows the Japanese product."], commonMistakes: ["Filing Korean cards as Japanese — check the script."] },
  { key: "zh-cn", label: "Simplified Chinese", pickerValue: "zh-cn", region: "china", sampleScript: "皮卡丘 — 基础宝可梦", setCodeFormat: "CS/CSM-style codes; mainland-exclusive sets exist", rarityFormat: "Letter codes incl. exclusive tiers (e.g. MA)", tips: ["Simplified characters (宝可梦)."], commonMistakes: ["Merging mainland-exclusive sets with international ones — they are separate products."] },
  { key: "zh-tw", label: "Traditional Chinese", pickerValue: "zh-tw", region: "china", sampleScript: "皮卡丘 — 基礎寶可夢", setCodeFormat: "Follows JP-style codes for TW/HK releases", rarityFormat: "Japanese-style letter codes", tips: ["Traditional characters (寶可夢)."], commonMistakes: ["Confusing with Simplified Chinese releases — different products."] },
  { key: "th", label: "Thai", pickerValue: "th", region: "sea", sampleScript: "ปิกาจู — โปเกมอนพื้นฐาน", setCodeFormat: "SEA codes mirroring JP structure", rarityFormat: "Letter codes", tips: ["Thai script is unmistakable; SEA sets released later than JP."], commonMistakes: ["Assuming Thai = Indonesian product line — separate."] },
  { key: "id", label: "Indonesian", pickerValue: "id", region: "sea", sampleScript: "Pikachu — Pokémon Dasar (teks Indonesia)", setCodeFormat: "SEA codes mirroring JP structure", rarityFormat: "Letter codes", tips: ["Latin script but Indonesian text; check copyright line."], commonMistakes: ["Filing as English because of Latin script."] },
  { key: "fr", label: "French", pickerValue: "other", region: "western", sampleScript: "Pikachu — Pokémon de base", setCodeFormat: "Same codes as English (EB/…) with French text", rarityFormat: "Same symbol system as English", tips: ["'Illus.' and French card text; same set structure as EN."], commonMistakes: ["Grading-form language: pick 'Other' — FR is not a separate picker language yet."] },
  { key: "de", label: "German", pickerValue: "other", region: "western", sampleScript: "Pikachu — Basis-Pokémon", setCodeFormat: "Same as English structure", rarityFormat: "Same symbol system", tips: ["German card text."], commonMistakes: ["Same as French — use 'Other' in the picker."] },
  { key: "it", label: "Italian", pickerValue: "other", region: "western", sampleScript: "Pikachu — Pokémon Base", setCodeFormat: "Same as English structure", rarityFormat: "Same symbol system", tips: ["Italian card text."], commonMistakes: ["Use 'Other' in the picker."] },
  { key: "es", label: "Spanish", pickerValue: "other", region: "western", sampleScript: "Pikachu — Pokémon Básico", setCodeFormat: "Same as English structure", rarityFormat: "Same symbol system", tips: ["Spanish card text; LATAM + ES releases."], commonMistakes: ["Use 'Other' in the picker."] },
  { key: "pt", label: "Portuguese", pickerValue: "other", region: "western", sampleScript: "Pikachu — Pokémon Básico (PT)", setCodeFormat: "Same as English structure", rarityFormat: "Same symbol system", tips: ["Brazilian releases most common."], commonMistakes: ["Use 'Other' in the picker."] },
  { key: "other", label: "Other", pickerValue: "other", region: "other", sampleScript: "—", setCodeFormat: "—", rarityFormat: "—", tips: ["Anything not listed — record details in notes."], commonMistakes: [] },
];

// ── Common-confusion comparisons ──────────────────────────────────────────────
export interface ComparisonPair {
  key: string;
  title: string;
  /** Catalogue references: kind + value for each side. */
  left: { kind: "rarity" | "finish" | "promo"; value: string };
  right: { kind: "rarity" | "finish" | "promo"; value: string };
  howToTell: string;
  commonMistake: string;
}

export const COMPARISON_PAIRS: readonly ComparisonPair[] = [
  { key: "sir-vs-ur", title: "Two GOLD stars vs two SILVER stars", left: { kind: "rarity", value: "special_illustration_rare" }, right: { kind: "rarity", value: "ultra_rare" }, howToTell: "Colour of the two stars: gold = Special Illustration Rare (full-art scene), silver = Ultra Rare (ex/Supporter full art).", commonMistake: "Calling a silver-star ex 'SIR' — check the star COLOUR, not the count." },
  { key: "ir-vs-rare", title: "One GOLD star vs one BLACK star", left: { kind: "rarity", value: "illustration_rare" }, right: { kind: "rarity", value: "rare" }, howToTell: "Gold single star = Illustration Rare (full-art artwork). Black single star = ordinary Rare.", commonMistake: "Logging an IR as a plain Rare because both show one star." },
  { key: "sir-vs-sar", title: "SIR (EN) vs SAR (JP)", left: { kind: "rarity", value: "special_illustration_rare" }, right: { kind: "rarity", value: "jp_special_art_rare" }, howToTell: "Same tier, different market: English prints ★★ gold; Japanese prints the letter code 'SAR'.", commonMistake: "Recording a Japanese SAR as English SIR — language drives which code is printed." },
  { key: "ir-vs-ar", title: "IR (EN) vs AR (JP)", left: { kind: "rarity", value: "illustration_rare" }, right: { kind: "rarity", value: "jp_art_rare" }, howToTell: "English: one gold star. Japanese: letter code 'AR'.", commonMistake: "Mixing the EN symbol system with JP letter codes." },
  { key: "sr-vs-ur", title: "SR vs UR (JP)", left: { kind: "rarity", value: "jp_super_rare" }, right: { kind: "rarity", value: "jp_ultra_rare" }, howToTell: "JP SR = full-art (silver 'SR' code). JP UR = gold-etched card ('UR' code) — the gold treatment is the giveaway.", commonMistake: "Assuming UR is below SR — in Japan UR sits above SR." },
  { key: "hr-vs-gold", title: "Hyper Rare vs 'gold card'", left: { kind: "rarity", value: "hyper_rare" }, right: { kind: "rarity", value: "jp_hyper_rare" }, howToTell: "Modern EN Hyper Rare shows ★★★ gold; older rainbow-era HR cards are rainbow-foiled. 'Gold card' is a description, not a rarity — read the printed symbol/code.", commonMistake: "Storing 'GOLD' as a rarity — record the printed HR symbol instead." },
  { key: "reverse-vs-holo", title: "Reverse Holo vs Holo", left: { kind: "finish", value: "reverse_holo" }, right: { kind: "finish", value: "holo" }, howToTell: "Holo: foil INSIDE the artwork window. Reverse: foil on the card BODY, artwork window matte.", commonMistake: "Logging a reverse as holo — check which part shines." },
  { key: "pokeball-vs-masterball", title: "Poké Ball vs Master Ball reverse", left: { kind: "finish", value: "pokeball_reverse" }, right: { kind: "finish", value: "masterball_reverse" }, howToTell: "Pattern stamped in the reverse foil: red/white Poké Balls vs purple Master Balls (much rarer; 151 and selected sets).", commonMistake: "Missing the Master Ball pattern in poor light — tilt the card." },
  { key: "tg-vs-gg", title: "Trainer Gallery vs Galarian Gallery", left: { kind: "promo", value: "trainer_gallery" }, right: { kind: "promo", value: "galarian_gallery" }, howToTell: "Card number prefix: TG## vs GG##.", commonMistake: "Recording a TG/GG card under the main set number range." },
  { key: "promo-vs-rare", title: "Black Star Promo vs ordinary Rare", left: { kind: "promo", value: "black_star_promo" }, right: { kind: "rarity", value: "rare" }, howToTell: "Promos carry a black star with 'PROMO' text and a promo number (e.g. SWSH250) instead of a set rarity symbol.", commonMistake: "Reading the promo star as the Rare symbol — look for the word PROMO." },
  { key: "jp-codes-vs-en-stars", title: "Japanese letter codes vs English star system", left: { kind: "rarity", value: "jp_double_rare" }, right: { kind: "rarity", value: "double_rare" }, howToTell: "Japan prints letter codes (RR, SR, SAR…); English prints star symbols. Same tier names ≠ same printing.", commonMistake: "Entering a JP letter code for an English card (or vice versa)." },
];

// ── Identification notes / common mistakes per catalogue value ────────────────
export interface KnowledgeNote {
  identification: string;
  commonMistakes: string[];
  /** Free-text compatibility hints (reference-only; hard rules stay in the catalogue). */
  compatibility?: string;
}

export const KNOWLEDGE_NOTES: Record<string, KnowledgeNote> = {
  "finish:cosmos_holo": { identification: "Galaxy/starfield speckle pattern in the holo layer.", commonMistakes: ["Confusing with cracked ice — cosmos is round speckles, cracked ice is angular shards."], compatibility: "Common in product/deck holos (EX era onward)." },
  "finish:cracked_ice_holo": { identification: "Angular shattered-glass facets in the foil.", commonMistakes: ["Confusing with cosmos holo."], compatibility: "Mostly product exclusives (BW onward)." },
  "finish:mirror_holo": { identification: "Uniform mirror sheen across the body, no pattern.", commonMistakes: ["Logging mirror-stamped reverse as ordinary reverse holo."] },
  "finish:masterball_reverse": { identification: "Purple Master Ball icons stamped in the reverse foil.", commonMistakes: ["Missing it in poor light — tilt the card."], compatibility: "151 (sv3pt5) + selected SV sets; Japanese equivalents exist." },
  "finish:pokeball_reverse": { identification: "Red/white Poké Ball icons stamped in the reverse foil.", commonMistakes: ["Confusing with Master Ball pattern."], compatibility: "151 (sv3pt5) + selected SV sets." },
  "finish:shadowless": { identification: "No drop shadow right of the artwork frame (Base Set).", commonMistakes: ["Calling any 1999 Base card shadowless — check the frame."], compatibility: "Base Set (1999) only." },
  "finish:first_edition": { identification: "'Edition 1' stamp on the left of the artwork frame.", commonMistakes: ["Missing the stamp on dark artwork."], compatibility: "WOTC era (1999–2002)." },
  "rarity:ace_spec": { identification: "Red ACE SPEC banner; one per deck rule.", commonMistakes: ["Treating the pink/red card frame as a finish."], compatibility: "BW era + SV era only." },
  "rarity:radiant_rare": { identification: "'K' code (JP) / Radiant name + etched criss-cross foil.", commonMistakes: ["Logging as Shiny — Radiant is its own tier."], compatibility: "SWSH era only." },
  "promo:black_star_promo": { identification: "Black star with PROMO text + promo number.", commonMistakes: ["Reading the promo star as a Rare symbol."] },
  "promo:shiny_vault": { identification: "SV-prefixed card number + silver etched frame.", commonMistakes: ["Confusing the SV number prefix with Scarlet & Violet set codes."], compatibility: "Hidden Fates / Shining Fates." },
};

export function knowledgeNoteFor(kind: "rarity" | "finish" | "promo", value: string): KnowledgeNote | undefined {
  return KNOWLEDGE_NOTES[`${kind}:${value}`];
}

// ── Hub overview helpers (pure) ───────────────────────────────────────────────
export function catalogueCounts() {
  const all = [
    ...POKEMON_RARITIES.map((r) => ({ kind: "rarity" as const, value: r.value })),
    ...POKEMON_FINISHES.map((f) => ({ kind: "finish" as const, value: f.value })),
    ...POKEMON_PROMOS.map((p) => ({ kind: "promo" as const, value: p.value })),
  ];
  const byStatus: Record<string, number> = {};
  for (const rec of all) {
    const s = provenanceFor(rec.kind, rec.value).status;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return {
    rarities: POKEMON_RARITIES.length,
    finishes: POKEMON_FINISHES.length,
    promos: POKEMON_PROMOS.filter((p) => p.kind === "promo").length,
    subsets: POKEMON_PROMOS.filter((p) => p.kind === "subset").length,
    languages: POKEMON_LANGUAGES.length,
    eras: POKEMON_ERAS.length,
    timelinePeriods: ERA_TIMELINE.length,
    byStatus,
    version: KNOWLEDGE_CATALOGUE_VERSION,
    checksum: catalogueChecksum(),
  };
}
