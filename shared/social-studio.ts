export const SOCIAL_STUDIO_FORMATS = ["feed", "story", "reel-cover", "weekly-highlights"] as const;
export type SocialStudioFormat = (typeof SOCIAL_STUDIO_FORMATS)[number];

export const SOCIAL_STUDIO_FORMAT_LABELS: Record<SocialStudioFormat, string> = {
  feed: "Feed Post",
  story: "Story",
  "reel-cover": "Reel Cover",
  "weekly-highlights": "Weekly Highlights Pack",
};

export const SOCIAL_STUDIO_FORMAT_DIMENSIONS: Record<SocialStudioFormat, { width: number; height: number }> = {
  feed: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
  "reel-cover": { width: 1080, height: 1920 },
  "weekly-highlights": { width: 1080, height: 1080 },
};

export const SOCIAL_STUDIO_BACKGROUNDS = [
  { id: "auto", label: "Auto", variant: null, category: "Auto" },
  { id: "gold-luxury", label: "Gold Luxury", variant: "vault-gold", category: "Luxury" },
  { id: "black-luxury", label: "Black Luxury", variant: "vault-onyx", category: "Luxury" },
  { id: "electric", label: "Electric", variant: "poke-electric", category: "Elements" },
  { id: "fire", label: "Fire", variant: "poke-fire", category: "Elements" },
  { id: "water", label: "Water", variant: "poke-water", category: "Elements" },
  { id: "grass-nature", label: "Grass / Nature", variant: "poke-grass", category: "Elements" },
  { id: "psychic-galaxy", label: "Psychic / Galaxy", variant: "poke-psychic", category: "Elements" },
  { id: "dark", label: "Dark", variant: "poke-dark", category: "Elements" },
  { id: "dragon", label: "Dragon", variant: "poke-dragon", category: "Elements" },
  { id: "crystal", label: "Crystal", variant: "nature-arctic", category: "Studio" },
  { id: "neutral-studio", label: "Neutral Studio", variant: "vault-platinum", category: "Studio" },
] as const;

export type SocialStudioBackgroundId = (typeof SOCIAL_STUDIO_BACKGROUNDS)[number]["id"];
export type SocialStudioVariantId = Exclude<(typeof SOCIAL_STUDIO_BACKGROUNDS)[number]["variant"], null>;

export interface SocialStudioCardLike {
  certNumber: string;
  cardName?: string | null;
  setName?: string | null;
  cardGame?: string | null;
  grade?: number | null;
}

export function isSocialStudioFormat(value: string): value is SocialStudioFormat {
  return (SOCIAL_STUDIO_FORMATS as readonly string[]).includes(value);
}

export function isSocialStudioBackground(value: string): value is SocialStudioBackgroundId {
  return SOCIAL_STUDIO_BACKGROUNDS.some((bg) => bg.id === value);
}

export function resolveManualBackgroundVariant(backgroundId: SocialStudioBackgroundId): SocialStudioVariantId | null {
  return SOCIAL_STUDIO_BACKGROUNDS.find((bg) => bg.id === backgroundId)?.variant ?? null;
}

export function resolveAutoBackground(card: SocialStudioCardLike): SocialStudioBackgroundId {
  const haystack = [card.cardName, card.setName, card.cardGame].filter(Boolean).join(" ").toLowerCase();

  if (/\b(lightning|electric|pikachu|raichu|zapdos)\b/.test(haystack)) return "electric";
  if (/\b(fire|charizard|charmander|flareon|moltres)\b/.test(haystack)) return "fire";
  if (/\b(water|squirtle|blastoise|vaporeon|gyarados|lapras)\b/.test(haystack)) return "water";
  if (/\b(grass|nature|bulbasaur|venusaur|leafeon|forest)\b/.test(haystack)) return "grass-nature";
  if (/\b(psychic|mewtwo|mew|gengar|galaxy|cosmic)\b/.test(haystack)) return "psychic-galaxy";
  if (/\b(dark|darkness|umbreon|obsidian)\b/.test(haystack)) return "dark";
  if (/\b(dragon|rayquaza|dragonite|salamence)\b/.test(haystack)) return "dragon";
  if (card.grade === 10) return "gold-luxury";
  return "gold-luxury";
}

export function resolveBackgroundVariant(
  backgroundId: SocialStudioBackgroundId,
  card: SocialStudioCardLike
): SocialStudioVariantId {
  const effectiveBackground = backgroundId === "auto" ? resolveAutoBackground(card) : backgroundId;
  return resolveManualBackgroundVariant(effectiveBackground) ?? "vault-gold";
}

export function buildSocialStudioCaption(card: SocialStudioCardLike & { gradeLabel?: string | null }): string {
  const name = card.cardName || "Graded card";
  const setLine = card.setName ? `${card.setName}\n` : "";
  const grade =
    card.grade != null ? `Grade: ${card.grade}${card.gradeLabel ? ` ${card.gradeLabel}` : ""}` : "MintVault graded";
  return [
    `${name}`,
    setLine.trim(),
    grade,
    "Certified by @mintvaultuk.",
    `Verify: mintvaultuk.com/cert/${card.certNumber}`,
    "Which card should we feature next?",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSocialStudioHashtags(card: SocialStudioCardLike): string {
  const tags = ["#MintVault", "#TradingCards", "#CardGrading", "#GradedCards", "#CardCollector"];
  const game = (card.cardGame || "").toLowerCase();
  const text = [card.cardName, card.setName].filter(Boolean).join(" ").toLowerCase();
  if (game.includes("pokemon") || /pokemon|pikachu|charizard|mewtwo/.test(text)) {
    tags.push("#PokemonTCG", "#PokemonCards");
  } else if (game.includes("mtg") || game.includes("magic")) {
    tags.push("#MagicTheGathering", "#MTG");
  } else if (game.includes("yugioh") || game.includes("yu-gi-oh")) {
    tags.push("#YuGiOh");
  }
  return tags.join(" ");
}
