/**
 * server/services/tcgdex.ts
 *
 * TCGdex (open-source, no key) lookup service.
 *   - Cached set list per language (24h TTL, lazy-loaded).
 *   - Resolves printed set code → TCGdex set ID via uppercase normalisation
 *     + language-scoped endpoint.
 *   - Card lookup by set ID + card number.
 *
 * Non-negotiable: this service supplies canonical set/card metadata.
 * AI models may ONLY supply the printed code + number + language hint.
 */
import { tcgdexLanguageCode } from "@shared/pokemon-rarity-catalogue";

// ── Language whitelist (OWASP: no arbitrary strings flow into URL) ─────────
const ALLOWED_LANGS = new Set(["en", "ja", "fr", "de", "es", "it", "pt", "ko", "zh-tw", "zh-cn"]);

const BASE_URL = "https://api.tcgdex.net/v2";

// ── Types ─────────────────────────────────────────────────────────────────
export interface TcgdexSetSummary {
  id: string;
  name: string;
}

export interface TcgdexSetFull {
  id: string;
  name: string;
  serie: { id: string; name: string };
  releaseDate?: string;
  cardCount: { total: number; official: number };
  tcgOnline?: string;
  abbreviation?: { official?: string };
}

export interface TcgdexCard {
  id: string; // "SV5K-075"
  localId: string; // "075"
  name: string; // native-language name
  englishName?: string; // present on some non-en endpoints (NOT reliable)
  dexId?: number[]; // National Pokédex number(s) — used to resolve the English name
  set: { id: string; name: string; cardCount?: number };
  rarity?: string;
  category?: string;
  illustrator?: string;
  variants?: Record<string, boolean>;
}

export interface CardLookupResult {
  card_name: string; // English (for a UK cert)
  card_name_local: string; // native-language original (kept in case it's wanted)
  set_id: string;
  canonical_set_id: string;
  set_name: string; // English
  set_name_local: string; // native-language original
  set_code: string | null;
  canonical_mapping_status: "mapped" | "unresolved";
  canonical_mapping_unresolved: boolean;
  series: string;
  release_date: string | null;
  total_cards: number;
  external_card_id: string;
  rarity: string | null;
  rarity_code: string | null;
  rarity_label: string | null;
  finish_variant: string | null;
  resolved_lang: string; // TCGdex lang code the card actually resolved on (ja/en/ko/zh-tw/zh-cn/…) — authoritative for the card's language
}

// ── Per-language set cache (24h TTL) ──────────────────────────────────────
interface SetCache {
  sets: TcgdexSetSummary[];
  /** Map of uppercased set ID → original set ID for fast lookup */
  byUpperId: Map<string, string>;
  expiresAt: number;
}

const SET_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const setCache = new Map<string, SetCache>();

// Simple rate-limit: track last fetch time per language, enforce 1s gap.
const lastFetchTime = new Map<string, number>();
const MIN_FETCH_GAP_MS = 1000;

async function rateLimitedFetch(url: string, lang: string): Promise<Response> {
  const now = Date.now();
  const last = lastFetchTime.get(lang) || 0;
  const wait = Math.max(0, MIN_FETCH_GAP_MS - (now - last));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchTime.set(lang, Date.now());
  return fetch(url);
}

async function getSetList(lang: string): Promise<SetCache> {
  const cached = setCache.get(lang);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const res = await rateLimitedFetch(`${BASE_URL}/${lang}/sets`, lang);
  if (!res.ok) {
    // Return stale cache if available, or empty
    if (cached) return cached;
    return { sets: [], byUpperId: new Map(), expiresAt: Date.now() + 60_000 };
  }

  const sets: TcgdexSetSummary[] = await res.json();
  const byUpperId = new Map<string, string>();
  for (const s of sets) {
    byUpperId.set(s.id.toUpperCase(), s.id);
  }

  const entry: SetCache = { sets, byUpperId, expiresAt: Date.now() + SET_CACHE_TTL_MS };
  setCache.set(lang, entry);
  return entry;
}

// ── Series name mapping ───────────────────────────────────────────────────
// TCGdex returns localised serie.name (e.g. Japanese string). We want a
// readable English series name consistent with pokemontcg.io / existing rows.
const SERIES_ENGLISH: Record<string, string> = {
  SV: "Scarlet & Violet",
  SWSH: "Sword & Shield",
  SM: "Sun & Moon",
  XY: "XY",
  BW: "Black & White",
  DP: "Diamond & Pearl",
  Pt: "Platinum",
  HGSS: "HeartGold & SoulSilver",
  // Add more as needed; fallback uses the raw serie.id
};

