/**
 * Partner Portal — supported card categories/games. Single source of truth so the list is defined
 * once, not duplicated across the wizard, filters, and any future admin screen. Purely a display/
 * form-option list — has no bearing on grading logic, which is untouched by the Partner Network.
 */
export const PARTNER_CARD_CATEGORIES = [
  { value: "pokemon", label: "Pokémon" },
  { value: "yugioh", label: "Yu-Gi-Oh!" },
  { value: "mtg", label: "Magic: The Gathering" },
  { value: "onepiece", label: "One Piece" },
  { value: "dragonball", label: "Dragon Ball" },
  { value: "lorcana", label: "Lorcana" },
  { value: "sports", label: "Sports cards" },
  { value: "other", label: "Other" },
] as const;

export type PartnerCardCategory = (typeof PARTNER_CARD_CATEGORIES)[number]["value"];
