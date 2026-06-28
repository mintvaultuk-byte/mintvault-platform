/**
 * scripts/import-tcgdex-sets.ts
 *
 * Import the full Pokémon SET catalogue from TCGdex into tcgdex_sets (idempotent
 * UPSERT by normalized set_id — safe to re-run; no deletes). SETS ONLY.
 *
 * Needs MINTVAULT_DATABASE_URL set — for LOCAL/STAGING runs only. The PROD path
 * is NOT this script (Cornelius's Mac has no prod DB URL; the prod container is
 * dist-only): trigger POST /api/admin/tcgdex-sets/import as admin instead.
 *
 *   MINTVAULT_DATABASE_URL=... npx tsx scripts/import-tcgdex-sets.ts
 */
import { importTcgdexSets } from "../server/services/tcgdex-sets-import";
import { pool } from "../server/db";

async function main() {
  if (!process.env.MINTVAULT_DATABASE_URL) {
    console.error("[import-tcgdex-sets] ABORT: MINTVAULT_DATABASE_URL is not set.");
    process.exit(1);
  }
  const summary = await importTcgdexSets();
  console.log("[import-tcgdex-sets] SUMMARY", JSON.stringify(summary));
}

main()
  .catch((e: any) => {
    console.error("[import-tcgdex-sets] FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
