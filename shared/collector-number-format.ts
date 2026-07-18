/**
 * DISPLAY-only formatting for a printed collector number ("TG12/TG30",
 * "SV114/SV122", "037/091"…). Pure + dependency-free so both client and server
 * can present the same normalised form.
 *
 * This is presentation only — it never changes what is stored, never strips a
 * TG/SV/GG/RC/promo prefix, and never fabricates a "/total" that wasn't
 * supplied (see server/services/collector-number.ts for the separate
 * accepted-format validation + local/total PARSING used by the TCGdex lookup).
 */

/** Uppercase the collector number and strip incidental whitespace (fixes
 *  "#tg12" / "# tg12" style inconsistencies) without touching digits, slashes,
 *  dashes or the prefix itself. Returns "" for empty/null/undefined input. */
export function formatCollectorNumber(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return s.toUpperCase().replace(/\s+/g, "");
}

/** `formatCollectorNumber` with a leading "#" and NO space after it — the
 *  exact display form used throughout the grading admin. Returns "" (not "#")
 *  for empty input so callers can `.filter(Boolean)` it out of a chip list. */
export function displayCollectorNumber(raw: string | null | undefined): string {
  const formatted = formatCollectorNumber(raw);
  return formatted ? `#${formatted}` : "";
}
