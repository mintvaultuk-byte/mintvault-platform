/**
 * Phase 0.5 — Numbered migration runner with journal.
 *
 * Applies numbered migrations/NNNN_*.sql in order, recording each in a schema_migrations
 * journal (filename + sha256 + applied_at). Idempotent: already-applied files are skipped;
 * a checksum mismatch on a previously-applied file is a hard error (a migration was edited
 * after being applied). Each file runs inside its own transaction (atomic per file).
 *
 * Every file is destructive-SQL linted before it is applied; a blocking finding aborts
 * unless --allow-destructive is passed (for a deliberately destructive, owner-approved
 * migration). This runner replaces `drizzle-kit push` for staging/production schema change.
 *
 * Modes:
 *   --dry-run   inspect + lint + show plan, apply nothing (default when no mode given)
 *   --apply     apply pending migrations
 * The host guard is NOT applied here (migrations are the approved path for real DBs), but
 * applying to a real host still requires owner approval per the protected-actions policy.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { lintSql, hasBlocking } from "./lint-destructive-sql";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const FILE_RE = /^(\d{4,})_.+\.sql$/;

interface MigrationFile {
  filename: string;
  path: string;
  sql: string;
  checksum: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((filename) => {
      const path = join(dir, filename);
      const sql = readFileSync(path, "utf8");
      return { filename, path, sql, checksum: sha256(sql) };
    });
}

const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user
);`;

interface PgClientLike {
  query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function ensureJournal(client: PgClientLike): Promise<void> {
  await client.query(JOURNAL_DDL);
}

async function appliedMap(client: PgClientLike): Promise<Map<string, string>> {
  const { rows } = await client.query("SELECT filename, checksum FROM schema_migrations");
  const m = new Map<string, string>();
  for (const r of rows) m.set(String(r.filename), String(r.checksum));
  return m;
}

export interface MigratePlan {
  pending: string[];
  alreadyApplied: string[];
  checksumMismatches: { filename: string; storedChecksum: string; currentChecksum: string }[];
  destructive: { filename: string; findings: ReturnType<typeof lintSql> }[];
}

export async function planMigrations(client: PgClientLike, files: MigrationFile[]): Promise<MigratePlan> {
  await ensureJournal(client);
  const applied = await appliedMap(client);
  const plan: MigratePlan = { pending: [], alreadyApplied: [], checksumMismatches: [], destructive: [] };
  for (const f of files) {
    const prev = applied.get(f.filename);
    if (prev === undefined) {
      plan.pending.push(f.filename);
      const findings = lintSql(f.sql);
      if (findings.length > 0) plan.destructive.push({ filename: f.filename, findings });
    } else if (prev !== f.checksum) {
      plan.checksumMismatches.push({ filename: f.filename, storedChecksum: prev, currentChecksum: f.checksum });
    } else {
      plan.alreadyApplied.push(f.filename);
    }
  }
  return plan;
}

export async function applyMigrations(
  client: PgClientLike,
  files: MigrationFile[],
  opts: { allowDestructive?: boolean } = {},
): Promise<{ applied: string[] }> {
  const plan = await planMigrations(client, files);
  if (plan.checksumMismatches.length > 0) {
    throw new Error(
      `Checksum mismatch on already-applied migration(s): ${plan.checksumMismatches
        .map((m) => m.filename)
        .join(", ")}. A migration was edited after being applied. Refusing to proceed.`,
    );
  }
  if (!opts.allowDestructive) {
    const blocking = plan.destructive.filter((d) => hasBlocking(d.findings));
    if (blocking.length > 0) {
      throw new Error(
        `Destructive SQL detected in pending migration(s): ${blocking
          .map((d) => d.filename)
          .join(", ")}. Re-run with --allow-destructive only with owner approval.`,
      );
    }
  }
  const applied: string[] = [];
  const byName = new Map(files.map((f) => [f.filename, f]));
  for (const filename of plan.pending) {
    const f = byName.get(filename)!;
    await client.query("BEGIN");
    try {
      await client.query(f.sql);
      await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [f.filename, f.checksum]);
      await client.query("COMMIT");
      applied.push(f.filename);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${f.filename} failed and was rolled back: ${(e as Error).message}`);
    }
  }
  return { applied };
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
  const client = new Client({ connectionString: url, ssl: url.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const files = listMigrationFiles();
    const plan = await planMigrations(client as unknown as PgClientLike, files);
    console.log(`Migrations: ${files.length} total, ${plan.alreadyApplied.length} applied, ${plan.pending.length} pending.`);
    if (plan.checksumMismatches.length > 0) {
      console.error(`🚫 Checksum mismatches: ${plan.checksumMismatches.map((m) => m.filename).join(", ")}`);
      process.exit(1);
    }
    for (const d of plan.destructive) {
      for (const fd of d.findings) console.log(`${fd.severity === "block" ? "🚫" : "⚠️ "} ${d.filename}:${fd.line} [${fd.kind}] ${fd.match}`);
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
