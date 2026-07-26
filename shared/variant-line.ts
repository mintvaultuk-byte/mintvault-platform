/**
 * variant-line.ts — THE single source of truth for the consolidated public
 * "Variant" line shown to customers and printed on the front certificate label.
 *
 * One card carries at most: one rarity, one finish, one promo/subset. This
 * formatter joins the human-readable catalogue labels of whichever of those are
 * set into ONE deterministic string, e.g.:
 *
 *   "Holo Rare"                         (rarity only)
 *   "Reverse Holo"                      (finish only)
 *   "Holo Rare · Cosmos Holo"           (rarity · finish)
 *   "Black Star Promo · Cosmos Holo"    (promo · finish)
 *   "ACE SPEC"                          (rarity only)
 *
 * Join order is fixed: [rarity, promo, subset, finish], separated by " · ",
 * empties skipped (never a leading/trailing/double separator). Legacy
 * `variant`/`rarity` codes are folded in via mapLegacyVariant() so a card that
 * only ever had a legacy value (e.g. COSMOS_HOLO) is NOT silently dropped.
 *
 * Consumed by: the Rarity-stage variant summary, the Review summary, the live
 * label-preview endpoint, and the printed-label renderer — so every surface
 * shows byte-identical wording. There is exactly one formatter; nothing else
 * joins these parts. This module is pure data (no DOM/DB/IO) and touches NO
 * grading, MVGS, centering, or subgrade logic.
 */
import { rarityByValue, finishByValue, promoByValue, mapLegacyVariant } from "./pokemon-rarity-catalogue";

/** Bumped whenever a save materialises structured columns. The printed-label
 *  renderer prints the CONSOLIDATED variant line only for certs saved at this
 *  scheme (or newer); older certs keep their exact previous label wording, so
 *  existing certificates are never retroactively changed. */
export const CONSOLIDATED_VARIANT_SCHEME = 2;

export interface VariantLineInput {
  rarityCode?: string | null;
  finishVariant?: string | null;
  promoType?: string | null;
  subsetName?: string | null;
  /**
   * Legacy free-form columns. Folded in ONLY to fill an empty structured slot,
   * and ONLY for a certificate that is not yet on the consolidated scheme — see
   * `structuredVariantVersion` below.
   */
  variant?: string | null;
  rarity?: string | null;
  variantOther?: string | null;
  rarityOther?: string | null;
  /**
   * The certificate's structured scheme version. At >= CONSOLIDATED_VARIANT_SCHEME
   * the line is derived ONLY from the explicit structured fields: an empty
   * rarity/finish/promo means that part is simply not displayed, and the legacy
   * columns are NOT folded in. Below that (or absent) the legacy fold still
   * applies, so an untouched pre-consolidation certificate keeps byte-identical
   * wording. The legacy columns themselves are never modified either way.
   */
  structuredVariantVersion?: number | null;
}

/** Public-facing wording overrides where the catalogue's descriptive label is
 *  not the customer-facing variant wording (e.g. the classic single-star rare
 *  prints as "Holo Rare", not the catalogue's "Rare Holo (classic)"). */
const PUBLIC_LABEL_OVERRIDES: Record<string, string> = {
  rare_holo: "Holo Rare",
};

/** Wording for a LEGACY variant/rarity code that has no clean structured
 *  equivalent — used so such a value is preserved in the consolidated line
 *  instead of being dropped. Mirrors the legacy label maps' word order for the
 *  cases where a plain title-case differs (e.g. RARE_HOLO → "Holo Rare"). */
const LEGACY_DISPLAY_OVERRIDES: Record<string, string> = {
  RARE_HOLO: "Holo Rare",
  GALAR_GALLERY: "Galarian Gallery",
  PROMO_RARITY: "Promo",
};

function legacyDisplayLabel(code: string): string {
  const key = code.trim().toUpperCase();
  if (LEGACY_DISPLAY_OVERRIDES[key]) return LEGACY_DISPLAY_OVERRIDES[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ");
}

/** Catalogue label → clean public label: apply the override, else strip any
 *  trailing "(…)" qualifier the catalogue uses for disambiguation. */
function publicLabel(code: string | null | undefined, catalogueLabel: string | undefined): string {
  if (!code) return "";
  if (PUBLIC_LABEL_OVERRIDES[code]) return PUBLIC_LABEL_OVERRIDES[code];
  if (catalogueLabel) return catalogueLabel.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // The code is SET but this process cannot resolve it. That happens for a code
  // added through the Catalogue Manager (validated against the LIVE catalogue_items
  // table) while this pure formatter only ever resolves against SEED_CATALOGUE.
  // Returning "" would silently print an EMPTY variant line for a rarity/finish
  // the grader explicitly selected — worse than imperfect wording. Humanise the
  // code instead so the line is never blank and still reads correctly
  // ("tera_hyper_rare" → "Tera Hyper Rare").
  return legacyDisplayLabel(code);
}

/** True if any structured classification column is set (rarity/finish/promo/subset). */
export function hasStructuredVariant(input: VariantLineInput): boolean {
  return !!(input.rarityCode || input.finishVariant || input.promoType || input.subsetName);
}

/**
 * Legacy free-text wording that will STOP being printed when this save converts a
 * certificate to the consolidated scheme.
 *
 * Converting is a one-way boundary for the LABEL (never for the data — the legacy
 * columns are always kept): from version 2 on, only the explicit structured
 * selections print. An operator-typed value such as "Prism Foil" cannot be
 * reproduced by any catalogue code, so the UI must warn once, at the conversion
 * itself, before that wording disappears from the label.
 *
 * Returns the wordings that will no longer print — empty when there is nothing to
 * warn about. Deliberately empty when:
 *   - the certificate is ALREADY consolidated (warn once, at the boundary only);
 *   - this save will not consolidate it (nothing changes);
 *   - there is no legacy free text;
 *   - the wording is still represented in the resulting structured line.
 */
export function legacyFreeTextLostOnConversion(input: {
  /** The certificate's CURRENT (pre-save) scheme version. */
  currentVersion?: number | null;
  /** Legacy free-text columns as they will be saved. */
  variantOther?: string | null;
  rarityOther?: string | null;
  /** The structured selection this save will persist. */
  rarityCode?: string | null;
  finishVariant?: string | null;
  promoType?: string | null;
  subsetName?: string | null;
}): string[] {
  const alreadyConsolidated = Number(input.currentVersion ?? 0) >= CONSOLIDATED_VARIANT_SCHEME;
  if (alreadyConsolidated) return [];
  const willConsolidate = hasStructuredVariant(input);
  if (!willConsolidate) return [];

  const resultingLine = formatVariantLine({
    rarityCode: input.rarityCode,
    finishVariant: input.finishVariant,
    promoType: input.promoType,
    subsetName: input.subsetName,
    structuredVariantVersion: CONSOLIDATED_VARIANT_SCHEME,
  }).toLowerCase();

  const candidates = [input.variantOther, input.rarityOther]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);

  // "Represented" = the wording already appears in the line the label will print.
  return candidates.filter((v) => !resultingLine.includes(v.toLowerCase()));
}

