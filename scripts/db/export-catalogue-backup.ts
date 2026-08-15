/**
 * export-catalogue-backup.ts — READ-ONLY catalogue backup for the designation
 * reconciliation change window.
 *
 * Writes the complete `catalogue_items` table to a JSON file OUTSIDE the
 * repository, so a production backup can never be committed by accident.
 *
 * SELECTs only — never writes to any database.
 *
 * USAGE
 *   npx tsx scripts/db/export-catalogue-backup.ts \
 *     --environment production \
 *     --expected-db-host ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech
 *
 *   # custom destination (must be outside the repo)
 *   ... --out-dir /Users/you/secure-backups
 *   # replace an existing file
 *   ... --force-overwrite
 *
 * The output contains catalogue rows only. The connection string is never read
 * into the file, printed, or included in any error message.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  ENVIRONMENTS,
  GuardError,
  parseArgs,
  parseDbHostname,
  assertEnvironmentBinding,
  sslFor,
  assertSafeBackupPath,
  backupFilename,
  DEFAULT_BACKUP_DIR,
} from "./designation-catalogue-contract";

/**
 * Repository root — used to refuse any destination inside the working tree.
 * The package is ESM ("type": "module"), so `__dirname` does not exist at
 * runtime; derive it from import.meta.url instead.
 */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function defaultOutDir(): string {
  return join(homedir(), "Downloads", DEFAULT_BACKUP_DIR);
}

/**
 * Create the destination directory.
 *
 * Only the directory ITSELF is checked for being a symlink. Ancestor symlinks
 * are deliberately NOT rejected — on macOS `/tmp` and `/var` are symlinks, so
 * refusing any symlinked ancestor would reject ordinary destinations. Symlink
 * REDIRECTION into the repository is already caught by `assertSafeBackupPath`,
 * which resolves the deepest existing ancestor and re-derives the real target.
 */
export function ensureDirSafe(dir: string): void {
  if (existsSync(dir)) {
    if (lstatSync(dir).isSymbolicLink()) throw new GuardError(`refusing: backup directory "${dir}" is a symlink`);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (s: string) => console.log(s);

  if (!args.environment) throw new GuardError(`--environment is required (${Object.keys(ENVIRONMENTS).join(", ")})`);

  const host = parseDbHostname(process.env.MINTVAULT_DATABASE_URL);
  const env = assertEnvironmentBinding(args.environment, host, args.expectedDbHost);

  const outDir = args.outDir ? resolve(args.outDir) : defaultOutDir();
  const timestamp = new Date().toISOString();
  const target = join(outDir, backupFilename(env.key, timestamp));

  // Path safety BEFORE touching the database.
  const safeTarget = assertSafeBackupPath(target, repoRoot(), { forceOverwrite: args.forceOverwrite });
  ensureDirSafe(outDir);

  log(`── catalogue backup ──`);
  log(`   environment : ${env.key}`);
  log(`   db host     : ${host} (exact match for ${env.key})`);
  log(`   destination : ${safeTarget}`);

  const client = new pg.Client({ connectionString: process.env.MINTVAULT_DATABASE_URL, ssl: sslFor(host) });
  await client.connect();
  try {
    const rows = (await client.query(`SELECT * FROM catalogue_items ORDER BY id`)).rows;
    const certs = await client.query(`SELECT count(*)::int n FROM certificates`);
    const withDes = await client.query(
      `SELECT count(*)::int n FROM certificates WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb)) > 0`,
    );

    const payload = {
      takenAt: timestamp,
      environment: env.key,
      dbHost: host, // hostname only — never the connection string
      catalogueItemCount: rows.length,
      certificateCount: certs.rows[0].n,
      certificatesWithDesignations: withDes.rows[0].n,
      rows,
    };
    const json = JSON.stringify(payload, null, 1);
    writeFileSync(safeTarget, json, { mode: 0o600 });
    const sha = createHash("sha256").update(json).digest("hex");

    log("");
    log(`   catalogue rows        : ${rows.length}`);
    log(`   certificates          : ${certs.rows[0].n} (with designations: ${withDes.rows[0].n})`);
    log(`   sha256                : ${sha}`);
    log(`✔ backup written (read-only operation — no database was modified).`);
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined && /export-catalogue-backup/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof GuardError ? `\n🚫 REFUSED: ${msg}` : `\n❌ FAILED: ${msg}`);
    process.exit(1);
  });
}

export { main };