function englishSeriesName(serieId: string, serieName: string): string {
  return SERIES_ENGLISH[serieId] || serieName;
}

// ── Japanese set code → established English collector set name ───────────────
// TCGdex has NO English name for Japan-only set IDs (their cards map into a
// different/merged English release — e.g. sv5K's cards appear in English
// "Temporal Forces"). For a UK cert we want the Japanese set's real English
// collector name ("Wild Force"), NOT the merged English-release name. This is a
// curated reference table (same pattern as SERIES_ENGLISH above), NOT machine
// translation. Keyed by UPPERCASE TCGdex set ID. Unmapped codes fall back to the
// localized TCGdex set name (and are logged so they can be added here).
// ⚠️ Use the JAPANESE set's English name, never the merged English-release name.
const JP_SET_ENGLISH_NAME: Record<string, string> = {
  SV5K: "Wild Force",
  SV5M: "Cyber Judge",
  SV4K: "Ancient Roar",
  SV4M: "Future Flash",
  SV3K: "Ruler of the Black Flame",
  SV3: "Raging Surf",
  SV2P: "Snow Hazard",
  SV2D: "Clay Burst",
  SV1S: "Scarlet ex",
  SV1V: "Violet ex",
  SV2A: "Pokémon Card 151", // EN release "151"; market name "Pokémon Card 151"
  SV6: "Mask of Change", // dominant market name (Bulbapedia: "Transformation Mask"); EN release "Twilight Masquerade"
  SV7: "Stellar Miracle", // EN release "Stellar Crown"
  SV8: "Super Electric Breaker", // EN release "Surging Sparks"
  // Add more JP SV-era codes here as needed (unmapped → localized name, logged).
};

const PRINTED_CODE_TO_TCGDEX_SET_ID: Record<string, string> = {
  CRE: "swsh6",
};

const TCGDEX_RARITY_CANONICAL: Record<string, { rarityCode: string; rarityLabel: string }> = {
  "holo rare v": { rarityCode: "holo_rare_v", rarityLabel: "Holo Rare V" },
  "holo rara v": { rarityCode: "holo_rare_v", rarityLabel: "Holo Rare V" },
  "rare holo v": { rarityCode: "holo_rare_v", rarityLabel: "Holo Rare V" },
};

