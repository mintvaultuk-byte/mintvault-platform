/**
 * Phase 0.5 — Numbered migration runner with journal (concurrency-safe).
 *
 * Applies numbered migrations/NNNN_*.sql in order, recording each in a schema_migrations
 * journal (filename, sha256 checksum, started_at, completed_at, status, applied_by).
 * Guarantees:
 *  - Deterministic ordering by numeric prefix then filename.
 *  - Duplicate migration numbers are rejected before anything runs.
 *  - Idempotent: already-applied files are skipped.
 *  - A checksum mismatch on a previously-applied file is a hard error (a migration was
 *    edited after being applied) — fail closed.
 *  - An 'applying'/'failed' journal row from a crashed run makes the journal inconsistent —
 *    fail closed and require manual resolution.
 *  - Concurrency: a Postgres advisory lock (pg_try_advisory_lock) serialises runners; a
 *    second concurrent runner fails fast rather than double-applying.
 *  - Each transaction-safe file runs inside its own BEGIN/COMMIT (atomic). A file marked
 *    `-- migrate:no-transaction` (e.g. CREATE INDEX CONCURRENTLY) runs outside a transaction
 *    and must be individually idempotent.
 *  - A non-transactional migration may declare
 *    `-- migrate:ensure-valid-concurrent-index schema.index_name`. The runner inspects that index
 *    before running the file: it accepts a valid existing index, removes an invalid one with
 *    DROP INDEX CONCURRENTLY, creates the declared index, then verifies indisvalid before
 *    recording the migration as applied. PostgreSQL does not allow conditional concurrent DDL
 *    inside a transaction or PL/pgSQL block, so this check deliberately lives in the runner.
 *
 * This runner replaces `drizzle-kit push` for staging/production schema change. Applying to
 * a real host still requires explicit owner approval per the protected-actions policy.
 *
 * Modes: default = dry-run (plan + lint, no writes); --apply = execute; --allow-destructive
 * permits a deliberately destructive owner-approved migration.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { lintSql, hasBlocking } from "./lint-destructive-sql";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const FILE_RE = /^(\d{4,})_.+\.sql$/;
// Fixed advisory-lock key for the migration runner (arbitrary constant, namespaced).
const ADVISORY_LOCK_KEY = 4_150_205; // "P0.5" mnemonic; any stable int works.

interface MigrationFile {
  number: string;
  filename: string;
  path: string;
  sql: string;
  checksum: string;
  noTransaction: boolean;
}

const ENSURE_VALID_CONCURRENT_INDEX_RE =
  /^\s*--\s*migrate:ensure-valid-concurrent-index\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/gim;

interface ConcurrentIndexTarget {
  schema: string;
  name: string;
  qualifiedName: string;
}

function ensureValidConcurrentIndexTarget(sql: string): ConcurrentIndexTarget | null {
  const matches = [...sql.matchAll(ENSURE_VALID_CONCURRENT_INDEX_RE)].map((match) => ({
    schema: match[1],
    name: match[2],
    qualifiedName: `${match[1]}.${match[2]}`,
  }));
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error("A migration may declare at most one migrate:ensure-valid-concurrent-index directive.");
  }
  return matches[0];
}

function quoteQualifiedIdentifier(target: ConcurrentIndexTarget): string {
  // The directive parser only permits ordinary, unquoted PostgreSQL identifiers. Keep this
  // escaping as defence in depth because this value is interpolated into concurrent DDL.
  return `"${target.schema.replace(/"/g, '""')}"."${target.name.replace(/"/g, '""')}"`;
}

type ConcurrentIndexState = "missing" | "valid" | "invalid";

/**
 * The directive requires the schema to be explicit so a same-named index in a search_path shadow
 * schema cannot be mistaken for the migration target. An object of another relkind with this name
 * is a hard error rather than something a migration should try to replace.
 */
async function concurrentIndexState(
  client: PgClientLike,
  target: ConcurrentIndexTarget
): Promise<ConcurrentIndexState> {
  const { rows } = await client.query(
    `SELECT c.relkind, i.indisvalid
       FROM pg_class c
       LEFT JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass($1)`,
    [target.qualifiedName]
  );
  const row = rows[0];
  if (!row) return "missing";
  if (row.relkind !== "i") {
    throw new Error(
      `Expected ${target.qualifiedName} to be an index, found PostgreSQL relkind ${String(row.relkind)} instead.`
    );
  }
  return row.indisvalid === true || row.indisvalid === "t" ? "valid" : "invalid";
}

