/**
 * Pure collector-number helpers (no DB / network imports, so they are trivially
 * unit-testable). Pokémon collector numbers are strings that keep their prefixes
 * and may contain letters, slashes and leading zeros — they must NEVER be
 * coerced to a plain integer or have their TG/SV/GG/RC/promo prefix stripped.
 */

/** Accepted printed-number format for the TCGdex lookup/resolve endpoints.
 *  Letters, digits, slash, dash, underscore, up to 16 chars — covers
 *  "TG12/TG30", "SV114/SV122", "GG44/GG70", "RC29/RC32", "SWSH284", "SVP-114",
 *  "001/198". */
export const COLLECTOR_NUMBER_RE = /^[A-Za-z0-9/_-]{1,16}$/;

/** Compare card numbers ignoring leading zeros ("075" === "75"), but keeping any
 *  non-zero prefix intact ("TG12" stays "TG12", "037" → "37"). */
export const stripZeros = (s: string): string =>
  String(s ?? "")
    .trim()
    .replace(/^0+/, "") || "0";

/**
 * Split a printed collector number into its matching key + print total.
 *  "199/197"    → { localKey: "199",  total: 197 }
 *  "4/102"      → { localKey: "4",    total: 102 }
 *  "037/091"    → { localKey: "37",   total: 91 }   (leading zeros ignored for matching)
 *  "TG12/TG30"  → { localKey: "TG12", total: 30 }   (prefix KEPT; total = digits of "TG30")
 *  "SV114/SV122"→ { localKey: "SV114", total: 122 }
 *  "GG44/GG70"  → { localKey: "GG44", total: 70 }
 *  "SV107"      → { localKey: "SV107", total: null }
 */
export function parseCollectorNumber(raw: string): { localKey: string; total: number | null } {
  const [localPart = "", totalPart] = String(raw ?? "")
    .trim()
    .split("/");
  const localKey = stripZeros(localPart);
  const totalDigits = totalPart ? (totalPart.trim().match(/\d+/)?.[0] ?? null) : null;
  return { localKey, total: totalDigits ? parseInt(totalDigits, 10) : null };
}
