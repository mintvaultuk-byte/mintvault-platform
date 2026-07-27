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
  /** Live-row state. Absent is treated as LIVE, which matches the column
   *  defaults (active TRUE, archived FALSE) and keeps older callers working. */
  active?: boolean;
  archived?: boolean;
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * M-2 — ARCHIVED CATALOGUE CODE POLICY (single coherent rule, matched by the
 * database constraint in migrations/0026_catalogue_abbreviation_unique.sql):
 *
 *   • Persisted-code uniqueness applies to LIVE rows only (active AND not archived).
 *   • An archived/inactive historical row KEEPS its old code — it is never
 *     rewritten, so certificates that stored that code stay readable.
 *   • A new ACTIVE replacement may therefore reuse a retired code.
 *   • Reactivating an archived row whose code is now taken by a live row FAILS
 *     with a clear message (see `catalogueConflict`).
 */
export function isLiveCatalogueRow(r: { active?: boolean; archived?: boolean }): boolean {
  return (r.active ?? true) && !(r.archived ?? false);
}

/**
 * M-3 — SHARED PERSISTED-CODE NAMESPACES.
 *
 * `designation` and `attribute` rows BOTH persist into the same
 * `certificates.designations` array, so a code from either category lands in one
 * undifferentiated list. Two live rows across those categories must therefore
 * not produce the same effective code, or a stored value becomes ambiguous.
 * Every other category is its own namespace.
 */
export const SHARED_CODE_NAMESPACES: readonly (readonly string[])[] = [["designation", "attribute"]];

export function codeNamespaceFor(category: string): readonly string[] {
  return SHARED_CODE_NAMESPACES.find((g) => g.includes(category)) ?? [category];
}

/**
 * HIGH-2 (final hostile review) — WHICH CATEGORIES PERSIST `abbreviation`?
 *
 * Only `designation` and `attribute`. Both are mapped by `mapDesignationRow`
 * (shared/catalogue-snapshot.ts), whose `code` is `abbreviation || value`, and
 * both write that code into `certificates.designations`.
 *
 * Every other category persists its `value` and nothing else:
 *
 *   category     mapper             persisted identity        abbreviation is…
 *   ──────────   ────────────────   ───────────────────────   ────────────────────
 *   rarity       mapRarityRow       `value` (rarityCode)      display glyph + alias
 *   finish       mapFinishRow       `value`                   unused
 *   promo        mapPromoRow        `value`                   unused
 *   subset       mapPromoRow        `value`                   unused
 *   language     mapLanguageRow     `value`                   unused
 *   era          inline {value,label} `value`                 unused
 *   designation  mapDesignationRow  `abbreviation || value`   THE PERSISTED CODE
 *   attribute    mapDesignationRow  `abbreviation || value`   THE PERSISTED CODE
 *
 * Applying the abbreviation-based rule to `rarity` was wrong and actively
 * harmful: EN/JP rarity pairs legitimately share a printed abbreviation
 * (hyper_rare/jp_hyper_rare both show "HR", rare/rare_holo both show "R"), so
 * the rule rejected valid rows and blocked migration 0026 against real data.
 * For those categories the existing per-category `value` uniqueness rule above
 * is already the correct and sufficient guard.
 *
 * This list MUST stay identical to the category filter in
 * migrations/0026_catalogue_abbreviation_unique.sql.
 */
export const ABBREVIATION_PERSISTING_CATEGORIES: readonly string[] = ["designation", "attribute"];

export function persistsAbbreviationAsCode(category: string): boolean {
  return ABBREVIATION_PERSISTING_CATEGORIES.includes(category);
}

/**
 * Characters permitted in a PERSISTED catalogue code (`value` / `abbreviation`).
 * Deliberately NOT applied to `label` or `description` — human-readable text may
 * contain spaces, punctuation and accents. Codes are what get written onto a
 * certificate and compared, so they stay to a conservative set.
 */
export const CATALOGUE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function invalidCatalogueCode(
  field: "value" | "abbreviation",
  raw: string | null | undefined,
): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null; // empty abbreviation is legitimate; empty value is caught elsewhere
  if (v.length > 64) return `${field} "${v}" is too long — persisted codes are limited to 64 characters.`;
  if (!CATALOGUE_CODE_PATTERN.test(v)) {
    return `${field} "${v}" is not a valid persisted code — use letters, digits, hyphen or underscore, starting with a letter or digit. (Labels and descriptions are unrestricted.)`;
  }
  return null;
}

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

  // Persisted-code validity (low-risk fix 3) — codes only, never labels.
  const badValue = invalidCatalogueCode("value", candidate.value);
  if (badValue) return badValue;
  const badAbbr = invalidCatalogueCode("abbreviation", candidate.abbreviation);
  if (badAbbr) return badAbbr;

  // ── PERSISTED-CODE uniqueness ─────────────────────────────────────────────
  // Designations persist `abbreviation || value` onto the certificate. Checking
  // abbreviation-against-abbreviation is not enough: one row's ABBREVIATION can
  // collide with another row's VALUE and both would write the same code, so a
  // stored certificate value would resolve ambiguously.
  //
  // M-2: scoped to LIVE rows, so a retired code can be reused by a replacement.
  // M-3: scoped to the shared NAMESPACE, so designation and attribute — which
  //      both land in certificates.designations — cannot collide either.
  // HIGH-2: scoped to the categories that ACTUALLY persist `abbreviation ||
  //      value`. Categories keyed by `value` (rarity, finish, promo, subset,
  //      language, era) are covered by the per-category value rule above; their
  //      `abbreviation` is a display glyph, so shared abbreviations across
  //      language/region rows are legitimate and must not be rejected.
  const candidateCode = effectiveCatalogueCode(candidate);
  if (candidateCode && isLiveCatalogueRow(candidate) && persistsAbbreviationAsCode(candidate.category)) {
    const namespace = codeNamespaceFor(candidate.category);
    const codeClash = existing.find(
      (r) =>
        r.id !== excludeId &&
        isLiveCatalogueRow(r) &&
        namespace.includes(r.category) &&
        effectiveCatalogueCode(r) === candidateCode,
    );
    if (codeClash) {
      const crossCategory = codeClash.category !== candidate.category;
      // A REACTIVATION is specifically: this row exists, was NOT live, and this
      // change would make it live. Derived from the row's own prior state, never
      // from "it has an id" — an unsaved candidate carries an id too.
      const priorSelf = excludeId !== undefined ? existing.find((r) => r.id === excludeId) : undefined;
      const reactivating = !!priorSelf && !isLiveCatalogueRow(priorSelf) && isLiveCatalogueRow(candidate);
      const where = crossCategory
        ? `by the live ${codeClash.category} entry "${codeClash.abbreviation || codeClash.value}" — ${candidate.category} and ${codeClash.category} share one persisted-code namespace because both write into the certificate's designations`
        : `by the live ${codeClash.category} entry "${codeClash.abbreviation || codeClash.value}"`;
      return reactivating
        ? `Cannot make "${candidate.abbreviation || candidate.value}" live: its persisted code "${candidateCode}" is already used ${where}. Retire or rename that entry first.`
        : `"${candidate.abbreviation || candidate.value}" would persist the code "${candidateCode}", already used ${where}. Each live entry must produce a unique stored code.`;
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
