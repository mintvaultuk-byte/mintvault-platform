/**
 * Static hashtag presets for the weekly-reel caption builder. No external
 * dependencies — just exported arrays + a helper that respects the
 * pipeline_settings count cap and custom override.
 */

import type { HashtagPreset } from "./pipeline-settings";

export const HASHTAG_PRESETS: Record<Exclude<HashtagPreset, "custom">, string[]> = {
  pokemon: [
    "#pokemoncards",
    "#pokemontcg",
    "#psa",
    "#cardgrading",
    "#pokemon",
    "#vintagepokemon",
    "#pokemoncard",
    "#cardcollector",
    "#holorarecards",
    "#pokemoncommunity",
    "#gradedcards",
    "#mintvaultuk",
    "#tcg",
    "#tradingcards",
    "#pokemoncollector",
  ],
  yugioh: [
    "#yugioh",
    "#yugiohcards",
    "#yugiohtcg",
    "#cardgrading",
    "#tradingcards",
    "#gradedcards",
    "#mintvaultuk",
    "#tcg",
    "#yugiohcommunity",
    "#cardcollector",
  ],
  mtg: [
    "#mtg",
    "#magicthegathering",
    "#magictcg",
    "#cardgrading",
    "#tradingcards",
    "#gradedcards",
    "#mintvaultuk",
    "#tcg",
    "#magiccard",
    "#cardcollector",
  ],
  onepiece: [
    "#onepiecetcg",
    "#onepiececards",
    "#onepiece",
    "#cardgrading",
    "#tradingcards",
    "#gradedcards",
    "#mintvaultuk",
    "#tcg",
    "#cardcollector",
  ],
  sports: [
    "#sportscards",
    "#sportscardcommunity",
    "#cardgrading",
    "#psa",
    "#gradedcards",
    "#mintvaultuk",
    "#tradingcards",
    "#cardcollector",
    "#sportscard",
  ],
};

/** Build the final hashtag list for a reel. Trims duplicates, caps to
 *  count, and falls back to pokemon if a custom preset has no entries. */
export function buildHashtags(opts: { preset: HashtagPreset; customRaw: string; count: number }): string[] {
  const cap = Math.max(0, Math.min(30, Math.floor(opts.count)));
  let pool: string[];
  if (opts.preset === "custom") {
    pool = parseCustomHashtags(opts.customRaw);
    if (pool.length === 0) pool = [...HASHTAG_PRESETS.pokemon];
  } else {
    pool = [...(HASHTAG_PRESETS[opts.preset] ?? HASHTAG_PRESETS.pokemon)];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of pool) {
    const norm = normaliseTag(tag);
    if (!norm || seen.has(norm.toLowerCase())) continue;
    seen.add(norm.toLowerCase());
    out.push(norm);
    if (out.length >= cap) break;
  }
  return out;
}

/** Accepts comma- newline- or space-separated input. Normalises each to
 *  `#tag` form (strips leading `#`s and re-adds one). */
function parseCustomHashtags(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((t) => normaliseTag(t))
    .filter((t): t is string => !!t);
}

function normaliseTag(raw: string): string | null {
  const trimmed = raw.trim().replace(/^#+/, "");
  if (!trimmed) return null;
  // Strip whitespace and punctuation that would break a hashtag.
  const cleaned = trimmed.replace(/[^A-Za-z0-9_]/g, "");
  if (!cleaned) return null;
  return `#${cleaned}`;
}
