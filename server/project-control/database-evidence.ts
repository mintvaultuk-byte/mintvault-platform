/**
 * Project Control — durable database and migration evidence.
 *
 * Answers, for the environment THIS PROCESS is connected to: which migrations are actually
 * applied, whether the Project Control schema is intact, and whether the ledger contradicts the
 * catalogue. Then stores that answer so it survives the request, the restart and the other machine.
 *
 * ENVIRONMENT HONESTY
 * -------------------
 * A staging process can only observe staging. It cannot confirm or deny production, and this
 * module never claims to — production evidence must come from a production process. The
 * environment is named from configuration; the connection string never leaves the server, because
 * a Neon host is credential-adjacent.
 *
 * UNAVAILABLE IS NOT "EVERYTHING PENDING"
 * ---------------------------------------
 * If the database cannot be read, that is UNAVAILABLE — recorded, visible, and explicitly not a
 * finding that every migration is outstanding. Inferring "pending" from "could not look" would
 * manufacture a fake crisis on every transient blip, and an operator who sees one of those learns
 * to ignore the next real one.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createRun,
  completeRun,
  markRunning,
  insertSnapshot,
  getActiveRun,
  expireAbandonedRuns,
  withTransaction,
  type EvidenceDb,
} from "./evidence-repository";
import { withLease, workerIdentity, type LeaseDb } from "./sync-lease";
import { mayWriteLabelledEvidence } from "@shared/project-control-environment";
import { resolveEnvironmentName } from "./probe-persistence";

export const DATABASE_SOURCE = "database";
export const DATABASE_VALID_MS = 15 * 60 * 1000;

export type DatabaseDb = EvidenceDb & LeaseDb;

/**
 * THE TEN. Every foreign key the Project Control migrations create.
 *
 * Checked by EXACT NAME, not by count. The previous check was `fks.length >= 7` against a comment
 * saying "7 expected" — so a database missing two of the nine reported healthy, and seven
 * constraints with entirely the wrong names would also have passed. A referential-integrity check
 * that cannot tell you WHICH constraint is missing is not a check.
 *
 * PROVENANCE — this list must track the migrations, and drifted once already:
 *   0030 creates the first nine.
 *   0040 adds `fk_pc_work_packages_superseded_by` (supersession target). It was missing here, so a
 *        correct, migration-created constraint was reported as `unexpected` on every staging
 *        refresh after 0040 landed. Nothing broke — `intact` only measures MISSING — but the
 *        evidence was wrong, and evidence being wrong is the one thing this dashboard exists to
 *        prevent. Any future migration that adds a pc_* foreign key MUST add its name here.
 */
export const EXPECTED_PC_FOREIGN_KEYS: readonly string[] = Object.freeze([
  "fk_pc_blockers_package",
  "fk_pc_dependencies_depends_on",
  "fk_pc_dependencies_package",
  "fk_pc_deployments_package",
  "fk_pc_evidence_package",
  "fk_pc_nodes_parent",
  "fk_pc_prompts_package",
  "fk_pc_test_runs_package",
  "fk_pc_work_packages_node",
  // 0040 — supersession target; retiring a package must point at a real replacement.
  "fk_pc_work_packages_superseded_by",
]);

export interface ForeignKeyVerdict {
  expected: number;
  present: string[];
  missing: string[];
  unexpected: string[];
  intact: boolean;
}

/**
 * Compare observed constraint names against the expected set.
 *
 * Reports `missing` AND `unexpected` separately: a renamed constraint shows up in both, which is a
 * different problem from one that was never created, and the operator needs to tell them apart.
 */
export function verifyForeignKeys(observed: string[]): ForeignKeyVerdict {
  const seen = new Set(observed);
  const missing = EXPECTED_PC_FOREIGN_KEYS.filter((name) => !seen.has(name));
  const unexpected = observed.filter((name) => !EXPECTED_PC_FOREIGN_KEYS.includes(name));
  return {
    expected: EXPECTED_PC_FOREIGN_KEYS.length,
    present: EXPECTED_PC_FOREIGN_KEYS.filter((name) => seen.has(name)),
    missing,
    unexpected,
    // Intact means every expected constraint is present. Extra constraints are reported but do
    // not by themselves mean the schema is broken.
    intact: missing.length === 0,
  };
}

