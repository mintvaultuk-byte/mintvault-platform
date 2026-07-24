/**
 * Authoritative structured-variant validation + normalisation (server-trusted).
 *
 * The client picker only PROPOSES a selection; the server calls this to validate
 * it against the catalogue and DERIVE the stored symbol/colour/count/region from
 * the canonical data — so a client can never store "gold" on a silver rarity, an
 * unknown rarity code, or a symbol count the picker never showed. Pure + shared:
 * the same function powers the live preview + warnings in the browser and the
 * authoritative gate on the server.
 *
 * Nothing here writes a database or touches the legacy `variant` column — it only
 * computes the values for the NEW nullable columns.
 */
import {
  rarityByValue,
  finishByValue,
  promoByValue,
  languageByValueOrLabel,
  mapLegacyVariant,
  SEED_CATALOGUE,
  type CatalogueSnapshot,
  type PokemonEra,
  type SymbolColour,
} from "./pokemon-rarity-catalogue";

export interface StructuredVariantInput {
  /** Canonical rarity value from POKEMON_RARITIES (e.g. "special_illustration_rare"). */
  rarityCode?: string | null;
  /** Canonical finish value from POKEMON_FINISHES. */
  finishVariant?: string | null;
  /** Canonical promo value from POKEMON_PROMOS (kind must be "promo"). */
  promoType?: string | null;
  /** Canonical subset value from POKEMON_PROMOS (kind must be "subset"). */
  subsetName?: string | null;
  /** Language as a catalogue code ("en") OR the existing display name ("English"). Region is DERIVED. */
  language?: string | null;
  /** Set era. */
  era?: string | null;
  /** The card's existing legacy variant value — used only to warn, never written. */
  legacyVariant?: string | null;
}

/** The values written to the NEW nullable columns (never the legacy `variant`). */
export interface StructuredVariantColumns {
  rarityCode: string | null;
  rarityLabel: string | null;
  printedSymbol: string | null;
  printedSymbolCount: number | null;
  printedSymbolColour: SymbolColour | null;
  finishVariant: string | null;
  promoType: string | null;
  subsetName: string | null;
  region: string | null;
  era: string | null;
  structuredVariantVersion: number | null;
}

export interface StructuredVariantResult {
  /** false ⇒ at least one hard error; the server must reject the write. */
  ok: boolean;
  columns: StructuredVariantColumns;
  /** Hard failures (unknown code / bad enum) — reject the save. */
  errors: string[];
  /** Soft advisories (unsupported era/region, missing rarity, long combo, ambiguous legacy). */
  warnings: string[];
}

/** Current structured-schema version stamped when any structured field is set. */
export const STRUCTURED_VARIANT_VERSION = 1;

const EMPTY_COLUMNS: StructuredVariantColumns = {
  rarityCode: null,
  rarityLabel: null,
  printedSymbol: null,
  printedSymbolCount: null,
  printedSymbolColour: null,
  finishVariant: null,
  promoType: null,
  subsetName: null,
  region: null,
  era: null,
  structuredVariantVersion: null,
};

const clean = (v: string | null | undefined): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

function isEra(v: string | null, cat: CatalogueSnapshot): v is PokemonEra {
  return v != null && cat.eras.some((e) => e.value === v);
}

/** True when a normalised column set carries any structured data. */
export function hasStructuredData(cols: StructuredVariantColumns): boolean {
  return Boolean(
    cols.rarityCode || cols.finishVariant || cols.promoType || cols.subsetName || cols.region || cols.era,
  );
}

/**
 * Map the neutral column shape onto the Drizzle `certificates` field names so a
 * route can spread the result straight into its insert/update `data` object.
 * (Only the new nullable columns — never the legacy `variant`/`rarity`.)
 */
export function structuredColumnsToCertFields(cols: StructuredVariantColumns): {
  rarityCode: string | null;
  rarityLabelStructured: string | null;
  printedSymbol: string | null;
  printedSymbolCount: number | null;
  printedSymbolColour: string | null;
  finishVariant: string | null;
  promoType: string | null;
  subsetName: string | null;
  region: string | null;
  era: string | null;
  structuredVariantVersion: number | null;
} {
  return {
    rarityCode: cols.rarityCode,
    rarityLabelStructured: cols.rarityLabel,
    printedSymbol: cols.printedSymbol,
    printedSymbolCount: cols.printedSymbolCount,
    printedSymbolColour: cols.printedSymbolColour,
    finishVariant: cols.finishVariant,
    promoType: cols.promoType,
    subsetName: cols.subsetName,
    region: cols.region,
    era: cols.era,
    structuredVariantVersion: cols.structuredVariantVersion,
  };
}

