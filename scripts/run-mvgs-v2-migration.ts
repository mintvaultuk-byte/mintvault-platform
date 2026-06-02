/**
 * scripts/run-mvgs-v2-migration.ts
 *
 * ONE-OFF prod fix. Adds the 5 MVGS v2 columns to the prod `certificates`
 * table. The deployed feat/mvgs-v2-engine code SELECTs these columns; they
 * exist on the staging Neon branch but were never applied to prod, so every
 * SELECT on certificates errors ("Failed query") and pages render empty.
 * Data is intact (77 certs) — missing-column mismatch, NOT deletion.
 *
 * Mirrors migrations/add-mvgs-v2-columns-prod.sql. The SQL is INLINED here on
 * purpose: only the bundled dist/*.cjs ships to the prod container — the .sql
 * file is not deployed, so it can't be read at runtime.
 *
 * Additive only: ADD COLUMN IF NOT EXISTS x5. No DROP / DELETE / UPDATE.
 * Idempotent — safe to re-run, and a clean no-op against staging (cols exist).
 * Existing certs get empty '[]' / NULL defaults and score identically.
 *
 * Build: included in `npm run build` (script/build.ts) -> dist/run-mvgs-v2-migration.cjs
 * Run on prod (uses the prod MINTVAULT_DATABASE_URL already in the machine env):
 *   fly ssh console --app mintvault -C "node /app/dist/run-mvgs-v2-migration.cjs"
 */
import { pool } from "../server/db";

const COLUMNS = ["whitening_lines", "crease_span_pct", "crease_lines", "wrinkle_severity", "tear_severity"] as const;

// Identical to migrations/add-mvgs-v2-columns-prod.sql. Types verified against
// shared/schema.ts (certificates, lines 537-584).
const STATEMENTS: readonly string[] = [
  `ALTER TABLE certificates ADD COLUMN IF NOT EXISTS whitening_lines jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE certificates ADD COLUMN IF NOT EXISTS crease_span_pct numeric(4, 1)`,
  `ALTER TABLE certificates ADD COLUMN IF NOT EXISTS crease_lines jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE certificates ADD COLUMN IF NOT EXISTS wrinkle_severity text`,
  `ALTER TABLE certificates ADD COLUMN IF NOT EXISTS tear_severity text`,
];

const EXPECTED_CERT_COUNT = 77;

async function main(): Promise<void> {
  const host = process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "(unknown)";
  console.log(`[mvgs-v2-migration] DB host: ${host}`);
  console.log(`[mvgs-v2-migration] applying ${STATEMENTS.length} additive ALTER statements...\n`);

  // (1)+(2) run the 5 ADD COLUMN IF NOT EXISTS statements
  for (const stmt of STATEMENTS) {
    const col = stmt.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1] ?? "?";
    process.stdout.write(`  - ADD COLUMN IF NOT EXISTS ${col} ... `);
    await pool.query(stmt);
    console.log("OK");
  }

  // (3) confirm the columns now exist
  console.log("\n[mvgs-v2-migration] columns on certificates:");
  const colRes = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_name = 'certificates'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [[...COLUMNS]]
  );
  for (const r of colRes.rows) {
    console.log(`  + ${r.column_name} (${r.data_type})`);
  }
  const found = new Set(colRes.rows.map((r) => r.column_name));
  const missing = COLUMNS.filter((c) => !found.has(c));
  if (missing.length > 0) {
    throw new Error(`columns still missing after migration: ${missing.join(", ")}`);
  }
  console.log(`  -> all ${COLUMNS.length} columns present`);

  // (4) confirm cert data is intact
  const countRes = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM certificates`);
  const n = countRes.rows[0]?.n ?? -1;
  console.log(`\n[mvgs-v2-migration] certificates row count: ${n}`);
  if (n === EXPECTED_CERT_COUNT) {
    console.log(`  -> ${EXPECTED_CERT_COUNT} certs intact`);
  } else {
    console.warn(`  ! expected ${EXPECTED_CERT_COUNT} certs, got ${n} — review before trusting the page.`);
  }

  // (5) done
  await pool.end();
  console.log("\n[mvgs-v2-migration] complete.");
  process.exit(0);
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\n[mvgs-v2-migration] FAILED:", msg);
  try {
    await pool.end();
  } catch {
    /* ignore close error */
  }
  process.exit(1);
});
