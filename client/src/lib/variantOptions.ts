export type VariantOption = {
  code: string;
  label: string;
};

export const VARIANT_OPTIONS: VariantOption[] = [
  { code: "NONE", label: "None / Regular" },
  { code: "HOLO", label: "Holo" },
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
  { code: "ILLUSTRATION_RARE", label: "Illustration Rare" },
  { code: "SPECIAL_ILLUSTRATION_RARE", label: "Special Illustration Rare" },
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

export function getVariantDisplayLabel(code: string | null | undefined, variantOther: string | null | undefined): string {
  if (!code || code === "NONE") return "";
  if (code === "OTHER") return variantOther || "Other";
  return getVariantLabel(code);
}

export function mapVariantTextToCode(text: string): string {
  if (!text) return "";
  const t = text.toLowerCase().trim();

  if (t === "none" || t === "regular" || t === "none / regular") return "NONE";
  if (t === "reverse holo") return "REVERSE_HOLO";
  if (t === "cosmos holo") return "COSMOS_HOLO";
  if (t === "cracked ice holo") return "CRACKED_ICE_HOLO";
  if (t === "mirror holo") return "MIRROR_HOLO";
  if (t === "glitter holo") return "GLITTER_HOLO";
  if (t === "pattern holo") return "PATTERN_HOLO";
  if (t === "holo") return "HOLO";
  if (t === "textured") return "TEXTURED";
  if (t === "full art") return "FULL_ART";
  if (t === "alt art" || t === "alternate art") return "ALT_ART";
  if (t === "special art") return "SPECIAL_ART";
  if (t === "rainbow") return "RAINBOW";
  if (t === "gold") return "GOLD";
  if (t === "shiny") return "SHINY";
  if (t === "radiant") return "RADIANT";
  if (t === "trainer gallery") return "TRAINER_GALLERY";
  if (t === "galarian gallery") return "GALARIAN_GALLERY";
  if (t === "character rare" || t === "chr") return "CHARACTER_RARE";
  if (t === "character super rare" || t === "csr") return "CHARACTER_SUPER_RARE";
  if (t === "secret rare") return "SECRET_RARE";
  if (t === "illustration rare") return "ILLUSTRATION_RARE";
  if (t === "special illustration rare" || t === "sir") return "SPECIAL_ILLUSTRATION_RARE";
  if (t === "promo") return "PROMO";
  if (t === "1st edition" || t === "first edition") return "FIRST_EDITION";
  if (t === "shadowless") return "SHADOWLESS";
  if (t === "unlimited") return "UNLIMITED";

  return "OTHER";
}