/**
 * Validate + normalise a structured selection into the values for the new
 * columns. Unknown catalogue codes are hard errors; unsupported era/region
 * pairings and a few UX pitfalls are soft warnings (still saveable).
 */
export function validateStructuredVariant(
  input: StructuredVariantInput,
  cat: CatalogueSnapshot = SEED_CATALOGUE,
): StructuredVariantResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rarityCode = clean(input.rarityCode);
  const finishCode = clean(input.finishVariant);
  const promoCode = clean(input.promoType);
  const subsetCode = clean(input.subsetName);
  const languageValue = clean(input.language);
  const eraCode = clean(input.era);

  const rarity = rarityCode ? rarityByValue(rarityCode, cat) : undefined;
  if (rarityCode && !rarity) errors.push(`Unknown rarity "${rarityCode}".`);

  const finish = finishCode ? finishByValue(finishCode, cat) : undefined;
  if (finishCode && !finish) errors.push(`Unknown finish "${finishCode}".`);

  const promo = promoCode ? promoByValue(promoCode, cat) : undefined;
  if (promoCode && !promo) errors.push(`Unknown promo "${promoCode}".`);
  else if (promo && promo.kind !== "promo") errors.push(`"${promo.label}" is a subset, not a promo.`);

  const subset = subsetCode ? promoByValue(subsetCode, cat) : undefined;
  if (subsetCode && !subset) errors.push(`Unknown subset "${subsetCode}".`);
  else if (subset && subset.kind !== "subset") errors.push(`"${subset.label}" is a promo, not a subset.`);

  const lang = languageValue ? languageByValueOrLabel(languageValue, cat) : undefined;
  if (languageValue && !lang) errors.push(`Unknown language "${languageValue}".`);

  if (eraCode && !isEra(eraCode, cat)) errors.push(`Unknown era "${eraCode}".`);

  if (errors.length > 0) {
    return { ok: false, columns: { ...EMPTY_COLUMNS }, errors, warnings };
  }

  const region = lang?.region ?? null;
  const era = isEra(eraCode, cat) ? eraCode : null;

  // Symbol facts are DERIVED from the catalogue — never taken from the client.
  const columns: StructuredVariantColumns = {
    rarityCode: rarity?.value ?? null,
    rarityLabel: rarity?.label ?? null,
    printedSymbol: rarity?.symbol.glyph ?? null,
    printedSymbolCount: rarity?.symbol.count ?? null,
    printedSymbolColour: rarity?.symbol.colour ?? null,
    finishVariant: finish?.value ?? null,
    promoType: promo?.kind === "promo" ? promo.value : null,
    subsetName: subset?.kind === "subset" ? subset.value : null,
    region,
    era,
    structuredVariantVersion: null,
  };

  const carriesData = hasStructuredData(columns);
  columns.structuredVariantVersion = carriesData ? STRUCTURED_VARIANT_VERSION : null;

  // ── Soft warnings (Phase 9) ────────────────────────────────────────────────
  if (rarity && region && rarity.regions !== "all" && !rarity.regions.includes(region)) {
    warnings.push(`"${rarity.label}" is not normally printed in the ${region} region — double-check the language.`);
  }
  if (rarity && era && rarity.eras !== "all" && !rarity.eras.includes(era)) {
    const eraLabel = cat.eras.find((e) => e.value === era)?.label ?? era;
    warnings.push(`"${rarity.label}" did not exist in the ${eraLabel} era — double-check the set.`);
  }
  if (!rarity && (finish || promo)) {
    warnings.push("No printed rarity selected — only a finish/promo is set.");
  }
  if (!carriesData) {
    // Nothing structured chosen: fall back to the legacy value, flag if ambiguous.
    const legacy = clean(input.legacyVariant);
    if (legacy) {
      const mapped = mapLegacyVariant(legacy);
      if (mapped.ambiguous) {
        warnings.push(`The existing value "${legacy}" is ambiguous — pick a structured rarity to clarify it.`);
      }
    }
  }
  // Overly long combined display (label preview) — warn so it does not overflow.
  const combo = [columns.rarityLabel, columns.finishVariant, columns.promoType, columns.subsetName]
    .filter(Boolean)
    .join(" · ");
  if (combo.length > 48) {
    warnings.push("This combination is long and may be truncated on the label preview.");
  }

  return { ok: true, columns, errors, warnings };
}
