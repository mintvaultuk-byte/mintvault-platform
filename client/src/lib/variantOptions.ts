export type VariantOption = {
  code: string;
  label: string;
  /** Short TCG abbreviation shown in the grader dropdown, e.g. "RR", "IR", "SAR".
   *  Display-only — the saved value is still `label`. Omitted where there is no
   *  standard abbreviation (those entries show the plain label). */
  abbreviation?: string;
};

export const VARIANT_OPTIONS: VariantOption[] = [
  { code: "NONE", label: "None / Regular" },
  { code: "HOLO", label: "Holo", abbreviation: "HOLO" },
  { code: "REVERSE_HOLO", label: "Reverse Holo" },
  { code: "COSMOS_HOLO", label: "Cosmos Holo" },
  { code: "CRACKED_ICE_HOLO", label: "Cracked Ice Holo" },
  { code: "MIRROR_HOLO", label: "Mirror Holo" },
  { code: "GLITTER_HOLO", label: "Glitter Holo" },
  { code: "PATTERN_HOLO", label: "Pattern Holo" },
  { code: "TEXTURED", label: "Textured" },
  { code: "FULL_ART", label: "Full Art" },
  { code: "ALT_ART", label: "Alt Art" },
  { code: "SPECIAL_ART", label: "Special Art" },
  { code: "RAINBOW", label: "Rainbow" },
  { code: "GOLD", label: "Gold" },
  { code: "SHINY", label: "Shiny" },
  { code: "RADIANT", label: "Radiant" },
  { code: "TRAINER_GALLERY", label: "Trainer Gallery" },
  { code: "GALARIAN_GALLERY", label: "Galarian Gallery" },
  { code: "CHARACTER_RARE", label: "Character Rare (CHR)" },
  { code: "CHARACTER_SUPER_RARE", label: "Character Super Rare (CSR)" },
  { code: "SECRET_RARE", label: "Secret Rare" },
  { code: "ILLUSTRATION_RARE", label: "Illustration Rare", abbreviation: "IR" },
  { code: "SPECIAL_ILLUSTRATION_RARE", label: "Special Illustration Rare", abbreviation: "SAR" },
  { code: "DOUBLE_RARE", label: "Double Rare", abbreviation: "RR" },
  { code: "ULTRA_RARE", label: "Ultra Rare", abbreviation: "UR" },
  { code: "HYPER_RARE", label: "Hyper Rare", abbreviation: "HR" },
  { code: "AMAZING_RARE", label: "Amazing Rare", abbreviation: "AR" },
  { code: "ACE_SPEC_RARE", label: "ACE SPEC Rare", abbreviation: "ACE" },
  { code: "EX", label: "Ex", abbreviation: "ex" },
  { code: "PROMO", label: "Promo" },
  { code: "FIRST_EDITION", label: "1st Edition" },
  { code: "SHADOWLESS", label: "Shadowless" },
  { code: "UNLIMITED", label: "Unlimited" },
  { code: "OTHER", label: "Other (manual)" },
];

export function getVariantLabel(code: string | null | undefined): string {
  if (!code) return "";
  const opt = VARIANT_OPTIONS.find((v) => v.code === code);
  return opt?.label || code;
}

export function getVariantDisplayLabel(
  code: string | null | undefined,
  variantOther: string | null | undefined
): string {
  if (!code || code === "NONE") return "";
  if (code === "OTHER") return variantOther || "Other";
  return getVariantLabel(code);
}

// mapVariantTextToCode now lives in @shared/variant-derive so the browser and
// the server derive variants identically. Re-exported here so existing
// `@/lib/variantOptions` importers keep working unchanged.
export { mapVariantTextToCode } from "@shared/variant-derive";
