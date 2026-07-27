/**
 * Catalogue Manager service — the single data-access layer for the DB-backed
 * classification catalogue (rarities, finishes, promo types, designations,
 * languages, eras, subsets, optional card attributes).
 *
 * All CRUD, reorder, archive, enable/disable, search, and import/export go
 * through here. Every mutation is validated (no duplicate value, no duplicate
 * abbreviation, one-classification-only) and audited via the EXISTING audit_log
 * table (entity_type = "catalogue_item"). Reads tolerate a missing table (before
 * migration 0019 is applied) by returning [] — the pickers then fall back to the
 * seed arrays in shared/pokemon-rarity-catalogue.ts, so nothing breaks.
 *
 * This module NEVER touches certificates, grading, cert_counter, or rendering.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  catalogueItems,
  insertCatalogueItemSchema,
  CATALOGUE_CATEGORIES,
  type CatalogueCategory,
  type CatalogueItem,
  type InsertCatalogueItem,
} from "@shared/schema";
import { catalogueConflict, catalogueSearchMatch, parseImportItems } from "@shared/catalogue-validate";

export class CatalogueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueValidationError";
  }
}

/** True when the error is "relation catalogue_items does not exist" (pre-migration). */
function isMissingTable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return /catalogue_items/.test(msg) && /does not exist|relation/i.test(msg);
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

function sortRows(rows: CatalogueItem[]): CatalogueItem[] {
  return [...rows].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.sortOrder - b.sortOrder ||
      a.label.localeCompare(b.label),
  );
}

export interface ListOptions {
  category?: CatalogueCategory;
  includeInactive?: boolean;
  includeArchived?: boolean;
}

/** List catalogue items. Defaults to active, non-archived rows (live-picker set). */
export async function listCatalogueItems(opts: ListOptions = {}): Promise<CatalogueItem[]> {
  try {
    const conds = [];
    if (opts.category) conds.push(eq(catalogueItems.category, opts.category));
    if (!opts.includeArchived) conds.push(eq(catalogueItems.archived, false));
    if (!opts.includeInactive) conds.push(eq(catalogueItems.active, true));
    const rows = conds.length
      ? await db.select().from(catalogueItems).where(and(...conds))
      : await db.select().from(catalogueItems);
    return sortRows(rows);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export async function getCatalogueItem(id: number): Promise<CatalogueItem | undefined> {
  try {
    const [row] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, id));
    return row;
  } catch (err) {
    if (isMissingTable(err)) return undefined;
    throw err;
  }
}

/** Enforce: no duplicate value in a category, no duplicate abbreviation in a
 *  category, and one-classification-only (a value cannot exist in two categories
 *  unless a super admin set allowCrossCategory on both). */
async function assertValid(
  candidate: {
    id?: number;
    category: string;
    value: string;
    abbreviation?: string | null;
    allowCrossCategory?: boolean;
    /** POST-patch live state — required so a reactivation is checked against the
     *  rows that are live NOW (M-2). Absent means live, matching column defaults. */
    active?: boolean;
    archived?: boolean;
  },
  excludeId?: number,
): Promise<void> {
  const all = await db.select().from(catalogueItems);
  const conflict = catalogueConflict(all, candidate, excludeId);
  if (conflict) throw new CatalogueValidationError(conflict);
}

async function audit(
  action: string,
  category: string,
  value: string,
  actor: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await storage.writeAuditLog("catalogue_item", `${category}:${value}`, action, actor, details);
  } catch (err) {
    // Audit must never block a catalogue change, but we surface it in logs.
    console.error("[catalogue] audit write failed:", err instanceof Error ? err.message : err);
  }
}

export async function createCatalogueItem(
  input: InsertCatalogueItem,
  actor: string,
): Promise<CatalogueItem> {
  const parsed = insertCatalogueItemSchema.parse(input);
  await assertValid(parsed);
  // Default sort order = end of its category.
  const siblings = await listCatalogueItems({
    category: parsed.category,
    includeInactive: true,
    includeArchived: true,
  });
  const sortOrder = parsed.sortOrder ?? siblings.length;
  const [inserted] = await db
    .insert(catalogueItems)
    .values({ ...parsed, sortOrder, createdBy: actor, updatedBy: actor })
    .returning();
  await audit("catalogue_item_create", inserted.category, inserted.value, actor, { newValue: inserted });
  return inserted;
}

export interface UpdatePatch {
  label?: string;
  abbreviation?: string | null;
  aliases?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  sortOrder?: number;
  active?: boolean;
  archived?: boolean;
  allowCrossCategory?: boolean;
  notes?: string | null;
  reason?: string;
}