export interface DatabaseEvidence {
  environment: string;
  journalPresent: boolean;
  appliedFilenames: string[];
  appliedCount: number;
  expectedFilenames: string[];
  pendingFilenames: string[];
  checksumMismatches: string[];
  projectControlTablesPresent: string[];
  foreignKeys: ForeignKeyVerdict;
  contradictions: string[];
  available: boolean;
  errorCode: string | null;
}

/** The migration files this build carries — the repository half of the comparison. */
export function repositoryMigrations(dir = join(process.cwd(), "migrations")): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^\d{4,}_.+\.sql$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

const PC_TABLES = [
  "pc_nodes",
  "pc_work_packages",
  "pc_evidence",
  "pc_blockers",
  "pc_dependencies",
  "pc_deployments",
  "pc_test_runs",
  "pc_prompts",
  "pc_audit",
];

/**
 * Read the live schema. Read-only throughout: four SELECTs, no DDL, no writes.
 *
 * Every failure path returns `available: false` with a stable error code rather than throwing, so
 * a database blip degrades the evidence rather than the request.
 */
export async function collectDatabaseEvidence(
  db: EvidenceDb,
  env: NodeJS.ProcessEnv = process.env,
  migrationsDir?: string
): Promise<DatabaseEvidence> {
  const environment = resolveEnvironmentName(env);
  const expectedFilenames = repositoryMigrations(migrationsDir);

  const empty: DatabaseEvidence = {
    environment,
    journalPresent: false,
    appliedFilenames: [],
    appliedCount: 0,
    expectedFilenames,
    // NOT expectedFilenames. "We could not look" must never render as "everything is outstanding".
    pendingFilenames: [],
    checksumMismatches: [],
    projectControlTablesPresent: [],
    foreignKeys: { expected: EXPECTED_PC_FOREIGN_KEYS.length, present: [], missing: [], unexpected: [], intact: false },
    contradictions: [],
    available: false,
    errorCode: null,
  };

  try {
    const journal = await db.query(`SELECT to_regclass('public.schema_migrations') AS reg`);
    const journalPresent = Boolean((journal.rows[0] as { reg: string | null })?.reg);

    let appliedFilenames: string[] = [];
    let checksumMismatches: string[] = [];
    if (journalPresent) {
      const applied = await db.query(
        `SELECT filename, status FROM schema_migrations ORDER BY filename`
      );
      const rows = applied.rows as { filename: string; status: string }[];
      appliedFilenames = rows.filter((r) => r.status === "applied").map((r) => r.filename);
      // A row that exists but is not 'applied' is a crashed or half-run migration — a real
      // contradiction, not a pending file.
      checksumMismatches = rows.filter((r) => r.status !== "applied").map((r) => r.filename);
    }

    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [PC_TABLES]
    );
    const projectControlTablesPresent = (tables.rows as { table_name: string }[]).map((r) => r.table_name);

    const fkRows = await db.query(
      `SELECT conname FROM pg_constraint WHERE contype='f' AND conname LIKE 'fk\\_pc\\_%' ORDER BY conname`
    );
    const foreignKeys = verifyForeignKeys((fkRows.rows as { conname: string }[]).map((r) => r.conname));

    const pendingFilenames = expectedFilenames.filter((f) => !appliedFilenames.includes(f));

    const contradictions: string[] = [];
    if (!journalPresent && projectControlTablesPresent.length > 0) {
      // Tables exist that only a migration creates, yet there is no ledger saying so. Something
      // applied schema outside the runner, and the journal cannot be trusted here.
      contradictions.push(
        "Project Control tables exist but there is no migration journal — schema was applied outside the runner."
      );
    }
    if (projectControlTablesPresent.length > 0 && !foreignKeys.intact) {
      contradictions.push(
        `Project Control tables are present but ${foreignKeys.missing.length} expected foreign key(s) are missing: ${foreignKeys.missing.join(", ")}.`
      );
    }
    if (checksumMismatches.length > 0) {
      contradictions.push(`Journal rows not in 'applied' state: ${checksumMismatches.join(", ")}.`);
    }

    return {
      environment,
      journalPresent,
      appliedFilenames,
      appliedCount: appliedFilenames.length,
      expectedFilenames,
      pendingFilenames,
      checksumMismatches,
      projectControlTablesPresent,
      foreignKeys,
      contradictions,
      available: true,
      errorCode: null,
    };
  } catch {
    // Deliberately no error text: a driver error can carry a DSN, and this value is destined for
    // a browser. A stable code is enough for an operator to act on.
    return { ...empty, errorCode: "database_evidence_unavailable" };
  }
}

