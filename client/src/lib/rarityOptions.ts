export type RarityOption = {
  code: string;
  label: string;
  help: string;
};

export const RARITY_OPTIONS: RarityOption[] = [
  { code: "COMMON", label: "Common", help: "Standard common card." },
  { code: "UNCOMMON", label: "Uncommon", help: "Standard uncommon card." },
  { code: "RARE", label: "Rare", help: "Standard rare (non-holo)." },
  { code: "HOLO", label: "Holo", help: "Standard holographic finish." },
  { code: "RARE_HOLO", label: "Holo Rare", help: "Foil artwork / holo rare." },
  { code: "REVERSE_HOLO", label: "Reverse Holo", help: "Foil on card body, not the artwork (set-dependent)." },

  { code: "DOUBLE_RARE", label: "Double Rare (ex/V)", help: "Main ultra-playable chase tier (varies by era: V/ex)." },
  { code: "ULTRA_RARE", label: "Ultra Rare (Full Art)", help: "Full art Pokémon/Trainer; higher tier than Double Rare." },
  { code: "ILLUSTRATION_RARE", label: "Illustration Rare (IR)", help: "Art-focused rare (SV era)." },
  { code: "SPECIAL_ILLUSTRATION_RARE", label: "Special Illustration Rare (SIR)", help: "Top art chase tier (SV era)." },
  { code: "HYPER_RARE", label: "Hyper Rare (Gold)", help: "Gold card tier (SV/SwSh)." },
  { code: "SECRET_RARE", label: "Secret Rare", help: "Numbered beyond set total / special chase print." },

  { code: "SHINY_RARE", label: "Shiny Rare", help: "Shiny Pokémon (subset-dependent)." },
  { code: "SHINY_ULTRA_RARE", label: "Shiny Ultra Rare", help: "Higher shiny tier (full art / special shiny)." },

  { code: "RADIANT", label: "Radiant", help: "Radiant Pokémon (special foil style)." },
  { code: "AMAZING_RARE", label: "Amazing Rare", help: "Amazing Rare (Vivid Voltage era)." },
  { code: "ACE_SPEC", label: "ACE SPEC", help: "ACE SPEC special card type." },

  { code: "TRAINER_GALLERY", label: "Trainer Gallery (TG)", help: "TG subset card (SwSh)." },
  { code: "GALAR_GALLERY", label: "Galarian Gallery (GG)", help: "GG subset card (Crown Zenith)." },

  { code: "GOLD_STAR", label: "★ Gold Star", help: "EX-era Gold Star chase card." },
  { code: "DOUBLE_GOLD_STAR", label: "★★ Double Gold Star", help: "Double star rarity tier (used in some Japanese sets/labels)." },

  { code: "PROMO_RARITY", label: "Promo (Rarity Unknown)", help: "Use only if the set rarity is unclear; mark Promo in Designations." },

  { code: "OTHER", label: "Other (manual)", help: "Use only when you cannot confidently classify the rarity. Enter custom rarity text." },
];

export function mapRarityTextToCode(text: string): { rarityCode: string; isPromo: boolean } {
  if (!text) return { rarityCode: "", isPromo: false };
  const t = text.toLowerCase();
  const isPromo = t.includes("promo");

  if (t.includes("special illustration")) return { rarityCode: "SPECIAL_ILLUSTRATION_RARE", isPromo };
  if (t.includes("illustration")) return { rarityCode: "ILLUSTRATION_RARE", isPromo };
  if (t.includes("hyper") || (t.includes("gold") && !t.includes("star"))) return { rarityCode: "HYPER_RARE", isPromo };
  if (t.includes("secret")) return { rarityCode: "SECRET_RARE", isPromo };
  if (t.includes("shiny ultra")) return { rarityCode: "SHINY_ULTRA_RARE", isPromo };
  if (t.includes("shiny")) return { rarityCode: "SHINY_RARE", isPromo };
  if (t.includes("ultra") || t.includes("full art")) return { rarityCode: "ULTRA_RARE", isPromo };
  if (t.includes("double rare") || t.includes(" ex") || t.includes(" v ") || t === "v") return { rarityCode: "DOUBLE_RARE", isPromo };
  if (t.includes("reverse")) return { rarityCode: "REVERSE_HOLO", isPromo };
  if (t.includes("holo rare") || t.includes("rare holo")) return { rarityCode: "RARE_HOLO", isPromo };
  if (t.includes("holo")) return { rarityCode: "HOLO", isPromo };
  if (t.includes("amazing")) return { rarityCode: "AMAZING_RARE", isPromo };
  if (t.includes("radiant")) return { rarityCode: "RADIANT", isPromo };
  if (t.includes("ace spec")) return { rarityCode: "ACE_SPEC", isPromo };
  if (t.includes("gold star") && t.includes("double")) return { rarityCode: "DOUBLE_GOLD_STAR", isPromo };
  if (t.includes("gold star")) return { rarityCode: "GOLD_STAR", isPromo };
  if (t.includes("trainer gallery")) return { rarityCode: "TRAINER_GALLERY", isPromo };
  if (t.includes("galar")) return { rarityCode: "GALAR_GALLERY", isPromo };
  if (t.includes("uncommon")) return { rarityCode: "UNCOMMON", isPromo };
  if (t.includes("common")) return { rarityCode: "COMMON", isPromo };
  if (t.includes("rare")) return { rarityCode: "RARE", isPromo };
  if (isPromo) return { rarityCode: "PROMO_RARITY", isPromo };
  return { rarityCode: "OTHER", isPromo };
}

export function getRarityLabel(code: string): string {
  const opt = RARITY_OPTIONS.find(r => r.code === code);
  return opt?.label || code;
}
