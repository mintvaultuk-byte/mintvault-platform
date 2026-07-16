/**
 * Data access for the Pokémon Knowledge Engine (set directory + provenance +
 * revisions + draft imports + review queue).
 *
 * Rules enforced HERE (app layer is authoritative; DB CHECKs are backstops):
 *   • era/region/status/confidence/source enums validated before any write
 *   • every canonical write records a revision (never silently overwrite)
 *   • imports only ever create DRAFT runs — applying requires an explicit
 *     approval call, which is what writes canonical rows
 *   • nothing here reads or writes certificates — set knowledge only
 */
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  pokemonSetKnowledge,
  pokemonSetAliases,
  pokemonKnowledgeRevisions,
  pokemonImportRuns,
  pokemonReviewQueue,
  type PokemonSetKnowledge,
  type PokemonImportRun,
  type PokemonReviewQueueItem,
} from "@shared/schema";
import { normalizeSetCode } from "@shared/set-code";
import { SOURCE_TYPES, REVIEW_STATUSES_KNOWLEDGE } from "@shared/pokemon-knowledge";
import { POKEMON_ERAS, POKEMON_LANGUAGES } from "@shared/pokemon-rarity-catalogue";
import { STARTER_SETS, type StarterSetRecord } from "@shared/pokemon-starter-sets";

const ERAS = new Set(POKEMON_ERAS.map((e) => e.value as string));
const REGIONS = new Set(["western", "japan", "korea", "china", "sea", "other"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const STATUSES = new Set<string>(REVIEW_STATUSES_KNOWLEDGE);
const SOURCES = new Set<string>(SOURCE_TYPES);
const LANGUAGES = new Set(POKEMON_LANGUAGES.map((l) => l.value));
const ALIAS_TYPES = new Set(["printed_code", "ptcgo", "jp_english_name", "market_name", "translated_name", "other"]);

export class KnowledgeValidationError extends Error {
  status = 400;
}

const str = (v: unknown, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
};
const intOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new KnowledgeValidationError("Card counts must be whole numbers.");
  return n;
};

export interface SetKnowledgeInput {
  setKey?: string;
  setCode?: string;
  language?: string;
  canonicalName?: string;
  localName?: string | null;
  translatedName?: string | null;
  altCode?: string | null;
  abbreviation?: string | null;
  series?: string | null;
  era?: string | null;
  region?: string | null;
  releaseDate?: string | null;
  year?: string | null;
  announcedCount?: number | null;
  mainCount?: number | null;
  secretCount?: number | null;
  collectorNumberFormat?: string | null;
  parentSetKey?: string | null;
  symbolNote?: string | null;
  sourceType?: string;
  sourceReference?: string | null;
  verifiedDate?: string | null;
  confidence?: string;
  status?: string;
  archived?: boolean;
  notes?: string | null;
}

/** Validate + normalise an input record. Throws KnowledgeValidationError on bad enums. */
export function validateSetInput(input: SetKnowledgeInput): Required<Pick<SetKnowledgeInput, "setKey" | "language" | "canonicalName">> & SetKnowledgeInput {
  const setKey = normalizeSetCode(input.setKey ?? input.setCode);
  if (!setKey) throw new KnowledgeValidationError("A set code / key is required.");
  const language = str(input.language) ?? "en";
  if (!LANGUAGES.has(language)) throw new KnowledgeValidationError(`Unknown language "${language}".`);
  const canonicalName = str(input.canonicalName);
  if (!canonicalName) throw new KnowledgeValidationError("A canonical set name is required.");
  const era = str(input.era);
  if (era && !ERAS.has(era)) throw new KnowledgeValidationError(`Unknown era "${era}".`);
  const region = str(input.region);
  if (region && !REGIONS.has(region)) throw new KnowledgeValidationError(`Unknown region "${region}".`);
  const status = str(input.status) ?? "provisional";
  if (!STATUSES.has(status)) throw new KnowledgeValidationError(`Unknown status "${status}".`);
  const confidence = str(input.confidence) ?? "low";
  if (!CONFIDENCES.has(confidence)) throw new KnowledgeValidationError(`Unknown confidence "${confidence}".`);
  const sourceType = str(input.sourceType) ?? "unknown";
  if (!SOURCES.has(sourceType)) throw new KnowledgeValidationError(`Unknown source type "${sourceType}".`);
  if (status === "verified" && sourceType === "unknown") {
    throw new KnowledgeValidationError("A verified record must state its source (provenance required).");
  }
  return {
    ...input,
    setKey,
    language,
    canonicalName,
    setCode: str(input.setCode) ?? setKey,
    era,
    region,
    status,
    confidence,
    sourceType,
    announcedCount: intOrNull(input.announcedCount),
    mainCount: intOrNull(input.mainCount),
    secretCount: intOrNull(input.secretCount),
    year: str(input.year, 10),
    notes: str(input.notes, 2000),
  };
}

// ── Search / list ─────────────────────────────────────────────────────────────
export interface SetSearchParams {
  q?: string;
  language?: string;
  region?: string;
  era?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export async function searchSets(params: SetSearchParams): Promise<{ items: PokemonSetKnowledge[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
  const conds = [];
  const q = str(params.q, 80);
  if (q) {
    const like = `%${q}%`;
    const aliasKeys = await db
      .select({ setKey: pokemonSetAliases.setKey })
      .from(pokemonSetAliases)
      .where(ilike(pokemonSetAliases.aliasValue, like))
      .limit(50);
    const keys = [normalizeSetCode(q), ...aliasKeys.map((a) => a.setKey)];
    conds.push(
      or(
        ilike(pokemonSetKnowledge.canonicalName, like),
        ilike(pokemonSetKnowledge.localName, like),
        ilike(pokemonSetKnowledge.translatedName, like),
        ilike(pokemonSetKnowledge.setCode, like),
        ilike(pokemonSetKnowledge.collectorNumberFormat, like),
        sql`${pokemonSetKnowledge.setKey} = ANY(${keys})`,
      ),
    );
  }
  if (str(params.language)) conds.push(eq(pokemonSetKnowledge.language, params.language!));
  if (str(params.region)) conds.push(eq(pokemonSetKnowledge.region, params.region!));
  if (str(params.era)) conds.push(eq(pokemonSetKnowledge.era, params.era!));
  if (str(params.status)) conds.push(eq(pokemonSetKnowledge.status, params.status!));
  const where = conds.length ? and(...conds) : undefined;

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(pokemonSetKnowledge)
      .where(where)
      .orderBy(desc(pokemonSetKnowledge.year), asc(pokemonSetKnowledge.canonicalName))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`cast(count(*) as int)` }).from(pokemonSetKnowledge).where(where),
  ]);
  return { items, total: Number(totalRow[0]?.n ?? 0), page, pageSize };
}

