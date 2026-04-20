/**
 * MintVault Card Database
 * Lookup card details from external TCG databases by game and query string.
 * Pokémon TCG API, Scryfall (MTG), YGOPRODeck.
 */

export interface CardLookupResult {
  id: string;
  name: string;
  setName: string;
  setCode: string | null;
  number: string | null;
  rarity: string | null;
  year: string | null;
  game: string;
  imageUrl: string | null;
  source: string;
}

// Simple in-memory cache: key = `${game}:${query}`, value = results + timestamp
const cache = new Map<string, { results: CardLookupResult[]; ts: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

function fromCache(key: string): CardLookupResult[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.results;
}

function toCache(key: string, results: CardLookupResult[]) {
  cache.set(key, { results, ts: Date.now() });
}

/** Pokémon TCG API — requires POKEMON_TCG_API_KEY env var */
async function lookupPokemon(query: string, mode: "exact" | "wildcard" = "exact"): Promise<CardLookupResult[]> {
  const apiKey = process.env.POKEMON_TCG_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;

  const clean = query.trim().replace(/"/g, "");
  const q = mode === "wildcard"
    ? `name:${encodeURIComponent(clean)}*`
    : `name:"${encodeURIComponent(clean)}"`;
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=10`;
  console.log(`[lookup-pokemon] query="${query}" mode=${mode} final_url=${url}`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Pokémon TCG API error: ${res.status}`);
  const json = await res.json();

  return (json.data || []).map((card: any): CardLookupResult => ({
    id: card.id,
    name: card.name,
    setName: card.set?.name || "",
    setCode: card.set?.id || null,
    number: card.number || null,
    rarity: card.rarity || null,
    year: card.set?.releaseDate ? card.set.releaseDate.slice(0, 4) : null,
    game: "pokemon",
    imageUrl: card.images?.large || card.images?.small || null,
    source: "pokemontcg.io",
  }));
}

/** Scryfall API — MTG, no key required. Respect 100ms delay between calls. */
let lastScryfallCall = 0;
async function lookupMtg(query: string): Promise<CardLookupResult[]> {
  const now = Date.now();
  const wait = 100 - (now - lastScryfallCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastScryfallCall = Date.now();

  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=released&dir=asc&unique=prints`;
  const res = await fetch(url, { headers: { "User-Agent": "MintVault/1.0" } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Scryfall API error: ${res.status}`);
  const json = await res.json();

  return (json.data || []).slice(0, 10).map((card: any): CardLookupResult => ({
    id: card.id,
    name: card.name,
    setName: card.set_name || "",
    setCode: card.set || null,
    number: card.collector_number || null,
    rarity: card.rarity || null,
    year: card.released_at ? card.released_at.slice(0, 4) : null,
    game: "mtg",
    imageUrl: card.image_uris?.normal || card.image_uris?.small || null,
    source: "scryfall.com",
  }));
}

/** YGOPRODeck API — Yu-Gi-Oh!, no key required */
async function lookupYugioh(query: string): Promise<CardLookupResult[]> {
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(query)}&num=10&offset=0`;
  const res = await fetch(url);
  if (res.status === 400) return []; // YGOPRODeck returns 400 for no results
  if (!res.ok) throw new Error(`YGOPRODeck API error: ${res.status}`);
  const json = await res.json();

  return (json.data || []).flatMap((card: any): CardLookupResult[] => {
    // Each card may have multiple card sets
    const sets: any[] = card.card_sets || [{}];
    return sets.slice(0, 3).map((s: any) => ({
      id: `${card.id}-${s.set_code || ""}`,
      name: card.name,
      setName: s.set_name || "Unknown Set",
      setCode: s.set_code || null,
      number: s.set_code || null,
      rarity: s.set_rarity || card.type || null,
      year: null,
      game: "yugioh",
      imageUrl: card.card_images?.[0]?.image_url || null,
      source: "ygoprodeck.com",
    }));
  });
}

/**
 * Look up a card from external databases.
 * @param game  "pokemon" | "mtg" | "yugioh" | "other"
 * @param query Card name or search string
 */
export async function lookupCard(game: string, query: string, mode: "exact" | "wildcard" = "exact"): Promise<CardLookupResult[]> {
  if (!query || query.trim().length < 2) return [];
  // Normalise display names → canonical keys: "Pokémon" → "pokemon", "Yu-Gi-Oh!" → "yugioh"
  const canonical = game.toLowerCase().replace(/[éè]/g, "e").replace(/[^a-z0-9]/g, "");
  const key = `${canonical}:${mode}:${query.toLowerCase().trim()}`;
  const cached = fromCache(key);
  if (cached) return cached;

  let results: CardLookupResult[] = [];
  try {
    switch (canonical) {
      case "pokemon":
        results = await lookupPokemon(query, mode);
        break;
      case "mtg":
      case "magic":
      case "magicthegathering":
        results = await lookupMtg(query);
        break;
      case "yugioh":
      case "yugioh!":
        results = await lookupYugioh(query);
        break;
      default:
        // No external DB for this game — return empty
        return [];
    }
  } catch (err) {
    console.error(`[card-database] lookup failed for ${game}:`, err);
    return [];
  }

  toCache(key, results);
  return results;
}
