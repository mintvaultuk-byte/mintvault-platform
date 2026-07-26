/**
 * Pure catalogue validation + matching helpers (no DB, no I/O) so the rules can
 * be unit-tested and shared. The service (server/services/catalogueService.ts)
 * fetches the rows and delegates the decision to these functions.
 */
export interface CatalogueEntryLike {
  id?: number;
  category: string;
  value: string;
  label?: string;
  abbreviation?: string | null;
  aliases?: string[] | null;
  description?: string | null;
  allowCrossCategory?: boolean;
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Returns a plain-English conflict message, or null when the candidate is valid:
 *  - duplicate value within the same category
 *  - duplicate abbreviation within the same category
 *  - the same value already classified in a DIFFERENT category (one-category-only)
 *    unless BOTH entries opt into allowCrossCategory.
 */
/**
 * The code a catalogue row PERSISTS onto a certificate: `abbreviation || value`.
 * This is the single definition shared by the snapshot mapper, the validator and
 * the database constraint, so the three can never drift apart.
 */
export function effectiveCatalogueCode(row: { value?: string | null; abbreviation?: string | null }): string {
  const abbr = (row.abbreviation ?? "").trim();
  return (abbr || (row.value ?? "").trim()).toLowerCase();
}

export function catalogueConflict(
  existing: CatalogueEntryLike[],
  candidate: CatalogueEntryLike,
  excludeId?: number,
): string | null {
  const v = norm(candidate.value);

  if (existing.some((r) => r.id !== excludeId && r.category === candidate.category && norm(r.value) === v)) {
    return `"${candidate.value}" already exists in ${candidate.category}.`;
  }

  const abbr = norm(candidate.abbreviation);
  if (
    abbr &&
    existing.some((r) => r.id !== excludeId && r.category === candidate.category && norm(r.abbreviation) === abbr)
  ) {
    return `Abbreviation "${candidate.abbreviation}" is already used in ${candidate.category}.`;
  }

  // ── PERSISTED-CODE uniqueness (hostile-review MEDIUM) ─────────────────────
  // Designations persist `abbreviation || value` onto the certificate. Checking
  // abbreviation-against-abbreviation is therefore not enough: one row's
  // ABBREVIATION can collide with another row's VALUE and both would write the
  // same code, so a stored certificate value would resolve ambiguously. Compare
  // the EFFECTIVE code both ways.
  const candidateCode = effectiveCatalogueCode(candidate);
  if (candidateCode) {
    const codeClash = existing.find(
      (r) =>
        r.id !== excludeId &&
        r.category === candidate.category &&
        effectiveCatalogueCode(r) === candidateCode,
    );
    if (codeClash) {
      return `"${candidate.abbreviation || candidate.value}" would persist the same code as "${
        codeClash.abbreviation || codeClash.value
      }" in ${candidate.category}. Each entry must produce a unique stored code.`;
    }
  }

  // One-classification-only: a value may live in two categories ONLY when BOTH
  // the candidate and the existing entry opt into allowCrossCategory (symmetric —
  // flagging just one side does not override the rule).
  const clash = existing.find(
    (r) =>
      r.id !== excludeId &&
      r.category !== candidate.category &&
      norm(r.value) === v &&
      !(candidate.allowCrossCategory && r.allowCrossCategory),
  );
  if (clash) {
    return `"${candidate.value}" already exists as a ${clash.category}. A value belongs to one category only — enable "allow cross-category" on BOTH entries to override.`;
  }

  return null;
}

/** Case-insensitive match across label / value / abbreviation / aliases / description. */
export function catalogueSearchMatch(item: CatalogueEntryLike, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  const hay = [item.label, item.value, item.abbreviation ?? "", item.description ?? "", ...(item.aliases ?? [])]
    .map(norm)
    .join(" ");
  return hay.includes(q);
}

/** Accept either a full export ({ items: [...] }) or a bare array; else null. */
export function parseImportItems(payload: unknown): CatalogueEntryLike[] | null {
  if (payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)) {
    return (payload as { items: CatalogueEntryLike[] }).items;
  }
  if (Array.isArray(payload)) return payload as CatalogueEntryLike[];
  return null;
}
