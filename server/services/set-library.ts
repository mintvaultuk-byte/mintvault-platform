import { sql } from "drizzle-orm";
import { db } from "../db";

export const SET_LIBRARY_SOURCES = ["custom", "tcgdex", "card_sets"] as const;
export type SetLibrarySource = (typeof SET_LIBRARY_SOURCES)[number];

export const TCG_BRANDS = ["pokemon", "sports", "one_piece", "yugioh", "magic", "lorcana", "other"] as const;
export type TcgBrand = (typeof TCG_BRANDS)[number];

export const SUBSET_PHRASES = [
  { phrase: "Trainer Gallery", kind: "numbered_subset", suggestedSubset: "Trainer Gallery" },
  { phrase: "Galarian Gallery", kind: "numbered_subset", suggestedSubset: "Galarian Gallery" },
  { phrase: "Shiny Vault", kind: "numbered_subset", suggestedSubset: "Shiny Vault" },
  { phrase: "Promo", kind: "set_or_promo_review", suggestedSubset: "Promo" },
  { phrase: "Reverse Holo", kind: "card_variant", suggestedSubset: "Reverse Holo" },
  { phrase: "First Edition", kind: "card_variant", suggestedSubset: "First Edition" },
  { phrase: "Unlimited", kind: "card_variant", suggestedSubset: "Unlimited" },
  { phrase: "Illustration Rare", kind: "rarity", suggestedSubset: "Illustration Rare" },
  { phrase: "Secret Rare", kind: "rarity", suggestedSubset: "Secret Rare" },
] as const;

const MAX_SCAN_ROWS = 5000;

export interface SetLibraryRow {
  uid: string;
  source: SetLibrarySource;
  setId: string;
  setName: string;
  tcg: TcgBrand;
  series: string | null;
  releaseYear: number | null;
  totalCards: number | null;
  subset: string | null;
  archived: boolean;
  updatedAt: string | null;
  publishedCardCount: number | null;
  linkedCards: number;
  linkedCertificates: number;
  issueLabels: string[];
  suggestions: SetAttentionSuggestion[];
}

export interface SetAttentionSuggestion {
  key: string;
  label: string;
  severity: "confirmed_issue" | "possible_duplicate" | "missing_information" | "suggested_cleanup";
  current: Record<string, unknown>;
  suggested: Record<string, unknown>;
  dismissed?: boolean;
}

export interface ListSetLibraryInput {
  tab?: unknown;
  q?: unknown;
  sort?: unknown;
  page?: unknown;
  pageSize?: unknown;
  filters?: unknown;
}

export interface ListSetLibraryResult {
  sets: SetLibraryRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  bounded: true;
}

export interface SetLibraryEditInput {
  setName?: unknown;
  setId?: unknown;
  tcg?: unknown;
  series?: unknown;
  releaseYear?: unknown;
  totalCards?: unknown;
  archived?: unknown;
  subset?: unknown;
  reason?: unknown;
  approvedSuggestionId?: unknown;
  confirmLinkedCardUpdate?: unknown;
}

export interface SetLibraryActor {
  id: string;
  role: "admin" | "staff";
}

export class SetLibraryError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SetLibraryError";
    this.status = status;
  }
}

interface BaseSetRow {
  source: SetLibrarySource;
  set_id: string;
  set_name: string;
  card_game: string | null;
  series: string | null;
  release_year: number | string | null;
  total_cards: number | string | null;
  subset: string | null;
  archived: boolean | null;
  updated_at: Date | string | null;
  linked_cards: number | string | null;
  linked_certificates: number | string | null;
}

export function normalizeSetCode(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function cleanTcg(value: unknown): TcgBrand {
  const raw = String(value ?? "pokemon")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if ((TCG_BRANDS as readonly string[]).includes(raw)) return raw as TcgBrand;
  throw new SetLibraryError(400, "Unsupported TCG value");
}

function parseYear(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const year = Number(value);
  if (!Number.isFinite(year) || !Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new SetLibraryError(400, "Year must be a valid four-digit year");
  }
  return year;
}

function parseCardCount(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const count = Number(value);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0 || count > 20000) {
    throw new SetLibraryError(400, "Card count must be a non-negative whole number");
  }
  return count;
}

function parseBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function parseSource(value: unknown): SetLibrarySource {
  if ((SET_LIBRARY_SOURCES as readonly string[]).includes(String(value))) return value as SetLibrarySource;
  throw new SetLibraryError(400, "Unsupported set source");
}

export function validateSetLibraryEdit(input: SetLibraryEditInput) {
  const setId = normalizeSetCode(input.setId);
  const setName = cleanText(input.setName);
  const tcg = cleanTcg(input.tcg);
  const series = cleanText(input.series);
  const subset = cleanText(input.subset);
  const releaseYear = parseYear(input.releaseYear);
  const totalCards = parseCardCount(input.totalCards);
  const archived = parseBool(input.archived);
  const reason = cleanText(input.reason);
  const approvedSuggestionId = cleanText(input.approvedSuggestionId);
  const confirmLinkedCardUpdate = parseBool(input.confirmLinkedCardUpdate);

  if (!setId) throw new SetLibraryError(400, "Set code is required");
  if (!setName) throw new SetLibraryError(400, "Set name is required");
  if (setId.length > 64 || setName.length > 200 || (series?.length ?? 0) > 120 || (subset?.length ?? 0) > 120) {
    throw new SetLibraryError(400, "Set values are too long");
  }

  return {
    setId,
    setName,
    tcg,
    series,
    releaseYear,
    totalCards,
    archived,
    subset,
    reason,
    approvedSuggestionId,
    confirmLinkedCardUpdate,
  };
}