export async function getSetDetail(setKey: string, language: string) {
  const key = normalizeSetCode(setKey);
  const [row] = await db
    .select()
    .from(pokemonSetKnowledge)
    .where(and(eq(pokemonSetKnowledge.setKey, key), eq(pokemonSetKnowledge.language, language)));
  if (!row) return null;
  const aliases = await db.select().from(pokemonSetAliases).where(eq(pokemonSetAliases.setKey, key));
  const revisions = await db
    .select()
    .from(pokemonKnowledgeRevisions)
    .where(and(eq(pokemonKnowledgeRevisions.entityType, "set"), eq(pokemonKnowledgeRevisions.entityKey, `${key}:${language}`)))
    .orderBy(desc(pokemonKnowledgeRevisions.revisionNumber));
  // Regional editions: same setKey other languages + parent/children links.
  const related = await db
    .select()
    .from(pokemonSetKnowledge)
    .where(
      or(
        and(eq(pokemonSetKnowledge.setKey, key), sql`${pokemonSetKnowledge.language} <> ${language}`),
        eq(pokemonSetKnowledge.parentSetKey, key),
        row.parentSetKey ? eq(pokemonSetKnowledge.setKey, row.parentSetKey) : sql`false`,
      ),
    );
  // Prev/next by (year, name) ordering for browse controls.
  const ordered = await db
    .select({ setKey: pokemonSetKnowledge.setKey, language: pokemonSetKnowledge.language, name: pokemonSetKnowledge.canonicalName })
    .from(pokemonSetKnowledge)
    .orderBy(desc(pokemonSetKnowledge.year), asc(pokemonSetKnowledge.canonicalName));
  const idx = ordered.findIndex((o) => o.setKey === key && o.language === language);
  return {
    set: row,
    aliases,
    revisions,
    related,
    prev: idx > 0 ? ordered[idx - 1] : null,
    next: idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null,
  };
}