async function applyNonTransactionalMigration(client: PgClientLike, f: MigrationFile): Promise<void> {
  const target = ensureValidConcurrentIndexTarget(f.sql);
  if (!target) {
    await client.query(f.sql);
    return;
  }
  if (!f.noTransaction) {
    throw new Error(`Migration ${f.filename} uses ensure-valid-concurrent-index without migrate:no-transaction.`);
  }

  const before = await concurrentIndexState(client, target);
  if (before === "invalid") {
    // Both operations are intentionally individual autocommit statements. PostgreSQL rejects
    // DROP/CREATE INDEX CONCURRENTLY in a transaction block.
    await client.query(`DROP INDEX CONCURRENTLY ${quoteQualifiedIdentifier(target)}`);
  }
  if (before !== "valid") await client.query(f.sql);

  const after = await concurrentIndexState(client, target);
  if (after !== "valid") {
    throw new Error(`Concurrent index ${target.qualifiedName} is not valid after migration execution.`);
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((filename) => {
      const path = join(dir, filename);
      const sql = readFileSync(path, "utf8");
      const number = filename.match(FILE_RE)![1];
      return {
        number,
        filename,
        path,
        sql,
        checksum: sha256(sql),
        noTransaction: /--\s*migrate:no-transaction/i.test(sql),
      };
    })
    // Deterministic NUMERIC ordering by the integer prefix (not lexical), then filename as a
    // stable tiebreaker. Guards against variable-width numbers (\d{4,}) misordering.
    .sort((a, b) => Number(a.number) - Number(b.number) || a.filename.localeCompare(b.filename));
  // Reject duplicate migration numbers up front — compared by NUMERIC value so 0001 and 00001
  // (same logical number, different width) are caught as duplicates.
  const byNumber = new Map<number, string[]>();
  for (const f of files) {
    const n = Number(f.number);
    byNumber.set(n, [...(byNumber.get(n) ?? []), f.filename]);
  }
  const dups = [...byNumber.entries()].filter(([, names]) => names.length > 1);
  if (dups.length > 0) {
    throw new Error(
      `Duplicate migration number(s): ${dups.map(([n, names]) => `${n} -> ${names.join(", ")}`).join("; ")}`
    );
  }
  return files;
}

const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'applied',
  applied_by TEXT NOT NULL DEFAULT current_user
);
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied';`;

