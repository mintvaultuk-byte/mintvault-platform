/**
 * Project Control — read-only migration ledger scanner.
 *
 * Answers the question "is this migration ACTUALLY applied?" instead of "does the file exist?".
 *
 * SAFETY RULES (identical in spirit to evidence-scan.ts):
 *  - READ ONLY. The single statement below is a SELECT against `schema_migrations`, the ledger
 *    written by scripts/db/migrate.ts. Nothing here applies, plans, or repairs a migration.
 *  - NEVER CONTACTS ANOTHER ENVIRONMENT. It reads whatever database this process is already
 *    connected to and labels its answer with that environment. It opens no new connection, so it
 *    can neither confirm nor deny production from a staging process — and says so.
 *  - FAILS SOFT. A missing ledger table (a database that has never been migrated) is a normal,
 *    reportable answer, not an exception thrown into a request.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import type { ObservedMigration } from "@shared/project-control-distributed";
import {
  resolveProjectControlEnvironment,
  type ProjectControlEnvironment,
} from "@shared/project-control-environment";
import { scanRepository } from "./repo-scan";

/** Cheap enough to re-run, but the dashboard polls, so a short cache still pays. */
const CACHE_TTL_MS = 60_000;

export interface MigrationLedgerRow {
  filename: string;
  status: string;
}

export interface MigrationLedgerScan {
  scannedAt: string;
  /** Which database answered. Derived from config, never a connection string. */
  environment: string;
  /** False when schema_migrations does not exist — i.e. nothing has ever been migrated here. */
  ledgerPresent: boolean;
  migrations: ObservedMigration[];
  warnings: string[];
}

let cache: { at: number; value: MigrationLedgerScan } | null = null;
let inFlight: Promise<MigrationLedgerScan> | null = null;

export function invalidateMigrationScanCache(): void {
  cache = null;
}

/**
 * Name the connected environment WITHOUT ever revealing the connection string.
 *
 * The dashboard must be able to say "applied in staging" — but a Neon host is credential-adjacent
 * and the redaction rules elsewhere in Project Control forbid leaking it. `PROJECT_CONTROL_ENV`
 * names the environment; the host never leaves the server.
 *
 * Delegates to the single strict resolver. This wrapper survives only because the ledger scan and
 * the routes both read better with the "connected environment" name; the RULE lives in one place.
 * In particular `NODE_ENV` may no longer name a deployed environment, and an unresolvable identity
 * is `unknown` rather than a cheerful guess at `local`.
 */
export function resolveConnectedEnvironment(
  env: NodeJS.ProcessEnv = process.env
): ProjectControlEnvironment {
  return resolveProjectControlEnvironment(env);
}

/**
 * Cross-reference the migration FILES in the tree against the migration LEDGER in the database.
 *
 * The two sides disagreeing is the interesting case, and it is the case the owner asked to see:
 * a file with no ledger row is written-but-unapplied, which is explicitly not completion.
 */
export async function scanMigrationLedger(): Promise<MigrationLedgerScan> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  inFlight = doScan()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function doScan(): Promise<MigrationLedgerScan> {
  const warnings: string[] = [];
  const environment = resolveConnectedEnvironment();

  // The files present in the checked-out tree — reuses the existing allowlisted scanner rather
  // than reading the directory a second time.
  const repo = await scanRepository();

  let ledgerPresent = false;
  const ledger = new Map<string, string>();

  try {
    const { rows: reg } = (await db.execute(
      sql`SELECT to_regclass('public.schema_migrations') AS reg`
    )) as unknown as { rows: { reg: string | null }[] };

    ledgerPresent = Boolean(reg[0]?.reg);

    if (ledgerPresent) {
      const { rows } = (await db.execute(
        sql`SELECT filename, status FROM schema_migrations ORDER BY filename`
      )) as unknown as { rows: MigrationLedgerRow[] };
      for (const r of rows) ledger.set(r.filename, r.status);
    } else {
      warnings.push(
        `No schema_migrations table exists in the ${environment} database, so no migration can be shown as applied here.`
      );
    }
  } catch (error) {
    warnings.push(
      `Migration ledger scan failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  const migrations: ObservedMigration[] = repo.migrations.map((m) => {
    const status = ledger.get(m.filename) ?? null;
    return {
      number: m.number,
      filename: m.filename,
      fileExists: true,
      applied: status === "applied",
      failed: status === "failed" || status === "applying",
      environment,
    };
  });

  // A ledger row with no corresponding file is drift worth shouting about: it means the tree and
  // the database disagree about what the schema even is.
  for (const [filename, status] of ledger) {
    if (!repo.migrations.some((m) => m.filename === filename)) {
      warnings.push(
        `The ${environment} database records migration ${filename} (${status}) but no such file exists in this tree.`
      );
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    environment,
    ledgerPresent,
    migrations,
    warnings,
  };
}
