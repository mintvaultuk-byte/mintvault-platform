/**
 * Pure mapping from catalogue_items rows → the canonical {@link CatalogueSnapshot}
 * the grading pickers + validation consume. No DB, no I/O — the server provider
 * fetches the rows and calls this; tests can call it with plain row objects.
 *
 * Per-category seed fallback: an empty category yields the seed slice, so an
 * incomplete catalogue never produces an empty picker.
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
} from "./pokemon-rarity-catalogue";

/** The subset of a catalogue_items row this mapping needs (structural). */
export interface CatalogueRowLike {
  category: string;
  value: string;
  label: string;
  abbreviation?: string | null;
  aliases?: string[] | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

function meta(row: CatalogueRowLike): Record<string, unknown> {
  return (row.metadata ?? {}) as Record<string, unknown>;
}

export function mapRarityRow(row: CatalogueRowLike): PokemonRarity {
  const m = meta(row);
  const sym = (m.symbol ?? {}) as Record<string, unknown>;
  const count = typeof sym.count === "number" ? sym.count : undefined;
  return {
    value: row.value,
    label: row.label,
    description: row.description ?? "",
    symbol: {
      shape: (typeof sym.shape === "string" ? sym.shape : "text") as SymbolShape,
      count,
      colour: (typeof sym.colour === "string" ? sym.colour : "white") as SymbolColour,
      glyph: typeof sym.glyph === "string" ? sym.glyph : row.abbreviation ?? "?",
    },
    codes: Array.isArray(m.codes) ? (m.codes as string[]) : row.abbreviation ? [row.abbreviation] : [],
    regions: (m.regions ?? "all") as RegionScope,
    eras: (Array.isArray(m.eras) ? m.eras : "all") as PokemonEra[] | "all",
    aliases: row.aliases ?? [],
  };
}

export function mapFinishRow(row: CatalogueRowLike): PokemonFinish {
  return { value: row.value, label: row.label, description: row.description ?? "", aliases: row.aliases ?? [] };
}

export function mapPromoRow(row: CatalogueRowLike): PokemonPromo {
  const kind = meta(row).kind === "subset" || row.category === "subset" ? "subset" : "promo";
  return { value: row.value, label: row.label, description: row.description ?? "", kind, aliases: row.aliases ?? [] };
}

export function mapLanguageRow(row: CatalogueRowLike): PokemonLanguage {
  const region = meta(row).region;
  return {
    value: row.value,
    label: row.label,
    region: (typeof region === "string" ? region : "other") as PokemonLanguage["region"],
    aliases: row.aliases ?? [],
  };
}

export function buildSnapshotFromRows(rows: CatalogueRowLike[]): CatalogueSnapshot {
  const by = (c: string) => rows.filter((r) => r.category === c);
  const rarities = by("rarity");
  const finishes = by("finish");
  const promos = [...by("promo"), ...by("subset")];
  const languages = by("language");
  const eras = by("era");
  return {
    rarities: rarities.length ? rarities.map(mapRarityRow) : SEED_CATALOGUE.rarities,
    finishes: finishes.length ? finishes.map(mapFinishRow) : SEED_CATALOGUE.finishes,
    promos: promos.length ? promos.map(mapPromoRow) : SEED_CATALOGUE.promos,
    languages: languages.length ? languages.map(mapLanguageRow) : SEED_CATALOGUE.languages,
    eras: eras.length ? eras.map((r) => ({ value: r.value, label: r.label })) : SEED_CATALOGUE.eras,
  };
}
