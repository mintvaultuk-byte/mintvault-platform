/**
 * Phase 0.5 — Fail-closed schema preflight.
 *
 * Inspects a database's live public tables (read-only) and classifies them against the
 * managed allowlist (shared/schema.ts) and the classified unmanaged inventory. If ANY
 * live table is in neither set (and is not vq_*), the preflight FAILS — a newly-appeared
 * table is never silently treated as disposable.
 *
 * Read-only: issues one information_schema SELECT and nothing else. Never writes.
 * The core (classifyLiveTables) is pure and unit-tested without a database.
 */
import { classifyLiveTables } from "./schema-registry";

export interface PreflightResult {
  ok: boolean;
  managed: string[];
  unmanaged: string[];
  vaultQuest: string[];
  unknown: string[];
}

/** Pure evaluation over a provided table list (used by tests and by the DB path). */
export function evaluatePreflight(liveTables: string[]): PreflightResult {
  const c = classifyLiveTables(liveTables);
  return { ok: c.unknown.length === 0, ...c };
}

/** Read-only: fetch live public table names. */
async function fetchLiveTables(databaseUrl: string): Promise<string[]> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl, ssl: databaseUrl.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const { rows } = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
    );
    return rows.map((r) => r.table_name);
  } finally {
    await client.end();
  }
}

export async function runPreflight(databaseUrl: string): Promise<PreflightResult> {
  const live = await fetchLiveTables(databaseUrl);
  return evaluatePreflight(live);
}

function isMain(): boolean {
  return !!process.argv[1] && process.argv[1].endsWith("preflight-schema.ts");
}

if (isMain()) {
  const url = process.env.MINTVAULT_DATABASE_URL;
  if (!url) {
    console.error("MINTVAULT_DATABASE_URL is required");
    process.exit(2);
  }
  const res = await runPreflight(url);
  console.log(`Preflight: managed=${res.managed.length} unmanaged=${res.unmanaged.length} vaultQuest=${res.vaultQuest.length} unknown=${res.unknown.length}`);
  if (res.unknown.length > 0) {
    console.error(`\n🚫 Preflight FAILED — ${res.unknown.length} UNKNOWN live table(s) not in the managed allowlist or the classified unmanaged inventory:`);
    for (const t of res.unknown) console.error(`   - ${t}`);
    console.error(`\n   Add each to shared/schema.ts (managed) or to UNMANAGED_INVENTORY in scripts/db/schema-registry.ts\n   with a classification. Do NOT run any schema sync until this is resolved.`);
    process.exit(1);
  }
  console.log("✓ Preflight passed — no unknown tables.");
  process.exit(0);
}
