export type CollectionOption = {
  code: string;
  label: string;
};

export const COLLECTION_OPTIONS: CollectionOption[] = [
  { code: "CLASSIC_COLLECTION", label: "Classic Collection" },
  { code: "COLLECTION_GENERIC", label: "Collection (generic)" },
  { code: "BLACK_STAR_PROMO", label: "Black Star Promo" },
  { code: "PROMO_GENERIC", label: "Promo (generic)" },
  { code: "FIRST_EDITION", label: "1st Edition" },
  { code: "UNLIMITED", label: "Unlimited" },
  { code: "SHADOWLESS", label: "Shadowless" },
  { code: "FOURTH_PRINT", label: "4th Print" },
  { code: "NO_RARITY_SYMBOL", label: "No Rarity Symbol" },
  { code: "ERROR_MISPRINT", label: "Error / Misprint" },
  { code: "TROPHY_PRIZE", label: "Trophy / Prize" },
  { code: "TRAINER_GALLERY", label: "Trainer Gallery (TG)" },
  { code: "GALARIAN_GALLERY", label: "Galarian Gallery (GG)" },
  { code: "RADIANT_COLLECTION", label: "Radiant Collection (RC)" },
  { code: "SHINY_VAULT", label: "Shiny Vault (SV)" },
  { code: "ILLUSTRATION_RARE", label: "Illustration Rare (IR)" },
  { code: "SPECIAL_ILLUSTRATION_RARE", label: "Special Illustration Rare (SIR)" },
  { code: "CHARACTER_RARE", label: "Character Rare (CHR)" },
  { code: "CHARACTER_SUPER_RARE", label: "Character Super Rare (CSR)" },
  { code: "PRISM_STAR", label: "Prism Star" },
  { code: "AMAZING_RARE", label: "Amazing Rare" },
  { code: "SECRET_RARE", label: "Secret Rare" },
  { code: "OTHER", label: "Other (manual)" },
];

export const COLLECTION_LABELS: Record<string, string> = {};
COLLECTION_OPTIONS.forEach((o) => { COLLECTION_LABELS[o.code] = o.label; });

export function getCollectionLabel(code: string | null | undefined): string {
  if (!code) return "";
  return COLLECTION_LABELS[code] || code;
}

export function getCollectionDisplayLabel(
  code: string | null | undefined,
  other: string | null | undefined
): string {
  if (!code) return "";
  if (code === "OTHER") return other?.trim() || "Other";
  return COLLECTION_LABELS[code] || code;
}
