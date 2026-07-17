/**
 * Phase 0.5 — Fail-closed schema preflight (all object types).
 *
 * Read-only. Inspects a database's live objects — tables, views, materialized views,
 * non-system schemas, orphan sequences, and enum types — and classifies them against the
 * managed allowlist (shared/schema.ts) and the classified unmanaged inventory. If ANY live
 * object is in neither set (and is not vq_* / a known system object), the preflight FAILS:
 * a newly-appeared object is never silently treated as disposable.
 *
 * Fail-closed on connection errors, query errors, or incomplete metadata. Never writes
 * (runs under SET default_transaction_read_only = on). Never prints credentials. Emits both
 * human-readable and machine-readable (JSON) output. The core (classifyLiveObjects) is pure
 * and unit-tested without a database.
 */
import { classifyLiveObjects, type LiveObjects, type Classification } from "./schema-registry";

export interface PreflightResult extends Classification {
  ok: boolean;
  counts: { tables: number; views: number; matviews: number; schemas: number; orphanSequences: number; enums: number };
}

/** Pure evaluation over a provided object set (used by tests and by the DB path). */
export function evaluatePreflight(objs: LiveObjects): PreflightResult {
  const c = classifyLiveObjects(objs);
  return {
    ok: c.unknown.length === 0,
    ...c,
    counts: {
      tables: objs.tables.length,
      views: objs.views.length,
      matviews: objs.matviews.length,
      schemas: objs.schemas.length,
      orphanSequences: objs.orphanSequences.length,
      enums: objs.enums.length,
    },
  };
}

/** Read-only: fetch the full live object set. Fails closed (throws) on any query error. */
async function fetchLiveObjects(databaseUrl: string): Promise<LiveObjects> {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("127.0.0.1") || databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const one = async (sql: string): Promise<string[]> => {
      const { rows } = await client.query<{ name: string }>(sql);
      return rows.map((r) => r.name);
    };
    const tables = await one(
      "select table_name as name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
    );
    const views = await one("select table_name as name from information_schema.views where table_schema='public'");
    const matviews = await one("select matviewname as name from pg_matviews where schemaname='public'");
    const schemas = await one(
      "select schema_name as name from information_schema.schemata where schema_name not in ('pg_catalog','information_schema','pg_toast') and schema_name not like 'pg_temp%' and schema_name not like 'pg_toast_temp%'",
    );
    const orphanSequences = await one(
      "select s.relname as name from pg_class s join pg_namespace n on n.oid=s.relnamespace where s.relkind='S' and n.nspname='public' and not exists (select 1 from pg_depend d where d.objid=s.oid and d.deptype='a')",
    );
    const enums = await one(
      "select t.typname as name from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e'",
    );
    // Incomplete-metadata guard: a database with zero tables and zero schemas is not a real
    // target — fail closed rather than reporting a spuriously clean preflight.
    if (tables.length === 0 && schemas.length === 0) {
      throw new Error("Preflight received empty metadata (no tables, no schemas) — failing closed.");
    }
    return { tables, views, matviews, schemas, orphanSequences, enums };
  } finally {
    await client.end();
  }
}

export async function runPreflight(databaseUrl: string): Promise<PreflightResult> {
  const objs = await fetchLiveObjects(databaseUrl);
  return evaluatePreflight(objs);
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
  const asJson = process.argv.includes("--json");
  let res: PreflightResult;
  try {
    res = await runPreflight(url);
  } catch (e) {
    // Fail closed on any connection/query/metadata error. Never echo the URL.
    console.error(`🚫 Preflight FAILED (fail-closed): ${(e as Error).message}`);
    process.exit(1);
  }
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(
      `Preflight: tables=${res.counts.tables} views=${res.counts.views} matviews=${res.counts.matviews} ` +
        `schemas=${res.counts.schemas} orphanSeq=${res.counts.orphanSequences} enums=${res.counts.enums} | ` +
        `managed=${res.managed.length} unmanaged=${res.unmanaged.length} vaultQuest=${res.vaultQuest.length} unknown=${res.unknown.length}`,
    );
  }
  if (!res.ok) {
    console.error(`\n🚫 Preflight FAILED — ${res.unknown.length} UNKNOWN object(s) not managed and not in the classified inventory:`);
    for (const u of res.unknown) console.error(`   - [${u.objectType}] ${u.name}`);
    console.error(
      `\n   Add each to shared/schema.ts (managed table) or to UNMANAGED_INVENTORY / KNOWN_SCHEMAS /\n` +
        `   KNOWN_ORPHAN_SEQUENCES in scripts/db/schema-registry.ts with a classification.\n` +
        `   Do NOT run any schema sync until this is resolved.`,
    );
    process.exit(1);
  }
  console.log("✓ Preflight passed — no unknown objects.");
  process.exit(0);
}
