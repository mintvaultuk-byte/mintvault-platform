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
  /** Legacy free-form columns, folded in only to fill an EMPTY structured slot. */
  variant?: string | null;
  rarity?: string | null;
  variantOther?: string | null;
  rarityOther?: string | null;
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
  if (!catalogueLabel) return "";
  return catalogueLabel.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** True if any structured classification column is set (rarity/finish/promo/subset). */
export function hasStructuredVariant(input: VariantLineInput): boolean {
  return !!(input.rarityCode || input.finishVariant || input.promoType || input.subsetName);
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
  foldLegacy(input.variant, input.variantOther, "finish");
  foldLegacy(input.rarity, input.rarityOther, "rarity");

  const rarity = rarityCode ? publicLabel(rarityCode, rarityByValue(rarityCode)?.label) : rarityLegacyFallback;
  const promo = promoCode ? publicLabel(promoCode, promoByValue(promoCode)?.label) : "";
  const subset = subsetCode ? publicLabel(subsetCode, promoByValue(subsetCode)?.label) : "";
  const finish = finishCode ? publicLabel(finishCode, finishByValue(finishCode)?.label) : finishLegacyFallback;

  // Fixed order; skip empties so there is never a dangling separator.
  return [rarity, promo, subset, finish].filter((p) => p && p.length > 0).join(" · ");
}