export type DatabaseOutcome =
  | { started: true; syncId: string }
  | { started: false; reason: "already_running"; syncId: string }
  /** Environment unnameable, so nothing was written and the run is already closed UNAVAILABLE. */
  | { started: false; reason: "unknown_environment"; syncId: string };

/** Collect and persist database evidence for the connected environment. */
export async function collectAndStoreDatabaseEvidence(
  db: DatabaseDb,
  input: { triggerType: "manual" | "scheduled" | "startup"; actor?: string | null } = { triggerType: "manual" },
  env: NodeJS.ProcessEnv = process.env,
  migrationsDir?: string
): Promise<DatabaseOutcome> {
  const environment = resolveEnvironmentName(env);
  await expireAbandonedRuns(db, DATABASE_SOURCE);

  const active = await getActiveRun(db, DATABASE_SOURCE);
  if (active) return { started: false, reason: "already_running", syncId: active.syncId };

  const syncId = await createRun(db, {
    sourceType: DATABASE_SOURCE,
    triggerType: input.triggerType,
    target: environment,
    actor: input.actor ?? null,
    environment,
    workerIdentity: workerIdentity(env),
  });

  /**
   * FAIL CLOSED when the environment cannot be named — see the same guard in probe-persistence.ts.
   *
   * Database evidence is the most damaging kind to mislabel: "migration 0039 is applied" filed
   * under the wrong estate is exactly the sentence that would authorise a deploy against a
   * database that has not been migrated.
   */
  if (!mayWriteLabelledEvidence(environment)) {
    await completeRun(db, syncId, "UNAVAILABLE", { errorCode: "unknown_environment" });
    // NOT `started: true` — the run is already closed. Reporting it as started told the operator
    // a refresh had begun when nothing would ever be written.
    return { started: false, reason: "unknown_environment", syncId };
  }

  const outcome = await withLease(db, DATABASE_SOURCE, syncId, async () => {
    await markRunning(db, syncId);
    const evidence = await collectDatabaseEvidence(db, env, migrationsDir);

    await withTransaction(db, async (tx) => {
      await insertSnapshot(tx, {
        sourceType: DATABASE_SOURCE,
        environment,
        entityType: "migration_ledger",
        entityId: environment,
        status: evidence.available ? (evidence.contradictions.length > 0 ? "contradictory" : "ok") : "unavailable",
        // A contradiction is a real, usable observation — it says something true and alarming
        // about the schema. Only an unreadable database is UNAVAILABLE.
        freshness: evidence.available
          ? evidence.contradictions.length > 0
            ? "CONTRADICTORY"
            : "CURRENT"
          : "UNAVAILABLE",
        validUntil: evidence.available ? new Date(Date.now() + DATABASE_VALID_MS) : null,
        staleReason: evidence.available ? null : "The database could not be read; migration state is UNKNOWN here.",
        syncId,
        payload: {
          journalPresent: evidence.journalPresent,
          appliedCount: evidence.appliedCount,
          appliedFilenames: evidence.appliedFilenames.slice(0, 100),
          pendingFilenames: evidence.pendingFilenames.slice(0, 100),
          checksumMismatches: evidence.checksumMismatches,
          projectControlTablesPresent: evidence.projectControlTablesPresent,
          foreignKeys: evidence.foreignKeys,
          contradictions: evidence.contradictions,
        },
      });
    });

    await completeRun(db, syncId, evidence.available ? "SUCCEEDED" : "UNAVAILABLE", {
      counts: { applied: evidence.appliedCount, pending: evidence.pendingFilenames.length },
      errorCode: evidence.errorCode,
    });
  });

  if (!outcome.ran) {
    await completeRun(db, syncId, "CANCELLED", { errorCode: "lease_held_elsewhere" });
  }
  return { started: true, syncId };
}