// ── Canonical upsert (always writes a revision; flags duplicates) ─────────────
export async function upsertSetKnowledge(
  input: SetKnowledgeInput,
  editor: string,
  reason: string | null,
): Promise<{ row: PokemonSetKnowledge; created: boolean }> {
  const v = validateSetInput(input);
  const entityKey = `${v.setKey}:${v.language}`;

  const values = {
    setKey: v.setKey,
    language: v.language,
    canonicalName: v.canonicalName,
    localName: str(v.localName),
    translatedName: str(v.translatedName),
    setCode: v.setCode ?? v.setKey,
    altCode: str(v.altCode),
    abbreviation: str(v.abbreviation, 20),
    series: str(v.series),
    era: v.era ?? null,
    region: v.region ?? null,
    releaseDate: str(v.releaseDate, 20),
    year: v.year ?? null,
    announcedCount: v.announcedCount ?? null,
    mainCount: v.mainCount ?? null,
    secretCount: v.secretCount ?? null,
    collectorNumberFormat: str(v.collectorNumberFormat, 40),
    parentSetKey: v.parentSetKey ? normalizeSetCode(v.parentSetKey) : null,
    symbolNote: str(v.symbolNote, 500),
    sourceType: v.sourceType!,
    sourceReference: str(v.sourceReference, 500),
    verifiedDate: str(v.verifiedDate, 20),
    confidence: v.confidence!,
    status: v.status!,
    archived: Boolean(v.archived),
    notes: v.notes ?? null,
    updatedBy: editor,
    updatedAt: new Date(),
  };

  // The row write + its revision insert run in ONE transaction, and the existing
  // row is re-read FOR UPDATE inside it, so two Fly machines editing the same
  // (set_key, language) serialize — a canonical change can never commit without
  // its matching revision, and revision numbers never collide.
  const { row, created } = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(pokemonSetKnowledge)
      .where(and(eq(pokemonSetKnowledge.setKey, v.setKey), eq(pokemonSetKnowledge.language, v.language)))
      .for("update");

    if (existing) {
      const nextVersion = existing.version + 1;
      const [r] = await tx
        .update(pokemonSetKnowledge)
        .set({ ...values, version: nextVersion })
        .where(eq(pokemonSetKnowledge.id, existing.id))
        .returning();
      await tx.insert(pokemonKnowledgeRevisions).values({
        entityType: "set",
        entityKey,
        revisionNumber: nextVersion,
        oldValue: existing as unknown as Record<string, unknown>,
        newValue: r as unknown as Record<string, unknown>,
        reason,
        sourceType: values.sourceType,
        editedBy: editor,
      });
      return { row: r, created: false };
    }
    const [r] = await tx
      .insert(pokemonSetKnowledge)
      .values({ ...values, createdBy: editor, version: 1 })
      .returning();
    await tx.insert(pokemonKnowledgeRevisions).values({
      entityType: "set",
      entityKey,
      revisionNumber: 1,
      oldValue: null,
      newValue: r as unknown as Record<string, unknown>,
      reason: reason ?? "created",
      sourceType: values.sourceType,
      editedBy: editor,
    });
    return { row: r, created: true };
  });

  // Duplicate-name detection across DIFFERENT keys → review queue (never a merge).
  const dupes = await db
    .select({ setKey: pokemonSetKnowledge.setKey })
    .from(pokemonSetKnowledge)
    .where(
      and(
        ilike(pokemonSetKnowledge.canonicalName, v.canonicalName),
        eq(pokemonSetKnowledge.language, v.language),
        sql`${pokemonSetKnowledge.setKey} <> ${v.setKey}`,
      ),
    );
  if (dupes.length > 0) {
    await db.insert(pokemonReviewQueue).values({
      kind: "duplicate_set_name",
      entityType: "set",
      entityKey,
      details: { name: v.canonicalName, otherKeys: dupes.map((d) => d.setKey) },
    });
  }

  // Aliases from the input (idempotent inserts). alias_type is coerced to the
  // catalogue vocabulary so an out-of-vocab value can never reach the DB CHECK
  // (which would surface as a 500 instead of being silently normalised).
  const aliasInput = (input as { aliases?: { aliasType: string; aliasValue: string }[] }).aliases;
  if (Array.isArray(aliasInput)) {
    for (const a of aliasInput.slice(0, 20)) {
      const aliasValue = normalizeSetCode(String(a.aliasValue ?? "")) || String(a.aliasValue ?? "").trim().toLowerCase();
      if (!aliasValue) continue;
      const aliasType = ALIAS_TYPES.has(String(a.aliasType)) ? String(a.aliasType) : "other";
      await db
        .insert(pokemonSetAliases)
        .values({ setKey: v.setKey, language: v.language, aliasType, aliasValue: aliasValue.slice(0, 120), createdBy: editor })
        .onConflictDoNothing();
    }
  }

  return { row, created };
}

