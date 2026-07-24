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
}

/** Public-facing wording overrides where the catalogue's descriptive label is
 *  not the customer-facing variant wording (e.g. the classic single-star rare
 *  prints as "Holo Rare", not the catalogue's "Rare Holo (classic)"). */
const PUBLIC_LABEL_OVERRIDES: Record<string, string> = {
  rare_holo: "Holo Rare",
};

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
 * Structured columns win; a legacy `variant`/`rarity` code is mapped into the
 * matching slot only when that slot is still empty (so legacy values survive).
 */
export function formatVariantLine(input: VariantLineInput): string {
  let rarityCode = input.rarityCode || "";
  let finishCode = input.finishVariant || "";
  let promoCode = input.promoType || "";
  let subsetCode = input.subsetName || "";

  // Fold legacy variant/rarity codes into any still-empty slot — never erase a
  // value a card only ever carried in the legacy columns.
  for (const legacy of [input.variant, input.rarity]) {
    if (!legacy || legacy === "OTHER" || legacy === "NONE") continue;
    const mapped = mapLegacyVariant(legacy);
    if (!mapped.value) continue;
    if (mapped.classification === "finish" && !finishCode) finishCode = mapped.value;
    else if (mapped.classification === "rarity" && !rarityCode) rarityCode = mapped.value;
    else if (mapped.classification === "promo" && !promoCode) promoCode = mapped.value;
    else if (mapped.classification === "subset" && !subsetCode) subsetCode = mapped.value;
  }

  const rarity = rarityCode ? publicLabel(rarityCode, rarityByValue(rarityCode)?.label) : "";
  const promo = promoCode ? publicLabel(promoCode, promoByValue(promoCode)?.label) : "";
  const subset = subsetCode ? publicLabel(subsetCode, promoByValue(subsetCode)?.label) : "";
  const finish = finishCode ? publicLabel(finishCode, finishByValue(finishCode)?.label) : "";

  // Fixed order; skip empties so there is never a dangling separator.
  return [rarity, promo, subset, finish].filter((p) => p && p.length > 0).join(" · ");
}
