/**
 * Server-side catalogue snapshot provider.
 *
 * Builds a {@link CatalogueSnapshot} (the shape the canonical pure helpers in
 * shared/pokemon-rarity-catalogue.ts consume) from the live catalogue_items
 * table, so validateStructuredVariant and the label/preview paths validate
 * against the DB — the single source of truth — instead of the hard-coded
 * arrays. Falls back to the SEED snapshot per-category when the DB has no rows
 * for that category (or the table is missing pre-migration), so nothing ever
 * breaks during rollout.
 *
 * Caching: a short TTL in-memory cache. On a multi-machine Fly deploy this means
 * a catalogue edit is visible on other machines within TTL_MS (bounded staleness
 * for rarely-changing reference data — see WATCH-1 in the task ledger). Any write
 * path should call invalidateCatalogueCache() for the machine it ran on.
 */
import {
  SEED_CATALOGUE,
  type CatalogueSnapshot,
  type PokemonRarity,
  type PokemonFinish,
  type PokemonPromo,
  type PokemonLanguage,
  type PokemonEra,
  type SymbolShape,
  type SymbolColour,
  type RegionScope,
} from "@shared/pokemon-rarity-catalogue";
import type { CatalogueItem } from "@shared/schema";
import { listCatalogueItems } from "../services/catalogueService";

const TTL_MS = 30_000;
let cache: { snap: CatalogueSnapshot; at: number } | null = null;

function meta(row: CatalogueItem): Record<string, unknown> {
  return (row.metadata ?? {}) as Record<string, unknown>;
}

function mapRarity(row: CatalogueItem): PokemonRarity {
  const m = meta(row);
  const sym = (m.symbol ?? {}) as Record<string, unknown>;
  const count = typeof sym.count === "number" ? sym.count : undefined;
  return {
    value: row.value,
    label: row.label,
    description: row.description,
    symbol: {
      shape: (typeof sym.shape === "string" ? sym.shape : "text") as SymbolShape,
      count,
      colour: (typeof sym.colour === "string" ? sym.colour : "white") as SymbolColour,
      glyph: typeof sym.glyph === "string" ? sym.glyph : row.abbreviation ?? "?",
    },
    codes: Array.isArray(m.codes)
      ? (m.codes as string[])
      : row.abbreviation
        ? [row.abbreviation]
        : [],
    regions: (m.regions ?? "all") as RegionScope,
    eras: (Array.isArray(m.eras) ? m.eras : "all") as PokemonEra[] | "all",
    aliases: row.aliases ?? [],
  };
}

function mapFinish(row: CatalogueItem): PokemonFinish {
  return { value: row.value, label: row.label, description: row.description, aliases: row.aliases ?? [] };
}

function mapPromo(row: CatalogueItem): PokemonPromo {
  const kind = meta(row).kind === "subset" || row.category === "subset" ? "subset" : "promo";
  return {
    value: row.value,
    label: row.label,
    description: row.description,
    kind,
    aliases: row.aliases ?? [],
  };
}

function mapLanguage(row: CatalogueItem): PokemonLanguage {
  const region = meta(row).region;
  return {
    value: row.value,
    label: row.label,
    region: (typeof region === "string" ? region : "other") as PokemonLanguage["region"],
    aliases: row.aliases ?? [],
  };
}

function buildSnapshot(rows: CatalogueItem[]): CatalogueSnapshot {
  const by = (c: string) => rows.filter((r) => r.category === c);
  const rarities = by("rarity");
  const finishes = by("finish");
  const promos = [...by("promo"), ...by("subset")];
  const languages = by("language");
  const eras = by("era");
  return {
    // Per-category seed fallback: an empty category never yields an empty picker.
    rarities: rarities.length ? rarities.map(mapRarity) : SEED_CATALOGUE.rarities,
    finishes: finishes.length ? finishes.map(mapFinish) : SEED_CATALOGUE.finishes,
    promos: promos.length ? promos.map(mapPromo) : SEED_CATALOGUE.promos,
    languages: languages.length ? languages.map(mapLanguage) : SEED_CATALOGUE.languages,
    eras: eras.length ? eras.map((r) => ({ value: r.value, label: r.label })) : SEED_CATALOGUE.eras,
  };
}

/** Live catalogue snapshot (active, non-archived rows), cached for TTL_MS. */
export async function getCatalogueSnapshot(force = false): Promise<CatalogueSnapshot> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.snap;
  try {
    const rows = await listCatalogueItems(); // active + non-archived
    const snap = rows.length ? buildSnapshot(rows) : SEED_CATALOGUE;
    cache = { snap, at: Date.now() };
    return snap;
  } catch {
    // Never let a catalogue-load failure break validation/rendering.
    return SEED_CATALOGUE;
  }
}

export function invalidateCatalogueCache(): void {
  cache = null;
}