/** Restore an old revision AS A NEW revision (never rewrites history). */
export async function restoreRevision(entityKey: string, revisionNumber: number, editor: string): Promise<PokemonSetKnowledge> {
  const [rev] = await db
    .select()
    .from(pokemonKnowledgeRevisions)
    .where(
      and(
        eq(pokemonKnowledgeRevisions.entityType, "set"),
        eq(pokemonKnowledgeRevisions.entityKey, entityKey),
        eq(pokemonKnowledgeRevisions.revisionNumber, revisionNumber),
      ),
    );
  if (!rev) throw new KnowledgeValidationError("Revision not found.");
  const snapshot = rev.newValue as unknown as SetKnowledgeInput;
  const { row } = await upsertSetKnowledge(snapshot, editor, `restore of revision ${revisionNumber}`);
  return row;
}

// ── Draft imports (Phase 17 — never write canonical directly) ─────────────────
export interface ImportCandidate extends SetKnowledgeInput {
  aliases?: { aliasType: string; aliasValue: string }[];
}

export async function createImportRun(
  source: string,
  candidates: ImportCandidate[],
  startedBy: string,
  sourceReference?: string,
): Promise<PokemonImportRun> {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new KnowledgeValidationError("No records to import.");
  if (candidates.length > 2000) throw new KnowledgeValidationError("Import too large (max 2000 records per run).");
  const validated = candidates.map((c) => validateSetInput(c));
  // Conflict detection vs existing canonical records.
  const conflicts: unknown[] = [];
  let added = 0;
  let changed = 0;
  for (const c of validated) {
    const [existing] = await db
      .select({ id: pokemonSetKnowledge.id, canonicalName: pokemonSetKnowledge.canonicalName, status: pokemonSetKnowledge.status })
      .from(pokemonSetKnowledge)
      .where(and(eq(pokemonSetKnowledge.setKey, c.setKey), eq(pokemonSetKnowledge.language, c.language)));
    if (existing) {
      changed++;
      if (existing.canonicalName !== c.canonicalName) {
        conflicts.push({ setKey: c.setKey, language: c.language, kind: "name_conflict", existing: existing.canonicalName, incoming: c.canonicalName });
      }
    } else {
      added++;
    }
  }
  const [run] = await db
    .insert(pokemonImportRuns)
    .values({
      source,
      sourceReference: sourceReference ?? null,
      status: "draft",
      payload: validated as unknown[],
      recordsTotal: validated.length,
      recordsAdded: added,
      recordsChanged: changed,
      conflicts,
      startedBy,
    })
    .returning();
  // New-set review entries for visibility (pending founder approval of the run).
  await db.insert(pokemonReviewQueue).values({
    kind: "new_set",
    entityType: "import_run",
    entityKey: String(run.id),
    details: { source, records: validated.length, added, changed, conflicts: conflicts.length },
    importRunId: run.id,
  });
  return run;
}

