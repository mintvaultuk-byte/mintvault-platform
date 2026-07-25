/**
 * server/services/tcgdex-sets-import.ts
 *
 * Import the canonical Pokémon SET catalogue from TCGdex into the tcgdex_sets
 * table. SETS ONLY — never imports cards or other games.
 *
 * - Idempotent UPSERT by normalized set_id: safe to re-run (no duplicates, no
 *   deletes; only inserts-or-updates). Re-running adds nothing new.
 * - Rate-limited: reuses the tcgdex service's own 1s/lang fetch gate (fetchSet),
 *   so we never hammer TCGdex (~209 sets → ~3.5 min).
 * - Runnable via scripts/import-tcgdex-sets.ts (local/staging) OR the admin
 *   endpoint POST /api/admin/tcgdex-sets/import (prod). Same function, one source.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { listAllSets, fetchSet } from "./tcgdex";
import { assertSetLibrarySchemaReady } from "./set-library";

export interface TcgdexImportSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

/** Same normalization custom_sets uses (lower + strip-whitespace + trim) so the
 *  union dedup in /api/pokemon-sets matches across both tables. */
const normalizeSetId = (id: string): string =>
  String(id || "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();

// One run at a time (the admin endpoint is fire-and-forget; block concurrent runs).
let importRunning = false;
export function isTcgdexImportRunning(): boolean {
  return importRunning;
}

/**
 * Fetch the full Pokémon set list from TCGdex and UPSERT into tcgdex_sets.
 * Returns a summary { fetched, inserted, updated, skipped, errors }.
 */
export async function importTcgdexSets(opts: { lang?: string } = {}): Promise<TcgdexImportSummary> {
  if (importRunning) throw new Error("A TCGdex set import is already running");
  importRunning = true;
  const lang = opts.lang || "en";
  const summary: TcgdexImportSummary = { fetched: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 };
  try {
    await assertSetLibrarySchemaReady();

    const list = await listAllSets(lang); // brief: { id, name, cardCount }
    summary.fetched = list.length;
    // BULK-OP DISCIPLINE: dry-run count logged before any write; UPSERT only (no deletes).
    console.log(`[tcgdex-import] fetched ${list.length} Pokémon sets from TCGdex (${lang}); upserting (rate-limited)…`);

    for (const brief of list) {
      const setId = normalizeSetId(brief.id);
      if (!setId) {
        summary.skipped++;
        continue;
      }
      try {
        // Detail call carries series/releaseDate/abbreviation (not in the brief).
        // fetchSet uses the service's 1s/lang rate-limit gate internally.
        const detail = (await fetchSet(brief.id, lang)) as any;
        const setName = String(detail?.name || brief.name || "").trim();
        if (!setName) {
          summary.skipped++;
          continue;
        }
        const series = String(detail?.serie?.name || "").trim() || null;
        // Only store a full ISO date (TCGdex is usually YYYY-MM-DD); anything else → null
        // so a partial/odd date never errors the DATE cast and drops the row.
        const rawDate = String(detail?.releaseDate || "");
        const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
        const totalCards = Number.isFinite(detail?.cardCount?.official)
          ? detail.cardCount.official
          : Number.isFinite(detail?.cardCount?.total)
            ? detail.cardCount.total
            : Number.isFinite((brief as any)?.cardCount?.official)
              ? (brief as any).cardCount.official
              : null;
        // TCGdex has no dedicated PTCGO code; abbreviation.official ("CRI") is the nearest.
        const ptcgoCode = String(detail?.abbreviation?.official || "").trim() || null;

        const r = await db.execute(sql`
          INSERT INTO tcgdex_sets (set_id, set_name, series, release_date, total_cards, ptcgo_code, source, synced_at)
          VALUES (${setId}, ${setName}, ${series}, ${releaseDate}::date, ${totalCards}, ${ptcgoCode}, 'tcgdex', NOW())
          ON CONFLICT (set_id) DO UPDATE SET
            set_name = EXCLUDED.set_name,
            series = EXCLUDED.series,
            release_date = EXCLUDED.release_date,
            total_cards = EXCLUDED.total_cards,
            ptcgo_code = EXCLUDED.ptcgo_code,
            source = 'tcgdex',
            synced_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `);
        // xmax = 0 on a fresh INSERT; non-zero when the row already existed (UPDATE).
        if ((r.rows[0] as any)?.inserted) summary.inserted++;
        else summary.updated++;
      } catch (e: any) {
        summary.errors++;
        console.error(`[tcgdex-import] set "${brief.id}" failed: ${e.message}`);
      }
    }

    console.log(
      `[tcgdex-import] done — fetched ${summary.fetched}, inserted ${summary.inserted}, updated ${summary.updated}, skipped ${summary.skipped}, errors ${summary.errors}`
    );
    return summary;
  } finally {
    importRunning = false;
  }
}
