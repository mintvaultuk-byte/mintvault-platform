/**
 * Phase 2 · Step 2 — copy all 12 vq_ tables from the shared DB into the dedicated
 * Vault Quest DB.
 *
 *   SOURCE (read-only): MINTVAULT_DATABASE_URL   (current shared staging DB)
 *   DEST   (write):     VAULT_QUEST_DATABASE_URL  (new dedicated staging DB)
 *
 *   DRY-RUN (default): reports source row counts; writes nothing.
 *   --commit         : inserts rows into DEST (ON CONFLICT DO NOTHING; idempotent).
 *   --truncate-dest  : TRUNCATE each DEST table before inserting (clean re-copy).
 *
 * Never writes to SOURCE. Refuses SOURCE===DEST and the grading production host.
 * jsonb/json columns are serialised for the destination driver; arrays/timestamps
 * round-trip natively. Run apply-migrations first so DEST tables exist.
 *
 *   MINTVAULT_DATABASE_URL=... VAULT_QUEST_DATABASE_URL=... \
 *     node scripts/vault-quest-migrate/copy-vq-tables.mjs [--commit] [--truncate-dest]
 */
import { VQ_TABLES, connect, requireEnv, assertNotGradingProd, assertDistinct, hostOf, isCommit, hasFlag } from "./lib.mjs";

const SOURCE = requireEnv("MINTVAULT_DATABASE_URL");
const DEST = requireEnv("VAULT_QUEST_DATABASE_URL");
assertDistinct(SOURCE, DEST);
assertNotGradingProd(DEST, "DEST (copy target)");
const commit = isCommit();
const truncate = hasFlag("--truncate-dest");

console.log(`[copy-tables] SOURCE host=${hostOf(SOURCE)} (read-only) → DEST host=${hostOf(DEST)}`);
console.log(`[copy-tables] mode=${commit ? "COMMIT" : "DRY-RUN"}${truncate ? " +truncate-dest" : ""}`);

const src = await connect(SOURCE, { readOnly: true });
const dest = commit ? await connect(DEST) : null;

let grandSource = 0;
let grandInserted = 0;
try {
  for (const t of VQ_TABLES) {
    const meta = (
      await src.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [t],
      )
    ).rows;
    const cols = meta.map((c) => c.column_name);
    const jsonCols = new Set(meta.filter((c) => c.data_type === "jsonb" || c.data_type === "json").map((c) => c.column_name));
    const quoted = cols.map((c) => `"${c}"`).join(",");
    const rows = (await src.query(`SELECT ${quoted} FROM public."${t}"`)).rows;
    grandSource += rows.length;

    if (!commit) {
      console.log(`  ${t}: source=${rows.length} (dry-run, no write)`);
      continue;
    }

    await dest.query("BEGIN");
    await dest.query("SET LOCAL search_path = public");
    if (truncate) await dest.query(`TRUNCATE public."${t}"`);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
    let inserted = 0;
    for (const row of rows) {
      const vals = cols.map((c) => {
        const v = row[c];
        return v !== null && jsonCols.has(c) ? JSON.stringify(v) : v;
      });
      const r = await dest.query(
        `INSERT INTO public."${t}" (${quoted}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        vals,
      );
      inserted += r.rowCount ?? 0;
    }
    await dest.query("COMMIT");
    grandInserted += inserted;
    const destCount = (await dest.query(`SELECT count(*)::int n FROM public."${t}"`)).rows[0].n;
    console.log(`  ${t}: source=${rows.length} inserted=${inserted} dest_total=${destCount}`);
  }
  console.log(
    `[copy-tables] ${commit ? `DONE — source_rows=${grandSource} inserted=${grandInserted}. Now run verify-db.mjs.` : `DRY-RUN — source_rows=${grandSource}. Re-run with --commit.`}`,
  );
} catch (err) {
  if (dest) {
    try {
      await dest.query("ROLLBACK");
    } catch {
      /* ignore */
    }
  }
  console.error(`[copy-tables] FAILED:`, err.message);
  process.exitCode = 1;
} finally {
  await src.end();
  if (dest) await dest.end();
}