export function starterSeedCandidates(): ImportCandidate[] {
  return STARTER_SETS.map((r: StarterSetRecord) => ({
    ...r,
    sourceType: "trusted_catalogue",
    sourceReference: "MintVault starter dataset (collector-standard codes) — verify against official sources",
    confidence: "medium",
    status: "provisional",
  }));
}

export async function decideImportRun(
  id: number,
  decision: "approved" | "rejected",
  reviewer: string,
): Promise<{ run: PokemonImportRun; applied: number }> {
  const [run] = await db.select().from(pokemonImportRuns).where(eq(pokemonImportRuns.id, id));
  if (!run) throw new KnowledgeValidationError("Import run not found.");
  if (run.status !== "draft") throw new KnowledgeValidationError(`Import run is already ${run.status}.`);

  if (decision === "rejected") {
    const [updated] = await db
      .update(pokemonImportRuns)
      .set({ status: "rejected", reviewedBy: reviewer, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(pokemonImportRuns.id, id))
      .returning();
    return { run: updated, applied: 0 };
  }

  // Approved → apply payload to canonical records (each write gets a revision).
  let applied = 0;
  for (const candidate of run.payload as ImportCandidate[]) {
    await upsertSetKnowledge(candidate, reviewer, `import run #${id} (${run.source})`);
    applied++;
  }
  const [updated] = await db
    .update(pokemonImportRuns)
    .set({ status: "applied", reviewedBy: reviewer, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(pokemonImportRuns.id, id))
    .returning();
  return { run: updated, applied };
}

export async function listImportRuns(): Promise<PokemonImportRun[]> {
  return db.select().from(pokemonImportRuns).orderBy(desc(pokemonImportRuns.createdAt)).limit(50);
}

// ── Review queue ──────────────────────────────────────────────────────────────
export async function listReviewQueue(status?: string): Promise<PokemonReviewQueueItem[]> {
  const where = status ? eq(pokemonReviewQueue.status, status) : eq(pokemonReviewQueue.status, "pending");
  return db.select().from(pokemonReviewQueue).where(where).orderBy(desc(pokemonReviewQueue.createdAt)).limit(200);
}

export async function resolveReviewItem(
  id: number,
  status: "approved" | "rejected" | "ignored",
  resolver: string,
  note?: string,
): Promise<PokemonReviewQueueItem> {
  const [row] = await db
    .update(pokemonReviewQueue)
    .set({ status, resolvedBy: resolver, resolvedAt: new Date(), resolutionNote: note?.slice(0, 500) ?? null })
    .where(eq(pokemonReviewQueue.id, id))
    .returning();
  if (!row) throw new KnowledgeValidationError("Review item not found.");
  return row;
}

// ── Exports + stats (no customer data lives in any of these tables) ──────────
export async function listAllSetsForExport(): Promise<PokemonSetKnowledge[]> {
  return db.select().from(pokemonSetKnowledge).orderBy(asc(pokemonSetKnowledge.setKey), asc(pokemonSetKnowledge.language));
}

export async function knowledgeStats() {
  const [sets] = await db
    .select({
      total: sql<number>`cast(count(*) as int)`,
      verified: sql<number>`cast(count(*) filter (where status = 'verified') as int)`,
      provisional: sql<number>`cast(count(*) filter (where status = 'provisional') as int)`,
      needsReview: sql<number>`cast(count(*) filter (where status = 'needs_review') as int)`,
      recentlyUpdated: sql<number>`cast(count(*) filter (where updated_at > now() - interval '30 days') as int)`,
    })
    .from(pokemonSetKnowledge);
  const [pendingReview] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(pokemonReviewQueue)
    .where(eq(pokemonReviewQueue.status, "pending"));
  const latest = await db
    .select({ setKey: pokemonSetKnowledge.setKey, language: pokemonSetKnowledge.language, canonicalName: pokemonSetKnowledge.canonicalName, updatedAt: pokemonSetKnowledge.updatedAt })
    .from(pokemonSetKnowledge)
    .orderBy(desc(pokemonSetKnowledge.updatedAt))
    .limit(5);
  return { sets, pendingReview: Number(pendingReview?.n ?? 0), latest };
}