export async function ensureSetLibrarySchema(executor: Pick<typeof db, "execute"> = db): Promise<void> {
  await executor.execute(sql`
    ALTER TABLE custom_sets
      ADD COLUMN IF NOT EXISTS subset TEXT,
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await executor.execute(sql`
    ALTER TABLE tcgdex_sets
      ADD COLUMN IF NOT EXISTS card_game TEXT NOT NULL DEFAULT 'pokemon',
      ADD COLUMN IF NOT EXISTS subset TEXT,
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS set_review_decisions (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      set_id TEXT NOT NULL,
      suggestion_key TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      actor_id TEXT,
      actor_role TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source, set_id, suggestion_key)
    )
  `);
}

function toRow(
  row: BaseSetRow,
  duplicateCodes: Map<string, number>,
  duplicateNames: Map<string, number>,
  duplicateCodeSources: Map<string, string[]>,
  duplicateNameSources: Map<string, string[]>,
  dismissed: Set<string>
): SetLibraryRow {
  const setId = String(row.set_id);
  const setName = String(row.set_name);
  const source = row.source;
  const uid = `${source}:${setId}`;
  const releaseYear = row.release_year == null ? null : Number(row.release_year);
  const totalCards = row.total_cards == null ? null : Number(row.total_cards);
  const linkedCards = Number(row.linked_cards ?? 0);
  const linkedCertificates = Number(row.linked_certificates ?? 0);
  const tcg = (
    (TCG_BRANDS as readonly string[]).includes(String(row.card_game || "pokemon")) ? row.card_game : "other"
  ) as TcgBrand;
  const suggestions: SetAttentionSuggestion[] = [];

  const add = (suggestion: SetAttentionSuggestion) => {
    const key = `${source}:${normalizeSetCode(setId)}:${suggestion.key}`;
    suggestions.push({ ...suggestion, dismissed: dismissed.has(key) });
  };

  if (!setId)
    add({
      key: "missing_code",
      label: "Missing set code",
      severity: "missing_information",
      current: { setId },
      suggested: {},
    });
  if (!releaseYear)
    add({
      key: "missing_year",
      label: "Missing year",
      severity: "missing_information",
      current: { releaseYear },
      suggested: {},
    });
  if (!tcg)
    add({
      key: "missing_tcg",
      label: "Missing TCG",
      severity: "missing_information",
      current: { tcg },
      suggested: { tcg: "pokemon" },
    });
  if (!row.series)
    add({
      key: "missing_series",
      label: "Missing series",
      severity: "missing_information",
      current: { series: null },
      suggested: {},
    });
  if (totalCards == null)
    add({
      key: "missing_card_count",
      label: "Missing card count",
      severity: "missing_information",
      current: { totalCards },
      suggested: {},
    });
  if (setName.length > 80)
    add({
      key: "overlong_name",
      label: "Overlong set name",
      severity: "suggested_cleanup",
      current: { setName },
      suggested: {},
    });
  if (duplicateCodes.get(normalizeSetCode(setId))! > 1) {
    const sources = duplicateCodeSources.get(normalizeSetCode(setId)) ?? [];
    add({
      key: "duplicate_code",
      label: "Duplicate set code",
      severity: "confirmed_issue",
      current: { setId, source, duplicateSources: sources },
      suggested: {},
    });
  }
  const nameKey = setName.toLowerCase().replace(/\s+/g, " ").trim();
  if (duplicateNames.get(nameKey)! > 1) {
    const sources = duplicateNameSources.get(nameKey) ?? [];
    add({
      key: "possible_duplicate_name",
      label: "Possible duplicate name",
      severity: "possible_duplicate",
      current: { setName, source, duplicateSources: sources },
      suggested: {},
    });
  }
  if (linkedCards === 0 && linkedCertificates === 0) {
    add({
      key: "no_links",
      label: "No linked cards or certificates",
      severity: "suggested_cleanup",
      current: { linkedCards, linkedCertificates },
      suggested: { archived: true },
    });
  }
  if (row.archived && linkedCards > 0) {
    add({
      key: "archived_selected",
      label: "Archived set still linked to cards",
      severity: "suggested_cleanup",
      current: { archived: true, linkedCards },
      suggested: {},
    });
  }
  for (const rule of SUBSET_PHRASES) {
    if (setName.toLowerCase().includes(rule.phrase.toLowerCase())) {
      const suggestedName = setName
        .replace(new RegExp(`\\s*[-–—:]?\\s*${rule.phrase}\\s*`, "i"), " ")
        .replace(/\s+/g, " ")
        .trim();
      add({
        key: `subset_phrase_${rule.phrase.toLowerCase().replace(/\s+/g, "_")}`,
        label: `${rule.phrase} in set name`,
        severity: rule.kind === "card_variant" || rule.kind === "rarity" ? "suggested_cleanup" : "possible_duplicate",
        current: { setName, subset: row.subset, classification: rule.kind },
        suggested: {
          setName: suggestedName || setName,
          subset: rule.suggestedSubset,
          note:
            rule.kind === "numbered_subset"
              ? "May be a true numbered subset; review before applying."
              : "Usually a card variant/rarity, not a separate set.",
        },
      });
    }
  }

  return {
    uid,
    source,
    setId,
    setName,
    tcg,
    series: row.series ?? null,
    releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
    totalCards: Number.isFinite(totalCards) ? totalCards : null,
    subset: row.subset ?? null,
    archived: !!row.archived,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    publishedCardCount: Number.isFinite(totalCards) ? totalCards : null,
    linkedCards,
    linkedCertificates,
    issueLabels: suggestions.filter((s) => !s.dismissed).map((s) => s.label),
    suggestions,
  };
}

function parseFilters(input: unknown): Set<string> {
  if (Array.isArray(input)) return new Set(input.map(String));
  if (typeof input === "string")
    return new Set(
      input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  return new Set();
}

export async function listSetLibrary(input: ListSetLibraryInput = {}): Promise<ListSetLibraryResult> {
  await ensureSetLibrarySchema();
  const page = Math.max(1, Number.parseInt(String(input.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(input.pageSize ?? "50"), 10) || 50));
  const q = cleanText(input.q)?.toLowerCase() ?? "";
  const tab = String(input.tab || "all");
  const sort = String(input.sort || "name_az");
  const filters = parseFilters(input.filters);

  const rows = (
    await db.execute(sql`
    WITH all_sets AS (
      SELECT 'custom'::text AS source, set_id, set_name, card_game, series,
             EXTRACT(YEAR FROM release_date)::int AS release_year, total_cards, subset, archived, updated_at
      FROM custom_sets
      UNION ALL
      SELECT 'tcgdex'::text AS source, set_id, set_name, card_game, series,
             EXTRACT(YEAR FROM release_date)::int AS release_year, total_cards, subset, archived, updated_at
      FROM tcgdex_sets
      UNION ALL
      SELECT 'card_sets'::text AS source, set_id, set_name, game AS card_game, series,
             NULLIF(SUBSTRING(COALESCE(release_date, '') FROM '\\d{4}'), '')::int AS release_year,
             total_cards, NULL::text AS subset, is_deleted AS archived, COALESCE(deleted_at, NOW()) AS updated_at
      FROM card_sets
    )
    SELECT s.*,
      (SELECT COUNT(*) FROM card_master cm WHERE LOWER(TRIM(cm.set_id)) = LOWER(TRIM(s.set_id)) AND cm.is_deleted = false)::int AS linked_cards,
      (SELECT COUNT(*) FROM certificates c
         WHERE c.deleted_at IS NULL
           AND LOWER(TRIM(COALESCE(c.set_name, ''))) = LOWER(TRIM(s.set_name))
           AND LOWER(TRIM(COALESCE(c.card_game, 'pokemon'))) = LOWER(TRIM(COALESCE(s.card_game, 'pokemon'))))::int AS linked_certificates
    FROM all_sets s
    ORDER BY set_name ASC, set_id ASC
    LIMIT ${MAX_SCAN_ROWS}
  `)
  ).rows as unknown as BaseSetRow[];

  const dismissedRows = (
    await db.execute(sql`
    SELECT source, set_id, suggestion_key FROM set_review_decisions WHERE decision IN ('reject', 'ignore')
  `)
  ).rows as Array<{ source: string; set_id: string; suggestion_key: string }>;
  const dismissed = new Set(dismissedRows.map((r) => `${r.source}:${normalizeSetCode(r.set_id)}:${r.suggestion_key}`));

  const codeCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  const codeSources = new Map<string, Set<string>>();
  const nameSources = new Map<string, Set<string>>();
  for (const row of rows) {
    const code = normalizeSetCode(row.set_id);
    const name = String(row.set_name || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    codeSources.set(code, (codeSources.get(code) ?? new Set()).add(`${row.source}:${row.set_id}`));
    nameSources.set(name, (nameSources.get(name) ?? new Set()).add(`${row.source}:${row.set_id}`));
  }
  const duplicateCodeSources = new Map(Array.from(codeSources, ([key, value]) => [key, Array.from(value).sort()]));
  const duplicateNameSources = new Map(Array.from(nameSources, ([key, value]) => [key, Array.from(value).sort()]));

  let mapped = rows.map((row) =>
    toRow(row, codeCounts, nameCounts, duplicateCodeSources, duplicateNameSources, dismissed)
  );
  mapped = mapped.filter((row) => {
    if (tab === "needs_attention" && !row.suggestions.some((s) => !s.dismissed)) return false;
    if (tab === "archived" && !row.archived) return false;
    if (q) {
      const haystack = [row.setName, row.setId, row.tcg, row.series, row.releaseYear]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filters.has("active") && row.archived) return false;
    if (filters.has("archived") && !row.archived) return false;
    for (const brand of TCG_BRANDS) {
      if (filters.has(brand) && row.tcg !== brand) return false;
    }
    if (
      filters.has("missing_details") &&
      !row.suggestions.some((s) => s.severity === "missing_information" && !s.dismissed)
    )
      return false;
    if (filters.has("overlong_names") && !row.suggestions.some((s) => s.key === "overlong_name" && !s.dismissed))
      return false;
    if (
      filters.has("possible_duplicates") &&
      !row.suggestions.some((s) => s.severity === "possible_duplicate" && !s.dismissed)
    )
      return false;
    return true;
  });

  mapped.sort((a, b) => {
    switch (sort) {
      case "name_za":
        return b.setName.localeCompare(a.setName);
      case "code_low_high":
        return a.setId.localeCompare(b.setId, undefined, { numeric: true });
      case "code_high_low":
        return b.setId.localeCompare(a.setId, undefined, { numeric: true });
      case "oldest":
        return (a.releaseYear ?? 9999) - (b.releaseYear ?? 9999);
      case "newest":
        return (b.releaseYear ?? 0) - (a.releaseYear ?? 0);
      case "most_linked_certificates":
        return b.linkedCertificates - a.linkedCertificates;
      case "name_az":
      default:
        return a.setName.localeCompare(b.setName);
    }
  });

  const total = mapped.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return { sets: mapped.slice(start, start + pageSize), page, pageSize, total, totalPages, bounded: true };
}

export async function updateSetLibraryRecord(
  sourceInput: unknown,
  targetSetId: unknown,
  input: SetLibraryEditInput,
  actor: SetLibraryActor
) {
  const source = parseSource(sourceInput);
  const target = normalizeSetCode(targetSetId);
  if (!target) throw new SetLibraryError(400, "Set code is required");
  const next = validateSetLibraryEdit(input);

  return db.transaction(async (tx) => {
    await ensureSetLibrarySchema(tx);
    const current = (
      await tx.execute(sql`
      SELECT source, set_id, set_name, card_game, series, release_year, total_cards, subset, archived, updated_at
      FROM (
        SELECT 'custom'::text AS source, set_id, set_name, card_game, series, EXTRACT(YEAR FROM release_date)::int AS release_year, total_cards, subset, archived, updated_at
        FROM custom_sets
        UNION ALL
        SELECT 'tcgdex'::text AS source, set_id, set_name, card_game, series, EXTRACT(YEAR FROM release_date)::int AS release_year, total_cards, subset, archived, updated_at
        FROM tcgdex_sets
        UNION ALL
        SELECT 'card_sets'::text AS source, set_id, set_name, game AS card_game, series, NULLIF(SUBSTRING(COALESCE(release_date, '') FROM '\\d{4}'), '')::int AS release_year,
               total_cards, NULL::text AS subset, is_deleted AS archived, COALESCE(deleted_at, NOW()) AS updated_at
        FROM card_sets
      ) s
      WHERE source = ${source} AND LOWER(TRIM(set_id)) = ${target}
      LIMIT 1
    `)
    ).rows[0] as unknown as BaseSetRow | undefined;
    if (!current) throw new SetLibraryError(404, "Set not found");

    const unchanged =
      normalizeSetCode(current.set_id) === next.setId &&
      String(current.set_name) === next.setName &&
      String(current.card_game || "pokemon") === next.tcg &&
      (current.series ?? null) === next.series &&
      (current.subset ?? null) === next.subset &&
      Number(current.release_year ?? 0) === Number(next.releaseYear ?? 0) &&
      Number(current.total_cards ?? 0) === Number(next.totalCards ?? 0) &&
      !!current.archived === next.archived;
    if (unchanged) throw new SetLibraryError(400, "No changes to save");

    const collision = (
      await tx.execute(sql`
      SELECT source, set_id FROM (
        SELECT 'custom'::text AS source, set_id FROM custom_sets
        UNION ALL SELECT 'tcgdex'::text AS source, set_id FROM tcgdex_sets
        UNION ALL SELECT 'card_sets'::text AS source, set_id FROM card_sets
      ) s
      WHERE LOWER(TRIM(set_id)) = ${next.setId}
        AND NOT (source = ${source} AND LOWER(TRIM(set_id)) = ${target})
      LIMIT 1
    `)
    ).rows[0];
    if (collision) throw new SetLibraryError(409, `Set code "${next.setId}" is already in use`);

    const identical = (
      await tx.execute(sql`
      SELECT source, set_id FROM (
        SELECT 'custom'::text AS source, set_id, set_name, card_game, series, EXTRACT(YEAR FROM release_date)::int AS release_year, total_cards FROM custom_sets
        UNION ALL SELECT 'tcgdex'::text AS source, set_id, set_name, card_game, series, EXTRACT(YEAR FROM release_date)::int AS release_year, total_cards FROM tcgdex_sets
        UNION ALL SELECT 'card_sets'::text AS source, set_id, set_name, game AS card_game, series, NULLIF(SUBSTRING(COALESCE(release_date, '') FROM '\\d{4}'), '')::int AS release_year, total_cards FROM card_sets
      ) s
      WHERE NOT (source = ${source} AND LOWER(TRIM(set_id)) = ${target})
        AND LOWER(TRIM(set_name)) = LOWER(TRIM(${next.setName}))
        AND LOWER(TRIM(COALESCE(card_game, 'pokemon'))) = ${next.tcg}
        AND COALESCE(LOWER(TRIM(series)), '') = COALESCE(LOWER(TRIM(${next.series})), '')
        AND COALESCE(release_year, 0) = COALESCE(${next.releaseYear}, 0)
        AND COALESCE(total_cards, 0) = COALESCE(${next.totalCards}, 0)
      LIMIT 1
    `)
    ).rows[0];
    if (identical) throw new SetLibraryError(409, "An identical set record already exists");

    const releaseDate = next.releaseYear ? `${next.releaseYear}-01-01` : null;
    if (source === "custom") {
      await tx.execute(sql`
        UPDATE custom_sets
        SET set_id = ${next.setId}, set_name = ${next.setName}, card_game = ${next.tcg}, series = ${next.series},
            release_date = ${releaseDate}, total_cards = ${next.totalCards}, subset = ${next.subset},
            archived = ${next.archived}, updated_at = NOW()
        WHERE LOWER(TRIM(set_id)) = ${target}
      `);
    } else if (source === "tcgdex") {
      await tx.execute(sql`
        UPDATE tcgdex_sets
        SET set_id = ${next.setId}, set_name = ${next.setName}, card_game = ${next.tcg}, series = ${next.series},
            release_date = ${releaseDate}, total_cards = ${next.totalCards}, subset = ${next.subset},
            archived = ${next.archived}, updated_at = NOW()
        WHERE LOWER(TRIM(set_id)) = ${target}
      `);
    } else {
      await tx.execute(sql`
        UPDATE card_sets
        SET set_id = ${next.setId}, set_name = ${next.setName}, game = ${next.tcg}, series = ${next.series},
            release_date = ${next.releaseYear == null ? null : String(next.releaseYear)}, total_cards = ${next.totalCards},
            is_deleted = ${next.archived}, deleted_at = CASE WHEN ${next.archived} THEN COALESCE(deleted_at, NOW()) ELSE NULL END
        WHERE LOWER(TRIM(set_id)) = ${target}
      `);
    }

    let linkedCardsUpdated = 0;
    if (target !== next.setId) {
      const linkedCardCount = Number(current.linked_cards ?? 0);
      if (linkedCardCount > 0 && !next.confirmLinkedCardUpdate) {
        throw new SetLibraryError(400, "Confirm linked card update before changing a set code");
      }
      const ambiguousCurrentCode = (
        await tx.execute(sql`
          SELECT source, set_id FROM (
            SELECT 'custom'::text AS source, set_id FROM custom_sets
            UNION ALL SELECT 'tcgdex'::text AS source, set_id FROM tcgdex_sets
            UNION ALL SELECT 'card_sets'::text AS source, set_id FROM card_sets
          ) s
          WHERE LOWER(TRIM(set_id)) = ${target}
            AND NOT (source = ${source} AND LOWER(TRIM(set_id)) = ${target})
          LIMIT 1
        `)
      ).rows[0];
      if (linkedCardCount > 0 && ambiguousCurrentCode) {
        throw new SetLibraryError(
          409,
          "Cannot safely update linked cards because this set code exists in another source"
        );
      }
      const linkedUpdate = await tx.execute(sql`
        UPDATE card_master
        SET set_id = ${next.setId}
        WHERE LOWER(TRIM(set_id)) = ${target}
          AND is_deleted = false
      `);
      linkedCardsUpdated = Number((linkedUpdate as { rowCount?: number }).rowCount ?? 0);
    }

    if (next.approvedSuggestionId) {
      await tx.execute(sql`
        INSERT INTO set_review_decisions (source, set_id, suggestion_key, decision, reason, actor_id, actor_role)
        VALUES (${source}, ${next.setId}, ${next.approvedSuggestionId}, 'approve', ${next.reason}, ${actor.id}, ${actor.role})
        ON CONFLICT (source, set_id, suggestion_key)
        DO UPDATE SET decision = 'approve', reason = EXCLUDED.reason, actor_id = EXCLUDED.actor_id, actor_role = EXCLUDED.actor_role, created_at = NOW()
      `);
    }

    await tx.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      VALUES (
        'set_library',
        ${`${source}:${target}`},
        'set_library_update',
        ${actor.id},
        ${{
          setId: target,
          source,
          editorId: actor.id,
          editorRole: actor.role,
          timestamp: new Date().toISOString(),
          old: {
            setId: current.set_id,
            setName: current.set_name,
            tcg: current.card_game || "pokemon",
            series: current.series,
            releaseYear: current.release_year,
            totalCards: current.total_cards,
            subset: current.subset,
            archived: !!current.archived,
          },
          new: next,
          reason: next.reason,
          approvedSuggestionId: next.approvedSuggestionId,
          linkedCardsUpdated,
          certificateSnapshotPolicy: "issued certificates keep copied set display values; no bulk rewrite performed",
        }}::jsonb
      )
    `);
    return { ok: true as const, source, oldSetId: target, set: next, linkedCardsUpdated, certificatesUpdated: 0 };
  });
}