export async function updateCatalogueItem(
  id: number,
  patch: UpdatePatch,
  actor: string,
): Promise<CatalogueItem> {
  const before = await getCatalogueItem(id);
  if (!before) throw new CatalogueValidationError("Catalogue item not found.");
  const { reason, ...fields } = patch;
  const candidate = {
    id,
    category: before.category,
    value: before.value,
    abbreviation: fields.abbreviation ?? before.abbreviation,
    allowCrossCategory: fields.allowCrossCategory ?? before.allowCrossCategory,
    // M-2: validate the state this patch RESULTS IN, not the state it had. A
    // reactivation (archived -> false / active -> true) must be checked against
    // the currently-live rows, or a retired duplicate could be restored on top
    // of the live replacement that took over its code.
    active: fields.active ?? before.active,
    archived: fields.archived ?? before.archived,
  };
  await assertValid(candidate, id);
  const [updated] = await db
    .update(catalogueItems)
    .set({ ...fields, updatedBy: actor, updatedAt: new Date() })
    .where(eq(catalogueItems.id, id))
    .returning();
  await audit("catalogue_item_update", updated.category, updated.value, actor, {
    oldValue: before,
    newValue: updated,
    reason: reason ?? null,
  });
  return updated;
}

export async function setCatalogueActive(id: number, active: boolean, actor: string): Promise<CatalogueItem> {
  return updateCatalogueItem(id, { active, reason: active ? "enabled" : "disabled" }, actor);
}

export async function setCatalogueArchived(id: number, archived: boolean, actor: string): Promise<CatalogueItem> {
  return updateCatalogueItem(id, { archived, reason: archived ? "archived" : "restored" }, actor);
}

/**
 * Reassign sort_order within a category. `orderedIds` may be a PARTIAL/filtered
 * subset (the manager view can hide archived rows or be searched); to avoid
 * colliding sort orders we renumber the WHOLE category: the passed ids take their
 * requested relative order first, then any remaining rows keep their current
 * relative order after them, and every row gets a fresh 0..n-1 index.
 */
export async function reorderCatalogue(
  category: CatalogueCategory,
  orderedIds: number[],
  actor: string,
): Promise<void> {
  const all = await listCatalogueItems({ category, includeInactive: true, includeArchived: true });
  const byId = new Map(all.map((r) => [r.id, r]));
  const seen = new Set<number>();
  const finalOrder: number[] = [];
  // 1) requested ids (that actually belong to this category), in the given order
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) {
      finalOrder.push(id);
      seen.add(id);
    }
  }
  // 2) any remaining category rows, in their current sort order
  for (const r of all) {
    if (!seen.has(r.id)) {
      finalOrder.push(r.id);
      seen.add(r.id);
    }
  }
  for (let i = 0; i < finalOrder.length; i++) {
    await db
      .update(catalogueItems)
      .set({ sortOrder: i, updatedBy: actor, updatedAt: new Date() })
      .where(and(eq(catalogueItems.id, finalOrder[i]), eq(catalogueItems.category, category)));
  }
  await audit("catalogue_reorder", category, category, actor, { orderedIds, finalOrder });
}

/** Search name / abbreviation / aliases / description (case-insensitive). */
export async function searchCatalogueItems(query: string, category?: CatalogueCategory): Promise<CatalogueItem[]> {
  const rows = await listCatalogueItems({ category, includeInactive: true, includeArchived: true });
  return rows.filter((r) => catalogueSearchMatch(r, query));
}

export interface CatalogueExport {
  exportedAt: string;
  version: 1;
  items: Array<Omit<CatalogueItem, "id" | "createdAt" | "updatedAt">>;
}

/** Export the ENTIRE catalogue (including inactive + archived) for backup. */
export async function exportCatalogue(): Promise<CatalogueExport> {
  const rows = await listCatalogueItems({ includeInactive: true, includeArchived: true });
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    items: rows.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest),
  };
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Import a catalogue export — upsert by (category, value). Each row is validated;
 *  invalid rows are skipped and reported rather than aborting the whole import. */
export async function importCatalogue(
  payload: unknown,
  actor: string,
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  const items = parseImportItems(payload);
  if (!items) throw new CatalogueValidationError("Import payload must be a catalogue export ({ items: [...] }) or an array of items.");
  // Bound the import — reference data is small; a huge array would be O(n) writes.
  if (items.length > 5000) throw new CatalogueValidationError("Import too large (max 5000 items).");

  const existing = await listCatalogueItems({ includeInactive: true, includeArchived: true });
  for (const raw of items) {
    try {
      const category = String((raw as { category?: string }).category ?? "");
      const value = String((raw as { value?: string }).value ?? "");
      if (!CATALOGUE_CATEGORIES.includes(category as CatalogueCategory)) {
        throw new CatalogueValidationError(`Unknown category "${category}".`);
      }
      const match = existing.find((r) => r.category === category && norm(r.value) === norm(value));
      if (match) {
        await updateCatalogueItem(
          match.id,
          {
            label: (raw as CatalogueItem).label,
            abbreviation: (raw as CatalogueItem).abbreviation,
            aliases: (raw as CatalogueItem).aliases,
            description: (raw as CatalogueItem).description,
            metadata: (raw as CatalogueItem).metadata,
            sortOrder: (raw as CatalogueItem).sortOrder,
            active: (raw as CatalogueItem).active,
            archived: (raw as CatalogueItem).archived,
            allowCrossCategory: (raw as CatalogueItem).allowCrossCategory,
            notes: (raw as CatalogueItem).notes,
            reason: "import",
          },
          actor,
        );
        result.updated++;
      } else {
        await createCatalogueItem(raw as InsertCatalogueItem, actor);
        result.created++;
      }
    } catch (err) {
      result.skipped++;
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  await audit("catalogue_import", "*", "import", actor, {
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
  });
  return result;
}