/**
 * Build the consolidated public Variant line. Returns "" when nothing is set.
 * Structured columns win; a legacy `variant`/`rarity` value is folded into any
 * still-empty slot — and is NEVER dropped: a legacy code that has no clean,
 * unambiguous structured equivalent (e.g. the ordinary rarities RARE/RARE_HOLO,
 * or a free-text "OTHER") is preserved via its own display wording.
 */
export function formatVariantLine(input: VariantLineInput): string {
  let rarityCode = input.rarityCode || "";
  let finishCode = input.finishVariant || "";
  let promoCode = input.promoType || "";
  let subsetCode = input.subsetName || "";
  // Display-label fallbacks for legacy values that don't map cleanly to a
  // structured code, so the legacy wording is preserved rather than erased.
  let rarityLegacyFallback = "";
  let finishLegacyFallback = "";

  const foldLegacy = (code: string | null | undefined, otherText: string | null | undefined, nativeSlot: "rarity" | "finish") => {
    if (!code || code === "NONE") return;
    // Free-text OTHER carries its own wording — preserve it verbatim.
    if (code === "OTHER") {
      const text = (otherText || "").trim();
      if (!text) return;
      if (nativeSlot === "rarity" && !rarityCode && !rarityLegacyFallback) rarityLegacyFallback = text;
      else if (nativeSlot === "finish" && !finishCode && !finishLegacyFallback) finishLegacyFallback = text;
      return;
    }
    const mapped = mapLegacyVariant(code);
    // Only a CLEAN, unambiguous mapping folds into a structured slot; an
    // ambiguous remap (e.g. SECRET_RARE→jp_super_rare) would silently change the
    // printed wording, so those preserve the legacy display instead.
    if (mapped.value && !mapped.ambiguous) {
      if (mapped.classification === "finish" && !finishCode) return void (finishCode = mapped.value);
      if (mapped.classification === "rarity" && !rarityCode) return void (rarityCode = mapped.value);
      if (mapped.classification === "promo" && !promoCode) return void (promoCode = mapped.value);
      if (mapped.classification === "subset" && !subsetCode) return void (subsetCode = mapped.value);
      return; // matching slot already filled by a structured value — no duplication
    }
    // Unmappable or ambiguous → keep the legacy value's own display wording.
    const display = legacyDisplayLabel(code);
    if (nativeSlot === "rarity" && !rarityCode && !rarityLegacyFallback) rarityLegacyFallback = display;
    else if (nativeSlot === "finish" && !finishCode && !finishLegacyFallback) finishLegacyFallback = display;
  };
  // Consolidated-scheme certificates are structured-ONLY: a cleared rarity or
  // finish must print as nothing, so a legacy leftover can never reappear on the
  // label. (Before this, clearing the structured rarity/finish on a v2 cert
  // still printed the legacy `rarity`/`variant` values — e.g. promo-only came
  // out as "BASIC POKÉMON · MCDONALD'S PROMO · HOLO".) Pre-consolidation certs
  // keep the legacy fold, so their wording is unchanged until they are edited.
  const consolidated = Number(input.structuredVariantVersion ?? 0) >= CONSOLIDATED_VARIANT_SCHEME;
  if (!consolidated) {
    foldLegacy(input.variant, input.variantOther, "finish");
    foldLegacy(input.rarity, input.rarityOther, "rarity");
  }

  const rarity = rarityCode ? publicLabel(rarityCode, rarityByValue(rarityCode)?.label) : rarityLegacyFallback;
  const promo = promoCode ? publicLabel(promoCode, promoByValue(promoCode)?.label) : "";
  const subset = subsetCode ? publicLabel(subsetCode, promoByValue(subsetCode)?.label) : "";
  const finish = finishCode ? publicLabel(finishCode, finishByValue(finishCode)?.label) : finishLegacyFallback;

  // Fixed order; skip empties so there is never a dangling separator.
  return [rarity, promo, subset, finish].filter((p) => p && p.length > 0).join(" · ");
}