export async function recordSetReviewDecision(
  sourceInput: unknown,
  setIdInput: unknown,
  suggestionKeyInput: unknown,
  decisionInput: unknown,
  reasonInput: unknown,
  actor: SetLibraryActor
) {
  const source = parseSource(sourceInput);
  const setId = normalizeSetCode(setIdInput);
  const suggestionKey = cleanText(suggestionKeyInput);
  const decision = cleanText(decisionInput);
  const reason = cleanText(reasonInput);
  if (!setId || !suggestionKey) throw new SetLibraryError(400, "Set and suggestion are required");
  if (!decision || !["approve", "reject", "ignore"].includes(decision))
    throw new SetLibraryError(400, "Invalid decision");
  await ensureSetLibrarySchema();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO set_review_decisions (source, set_id, suggestion_key, decision, reason, actor_id, actor_role)
      VALUES (${source}, ${setId}, ${suggestionKey}, ${decision}, ${reason}, ${actor.id}, ${actor.role})
      ON CONFLICT (source, set_id, suggestion_key)
      DO UPDATE SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, actor_id = EXCLUDED.actor_id, actor_role = EXCLUDED.actor_role, created_at = NOW()
    `);
    await tx.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      VALUES ('set_library', ${`${source}:${setId}`}, 'set_review_decision', ${actor.id},
              ${{ source, setId, suggestionKey, decision, reason, editorId: actor.id, editorRole: actor.role }}::jsonb)
    `);
  });
  return { ok: true as const };
}