function canonicalRarityFor(rarity: string | null | undefined): { rarityCode: string; rarityLabel: string } | null {
  const key = String(rarity ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return TCGDEX_RARITY_CANONICAL[key] ?? null;
}

// Card-type suffix tokens (ex / V / VMAX / …). These are written in Latin at the
// END of the card name in EVERY language — "リザードンex" / "Charizard ex",
// "ザシアンV" / "Zacian V" — so the suffix survives across JP/KO/ZH. Longest-first
// so VMAX matches before V. \b avoids false hits inside words (e.g. "Vortex").
const CARD_SUFFIX_RE = /\b(VMAX|VSTAR|V-UNION|VUNION|BREAK|Prime|LEGEND|GX|EX|ex|V)\s*$/;
function cardSuffix(name: string): string {
  const m = name.match(CARD_SUFFIX_RE);
  return m ? m[1] : "";
}

/**
 * Resolve the canonical English card name from a National Pokédex number via
 * TCGdex's English card data (e.g. dexId 579 → "Reuniclus"). Uses TCGdex's
 * actual English data — NOT machine translation. Only resolves SINGLE-species
 * cards: multi-Pokémon cards (Tag Team etc.) would mis-resolve to one name.
 * Picks the English card whose card-type SUFFIX matches the localized card's
 * suffix, so "ウネルミナモex" → "Walking Wake ex", not the bare "Walking Wake".
 * Returns null for cards with no usable dexId or no English match.
 */
async function englishCardNameByDexId(dexId: number[] | undefined, localizedName: string): Promise<string | null> {
  if (!Array.isArray(dexId) || dexId.length !== 1 || !Number.isFinite(dexId[0])) return null;
  try {
    const res = await rateLimitedFetch(`${BASE_URL}/en/cards?dexId=${encodeURIComponent(String(dexId[0]))}`, "en");
    if (!res.ok) return null;
    const named = ((await res.json()) as Array<{ name?: string }>).filter(
      (c): c is { name: string } => typeof c.name === "string" && c.name.length > 0
    );
    if (!named.length) return null;
    const want = cardSuffix(localizedName).toLowerCase();
    // Prefer the English print whose suffix matches (ex↔ex, V↔V, plain↔plain).
    const match = named.find((c) => cardSuffix(c.name).toLowerCase() === want);
    return (match || named[0]).name;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Validate that a language string is in the whitelist. */
export function isAllowedLang(lang: string): boolean {
  const code = tcgdexLanguageCode(lang);
  return Boolean(code && ALLOWED_LANGS.has(code));
}

export function normalizeTcgdexLang(lang: string | null | undefined): string {
  return tcgdexLanguageCode(lang) ?? "en";
}

/** Every Pokémon set summary ({ id, name }) for a language (24h-cached). Used by
 *  the set-catalogue import (tcgdex-sets-import.ts) to enumerate all sets. */
export async function listAllSets(lang = "en"): Promise<TcgdexSetSummary[]> {
  const cache = await getSetList(lang);
  return cache.sets;
}

/** Brief card shape from a name search: id is "{setId}-{localId}". */
export interface TcgdexCardBrief {
  id: string;
  localId: string;
  name: string;
}

/** Search cards by NAME (language-scoped, rate-limited). Returns the brief shape
 *  ({ id, localId, name }); the card id encodes the set ("{setId}-{localId}"), so
 *  the set is derivable. Used to resolve a set from card name+number when the AI
 *  couldn't read the printed set code. Returns [] on any non-OK response. */
export async function searchCardsByName(name: string, lang = "en"): Promise<TcgdexCardBrief[]> {
  const clean = String(name || "").trim();
  if (clean.length < 2) return [];
  const res = await rateLimitedFetch(`${BASE_URL}/${lang}/cards?name=${encodeURIComponent(clean)}`, lang);
  if (!res.ok) return [];
  const cards = await res.json();
  return Array.isArray(cards) ? (cards as TcgdexCardBrief[]) : [];
}

/**
 * Resolve a printed set code (e.g. "sv5K") to the TCGdex set ID.
 * Tries the given language first, then falls back to "en".
 * Returns null if not found in either.
 */
export async function resolveSetId(
  printedCode: string,
  lang: string
): Promise<{ tcgdexSetId: string; resolvedLang: string } | null> {
  const upper = printedCode.toUpperCase();
  const safeLang = normalizeTcgdexLang(lang);
  const aliasId = PRINTED_CODE_TO_TCGDEX_SET_ID[upper];
  if (aliasId && (await fetchSet(aliasId, safeLang))) return { tcgdexSetId: aliasId, resolvedLang: safeLang };

  // Try language-scoped first
  const primaryCache = await getSetList(safeLang);
  const primaryId = primaryCache.byUpperId.get(upper);
  if (primaryId) return { tcgdexSetId: primaryId, resolvedLang: safeLang };

  const canonicalFromLanguageSet = primaryCache.sets.find((s) => {
    const id = s.id.toUpperCase();
    return id === upper || id.endsWith(upper) || upper.endsWith(id);
  });
  if (canonicalFromLanguageSet) return { tcgdexSetId: canonicalFromLanguageSet.id, resolvedLang: safeLang };

  // Fall back to English if different
  if (safeLang !== "en") {
    const enCache = await getSetList("en");
    const enId = enCache.byUpperId.get(upper);
    if (enId) return { tcgdexSetId: enId, resolvedLang: "en" };
    const canonicalFromEnglishSet = enCache.sets.find((s) => {
      const id = s.id.toUpperCase();
      return id === upper || id.endsWith(upper) || upper.endsWith(id);
    });
    if (canonicalFromEnglishSet) return { tcgdexSetId: canonicalFromEnglishSet.id, resolvedLang: "en" };
  }

  return null;
}

/**
 * Fetch full set metadata from TCGdex.
 */
export async function fetchSet(tcgdexSetId: string, lang: string): Promise<TcgdexSetFull | null> {
  const res = await rateLimitedFetch(`${BASE_URL}/${lang}/sets/${encodeURIComponent(tcgdexSetId)}`, lang);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Fetch a specific card from TCGdex.
 * cardId format: "{setId}-{localId}", e.g. "SV5K-075"
 */
export async function fetchCard(tcgdexSetId: string, cardNumber: string, lang: string): Promise<TcgdexCard | null> {
  // TCGdex card IDs are {setId}-{localId} where localId is zero-padded
  const raw = String(cardNumber || "").trim();
  const local = raw.split("/")[0] || raw;
  const stripped = local.replace(/^0+(?=\d)/, "");
  const candidates = Array.from(new Set([local, stripped].filter(Boolean)));
  for (const n of candidates) {
    const cardId = `${tcgdexSetId}-${n}`;
    const res = await rateLimitedFetch(`${BASE_URL}/${lang}/cards/${encodeURIComponent(cardId)}`, lang);
    if (res.ok) return res.json();
  }
  return null;
}

/**
 * Full card lookup: printed code + card number + language → canonical metadata.
 * Returns null if TCGdex can't resolve the set or card.
 */
export async function lookupCard(
  printedCode: string,
  cardNumber: string,
  lang: string
): Promise<CardLookupResult | null> {
  const requestedLang = normalizeTcgdexLang(lang);
  const resolved = await resolveSetId(printedCode, requestedLang);
  if (!resolved) {
    console.log(`[tcgdex] set not found for code="${printedCode}" lang="${lang}"`);
    return null;
  }

  const { tcgdexSetId, resolvedLang } = resolved;

  // Fetch set for metadata
  const setData = await fetchSet(tcgdexSetId, resolvedLang);
  if (!setData) {
    console.log(`[tcgdex] set detail fetch failed for id="${tcgdexSetId}" lang="${resolvedLang}"`);
    return null;
  }

  // Fetch card
  const card = await fetchCard(tcgdexSetId, cardNumber, resolvedLang);
  if (!card) {
    console.log(`[tcgdex] card not found: ${tcgdexSetId}-${cardNumber} lang="${resolvedLang}"`);
    return null;
  }

  const releaseDate = setData.releaseDate || null;
  const englishSetData = resolvedLang === "en" ? setData : await fetchSet(tcgdexSetId, "en");
  const canonicalMappingStatus: "mapped" | "unresolved" = englishSetData ? "mapped" : "unresolved";
  const providerSetCode = englishSetData?.tcgOnline || englishSetData?.abbreviation?.official || setData.tcgOnline || setData.abbreviation?.official || null;
  const submittedSetCode =
    /^[A-Za-z]{2,6}$/.test(String(printedCode).trim()) && String(printedCode).trim().toUpperCase() !== tcgdexSetId.toUpperCase()
      ? String(printedCode).trim().toUpperCase()
      : null;
  const setCode = providerSetCode || submittedSetCode;

  // ── English SET name: curated JP-code map → localized fallback ──────────────
  const upperSetId = tcgdexSetId.toUpperCase();
  const mappedSetName = JP_SET_ENGLISH_NAME[upperSetId];
  if (!mappedSetName && resolvedLang !== "en") {
    console.log(
      `[tcgdex] no English set-name mapping for "${tcgdexSetId}" (lang=${resolvedLang}) — using localized "${setData.name}". Add it to JP_SET_ENGLISH_NAME if you want it in English.`
    );
  }
  const setNameEnglish = englishSetData?.name || mappedSetName || setData.name;

  // ── English CARD name: englishName → dexId lookup → localized fallback ──────
  // PRIMARY: card.englishName (rarely present, but includes the full suffix).
  // FALLBACK: dexId → English species, matched to the localized card's suffix.
  let cardNameEnglish: string | null = card.englishName || null;
  if (!cardNameEnglish && resolvedLang !== "en") {
    cardNameEnglish = await englishCardNameByDexId(card.dexId, card.name);
  }
  cardNameEnglish = cardNameEnglish || card.name;
  const rarity = canonicalRarityFor(card.rarity);
  const availablePrintings = Object.entries(card.variants ?? {}).filter(([, available]) => available);
  const finishVariant =
    availablePrintings.length === 1 && card.variants?.holo
      ? "holo"
      : availablePrintings.length === 1 && card.variants?.normal
        ? "non_holo"
        : null;

  return {
    card_name: cardNameEnglish,
    card_name_local: card.name,
    set_id: tcgdexSetId,
    canonical_set_id: tcgdexSetId,
    set_name: setNameEnglish,
    set_name_local: setData.name,
    set_code: setCode,
    canonical_mapping_status: canonicalMappingStatus,
    canonical_mapping_unresolved: canonicalMappingStatus === "unresolved",
    series: englishSeriesName((englishSetData ?? setData).serie.id, (englishSetData ?? setData).serie.name),
    release_date: releaseDate,
    total_cards: setData.cardCount.official,
    external_card_id: card.id,
    rarity: card.rarity || null,
    rarity_code: rarity?.rarityCode ?? null,
    rarity_label: rarity?.rarityLabel ?? null,
    finish_variant: finishVariant,
    resolved_lang: resolvedLang,
  };
}
