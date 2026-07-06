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

// ── Set-name / designation split (owner ruling 2026-07-06: option B) ──
//
// Official TCG set names often carry a subset/promo designation ("Brilliant
// Stars Trainer Gallery", "SWSH Black Star Promos"). On the slab label the
// owner wants the BASE set on the set line and the designation on the variant
// line — never both crammed into the set line. This is the single shared rule
// for that split, used by the server identify write, the form fill paths, and
// the one-off data repair script.

/** Trailing designation phrases → variant code. Longest-match wins. Order
 *  matters only for documentation; matching strips from the END of the name,
 *  optionally preceded by a separator (space, "-", "–", ":"). */
const SET_DESIGNATIONS: ReadonlyArray<{ phrase: string; code: string }> = [
  { phrase: "trainer gallery", code: "TRAINER_GALLERY" },
  { phrase: "galarian gallery", code: "GALARIAN_GALLERY" },
  { phrase: "black star promos", code: "PROMO" },
  { phrase: "black star promo", code: "PROMO" },
];

/** Bare base-set abbreviations left behind after a split, expanded so the
 *  label never reads just "2023 SWSH". Only applied to an EXACT bare match. */
const SET_BASE_EXPANSIONS: Record<string, string> = {
  swsh: "Sword & Shield",
  sm: "Sun & Moon",
};

export interface SetDesignationSplit {
  /** Set name with any trailing designation removed (original when no match). */
  baseSet: string;
  /** Variant code for the stripped designation, or null when none matched. */
  designation: string | null;
}

/** Split a set name into base set + designation variant code. Case-insensitive,
 *  whitespace-tolerant; returns the input unchanged (designation: null) when no
 *  known designation ends the name, or when stripping would leave nothing. */
export function splitSetDesignation(rawSetName: string | null | undefined): SetDesignationSplit {
  const setName = typeof rawSetName === "string" ? rawSetName.trim() : "";
  if (!setName) return { baseSet: setName, designation: null };
  const lower = setName.toLowerCase();
  for (const { phrase, code } of SET_DESIGNATIONS) {
    if (!lower.endsWith(phrase)) continue;
    // Whole-phrase only: the char before the phrase must be a separator, never
    // a letter/digit ("Retrainer Gallery" must NOT split as "Re" + TG).
    const boundary = setName.length - phrase.length;
    if (boundary > 0 && /[\p{L}\p{N}]/u.test(setName[boundary - 1])) continue;
    // Strip the phrase plus any trailing separator left behind ("- ", ": ", "– ").
    const base = setName
      .slice(0, boundary)
      .replace(/[\s\-–—−:]+$/, "")
      .trim();
    if (!base) return { baseSet: setName, designation: code };
    const expanded = SET_BASE_EXPANSIONS[base.toLowerCase()] || base;
    return { baseSet: expanded, designation: code };
  }
  return { baseSet: setName, designation: null };
}
