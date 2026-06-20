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
}

export interface TcgdexCard {
  id: string; // "SV5K-075"
  localId: string; // "075"
  name: string; // native-language name
  englishName?: string; // present on non-en endpoints
  set: { id: string; name: string; cardCount?: number };
  rarity?: string;
  category?: string;
  illustrator?: string;
  variants?: Record<string, boolean>;
}

export interface CardLookupResult {
  card_name: string;
  set_id: string;
  set_name: string;
  series: string;
  release_date: string | null;
  total_cards: number;
  external_card_id: string;
  rarity: string | null;
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

// ── Public API ────────────────────────────────────────────────────────────

/** Validate that a language string is in the whitelist. */
export function isAllowedLang(lang: string): boolean {
  return ALLOWED_LANGS.has(lang);
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

  // Try language-scoped first
  const primaryCache = await getSetList(lang);
  const primaryId = primaryCache.byUpperId.get(upper);
  if (primaryId) return { tcgdexSetId: primaryId, resolvedLang: lang };

  // Fall back to English if different
  if (lang !== "en") {
    const enCache = await getSetList("en");
    const enId = enCache.byUpperId.get(upper);
    if (enId) return { tcgdexSetId: enId, resolvedLang: "en" };
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
  const cardId = `${tcgdexSetId}-${cardNumber}`;
  const res = await rateLimitedFetch(`${BASE_URL}/${lang}/cards/${encodeURIComponent(cardId)}`, lang);
  if (!res.ok) return null;
  return res.json();
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
  const resolved = await resolveSetId(printedCode, lang);
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

  const cardName = card.englishName || card.name;
  const releaseDate = setData.releaseDate || null;

  return {
    card_name: cardName,
    set_id: tcgdexSetId,
    set_name: setData.name,
    series: englishSeriesName(setData.serie.id, setData.serie.name),
    release_date: releaseDate,
    total_cards: setData.cardCount.official,
    external_card_id: card.id,
    rarity: card.rarity || null,
  };
}
