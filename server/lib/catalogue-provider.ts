/**
 * Server-side catalogue snapshot provider.
 *
 * Loads the live catalogue_items table and maps it (via the pure
 * shared/catalogue-snapshot mapper) into a {@link CatalogueSnapshot} — the shape
 * the canonical helpers in shared/pokemon-rarity-catalogue.ts consume — so
 * validateStructuredVariant and the label/preview paths validate against the DB,
 * the single source of truth. Falls back to the SEED snapshot when the DB has no
 * rows (or the table is missing pre-migration), so nothing breaks during rollout.
 *
 * Caching: a short TTL in-memory cache. On a multi-machine Fly deploy a catalogue
 * edit is visible on other machines within TTL_MS (bounded staleness for
 * rarely-changing reference data — WATCH-1 in the task ledger). Write paths call
 * invalidateCatalogueCache() for the machine they ran on.
 */
import { SEED_CATALOGUE, type CatalogueSnapshot } from "@shared/pokemon-rarity-catalogue";
import { buildSnapshotFromRows } from "@shared/catalogue-snapshot";
import { listCatalogueItems } from "../services/catalogueService";

const TTL_MS = 30_000;
let cache: { snap: CatalogueSnapshot; at: number } | null = null;

/** Live catalogue snapshot (active, non-archived rows), cached for TTL_MS. */
export async function getCatalogueSnapshot(force = false): Promise<CatalogueSnapshot> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.snap;
  try {
    // Load ALL rows (any state) once, so we can tell a NEVER-seeded category
    // (→ fall back to seed) from a deliberately-emptied one (→ empty picker).
    const allRows = await listCatalogueItems({ includeInactive: true, includeArchived: true });
    if (!allRows.length) {
      cache = { snap: SEED_CATALOGUE, at: Date.now() };
      return SEED_CATALOGUE;
    }
    const activeRows = allRows.filter((r) => r.active && !r.archived);
    const seededCategories = new Set(allRows.map((r) => r.category));
    const snap = buildSnapshotFromRows(activeRows, seededCategories);
    cache = { snap, at: Date.now() };
    return snap;
  } catch {
    // Never let a catalogue-load failure break validation/rendering.
    return SEED_CATALOGUE;
  }
}

export function invalidateCatalogueCache(): void {
  cache = null;
}