interface PgClientLike {
  query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function ensureJournal(client: PgClientLike): Promise<void> {
  await client.query(JOURNAL_DDL);
}

interface JournalRow {
  checksum: string;
  status: string;
}

async function journalExists(client: PgClientLike): Promise<boolean> {
  const { rows } = await client.query("SELECT to_regclass('public.schema_migrations') AS reg");
  return rows[0]?.reg != null;
}

/**
 * Read-only journal read. If the journal table does not exist yet, returns an empty map
 * WITHOUT creating it — so planMigrations (dry-run) never mutates the database.
 */
async function journalMap(client: PgClientLike): Promise<Map<string, JournalRow>> {
  const m = new Map<string, JournalRow>();
  if (!(await journalExists(client))) return m;
  const { rows } = await client.query("SELECT filename, checksum, status FROM schema_migrations");
  for (const r of rows) m.set(String(r.filename), { checksum: String(r.checksum), status: String(r.status) });
  return m;
}

export interface MigratePlan {
  pending: string[];
  alreadyApplied: string[];
  checksumMismatches: { filename: string; storedChecksum: string; currentChecksum: string }[];
  inconsistent: { filename: string; status: string }[]; // rows left in a non-'applied' state
  destructive: { filename: string; findings: ReturnType<typeof lintSql> }[];
}

/** Read-only planning: never mutates the database (does not create the journal table). */
export async function planMigrations(client: PgClientLike, files: MigrationFile[]): Promise<MigratePlan> {
  const journal = await journalMap(client);
  const plan: MigratePlan = {
    pending: [],
    alreadyApplied: [],
    checksumMismatches: [],
    inconsistent: [],
    destructive: [],
  };
  for (const f of files) {
    const row = journal.get(f.filename);
    if (row === undefined) {
      plan.pending.push(f.filename);
      const findings = lintSql(f.sql);
      if (findings.length > 0) plan.destructive.push({ filename: f.filename, findings });
    } else if (row.status !== "applied") {
      plan.inconsistent.push({ filename: f.filename, status: row.status });
    } else if (row.checksum !== f.checksum) {
      plan.checksumMismatches.push({ filename: f.filename, storedChecksum: row.checksum, currentChecksum: f.checksum });
    } else {
      plan.alreadyApplied.push(f.filename);
    }
  }
  return plan;
}

export async function applyMigrations(
  client: PgClientLike,
  files: MigrationFile[],
  opts: { allowDestructive?: boolean } = {}
): Promise<{ applied: string[] }> {
  // Serialise concurrent runners: a second runner fails fast instead of double-applying.
  const lockRes = await client.query("SELECT pg_try_advisory_lock($1) AS got", [ADVISORY_LOCK_KEY]);
  if (lockRes.rows[0]?.got !== true) {
    throw new Error("Another migration runner holds the advisory lock. Refusing to run concurrently.");
  }
  try {
    await ensureJournal(client); // create/upgrade the journal only on the apply path (never on dry-run)
    const plan = await planMigrations(client, files);
    if (plan.inconsistent.length > 0) {
      throw new Error(
        `Journal inconsistent — rows not in 'applied' state (crashed run?): ${plan.inconsistent
          .map((i) => `${i.filename}=${i.status}`)
          .join(", ")}. Resolve manually before proceeding.`
      );
    }
    if (plan.checksumMismatches.length > 0) {
      throw new Error(
        `Checksum mismatch on already-applied migration(s): ${plan.checksumMismatches
          .map((m) => m.filename)
          .join(", ")}. A migration was edited after being applied. Refusing to proceed.`
      );
    }
    if (!opts.allowDestructive) {
      const blocking = plan.destructive.filter((d) => hasBlocking(d.findings));
      if (blocking.length > 0) {
        throw new Error(
          `Destructive SQL detected in pending migration(s): ${blocking
            .map((d) => d.filename)
            .join(", ")}. Re-run with --allow-destructive only with owner approval.`
        );
      }
    }
    const applied: string[] = [];
    const byName = new Map(files.map((f) => [f.filename, f]));
    for (const filename of plan.pending) {
      const f = byName.get(filename)!;
      if (f.noTransaction) {
        // Non-transactional migration (e.g. CREATE INDEX CONCURRENTLY): cannot run in a txn.
        // Record intent, run, then mark complete. Must be individually idempotent.
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum, status) VALUES ($1,$2,'applying') ON CONFLICT (filename) DO UPDATE SET status='applying', started_at=now()",
          [f.filename, f.checksum]
        );
        try {
          await applyNonTransactionalMigration(client, f);
          await client.query("UPDATE schema_migrations SET status='applied', completed_at=now() WHERE filename=$1", [
            f.filename,
          ]);
        } catch (e) {
          await client.query("UPDATE schema_migrations SET status='failed' WHERE filename=$1", [f.filename]);
          throw new Error(`Non-transactional migration ${f.filename} failed: ${(e as Error).message}`);
        }
      } else {
        await client.query("BEGIN");
        try {
          await client.query(f.sql);
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum, status, completed_at) VALUES ($1,$2,'applied',now())",
            [f.filename, f.checksum]
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${f.filename} failed and was rolled back: ${(e as Error).message}`);
        }
      }
      applied.push(f.filename);
    }
    return { applied };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  }
}

function isMain(): boolean {
  return !!process.argv[1] && process.argv[1].endsWith("migrate.ts");
}

if (isMain()) {
  const url = process.env.MINTVAULT_DATABASE_URL;
  if (!url) {
    console.error("MINTVAULT_DATABASE_URL is required");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");
  const allowDestructive = process.argv.includes("--allow-destructive");
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: url,
    ssl: url.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const files = listMigrationFiles();
    const plan = await planMigrations(client as unknown as PgClientLike, files);
    console.log(
      `Migrations: ${files.length} total, ${plan.alreadyApplied.length} applied, ${plan.pending.length} pending, ` +
        `${plan.inconsistent.length} inconsistent, ${plan.checksumMismatches.length} checksum-mismatch.`
    );
    if (plan.inconsistent.length > 0) {
      console.error(`🚫 Journal inconsistent: ${plan.inconsistent.map((i) => `${i.filename}=${i.status}`).join(", ")}`);
      process.exit(1);
    }
    if (plan.checksumMismatches.length > 0) {
      console.error(`🚫 Checksum mismatches: ${plan.checksumMismatches.map((m) => m.filename).join(", ")}`);
      process.exit(1);
    }
    for (const d of plan.destructive) {
      for (const fd of d.findings)
        console.log(`${fd.severity === "block" ? "🚫" : "⚠️ "} ${d.filename}:${fd.line} [${fd.kind}] ${fd.match}`);
    }
    if (!apply) {
      console.log(`(dry-run) pending: ${plan.pending.join(", ") || "none"}. Re-run with --apply to execute.`);
      process.exit(0);
    }
    const { applied } = await applyMigrations(client as unknown as PgClientLike, files, { allowDestructive });
    console.log(`✓ Applied ${applied.length}: ${applied.join(", ") || "none"}`);
  } finally {
    await client.end();
  }
}
