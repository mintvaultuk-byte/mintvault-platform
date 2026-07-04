/**
 * variant-derive.ts — SINGLE source of truth for turning an AI identification
 * result into a MintVault variant/finish code. Imported by BOTH the browser
 * (certificate-form, variantOptions re-export) and the server (the AI
 * identify-and-analyze route), so the value the form shows and the value the
 * database stores are derived by identical logic — never two copies that drift.
 *
 * Variant (finish: Holo / Full Art / …) and Rarity (scarcity: Rare / Ultra Rare
 * / …) are MUTUALLY EXCLUSIVE per card by owner convention — the front-label
 * line 3 shows exactly one of them. Callers use the return here to decide which
 * of the two to write (a non-empty variant wins line 3; otherwise rarity).
 */

/** Map a free-text finish/variant string (e.g. "Full Art", "Reverse Holo") to a
 *  VARIANT_OPTIONS code. Returns "" for empty input, "OTHER" for an unrecognised
 *  non-empty string. Match is case-insensitive and trimmed. */
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

/** The finish signals an AI identification can carry. All optional — different
 *  callers (form external-id, /identify enrichedId) populate different subsets. */
export interface VariantIdentificationInput {
  card_type?: unknown;
  is_reverse_holo?: unknown;
  is_full_art?: unknown;
  is_textured?: unknown;
  is_holo?: unknown;
  is_foil?: unknown;
}

/** Variant / finish code from an AI identification result. Prefer a clean
    card_type match (e.g. "Full Art", "Secret Rare"); otherwise fall back to the
    deterministic finish booleans. card_type is often the same free-text as the
    rarity ("Holo Rare"), which doesn't exact-map, so the boolean fallback is
    what fills the common holo / reverse-holo / full-art / textured cases.
    Returns "" when the AI gave no usable finish signal. */
export function deriveVariantFromIdentification(id: VariantIdentificationInput | null | undefined): string {
  const cardType = typeof id?.card_type === "string" ? id.card_type : "";
  const mappedType = mapVariantTextToCode(cardType);
  if (mappedType && mappedType !== "OTHER") return mappedType;
  if (id?.is_reverse_holo) return "REVERSE_HOLO";
  if (id?.is_full_art) return "FULL_ART";
  if (id?.is_textured) return "TEXTURED";
  if (id?.is_holo || id?.is_foil) return "HOLO";
  return "";
}
