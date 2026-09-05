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
import { toDirectEndpoint } from "./read-only-session";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { lintSql, isApprovedDestructiveFinding, unapprovedBlockingFindings } from "./lint-destructive-sql";
import { securePostgresPoolConnection } from "../../server/lib/postgres-transport-security";
import type pg from "pg";

export type MigrationEstate = "main" | "vault-quest";

export function migrationProfile(estate: MigrationEstate = "main") {
  if (estate !== "main" && estate !== "vault-quest") {
    throw new Error("Migration estate must be main or vault-quest.");
  }
  const directory = estate === "main" ? "migrations" : "migrations-vq";
  const entry = process.argv[1] ?? "";
  return {
    estate,
    migrationsDir:
      basename(entry) === "migrate.cjs" ? join(dirname(entry), "..", directory) : join(process.cwd(), directory),
    journalTable: estate === "main" ? "schema_migrations" : "vq_schema_migrations",
    advisoryLockKey: estate === "main" ? 4_150_205 : 4_150_206,
  } as const;
}

/** Closed choice, validated before resolving credentials or opening a connection. */
export function parseMigrationEstate(args: string[]): MigrationEstate {
  const flags = args.filter((arg) => arg === "--estate" || arg.startsWith("--estate="));
  if (flags.length === 0) return "main";
  if (flags.length !== 1 || flags[0] !== "--estate") {
    throw new Error("Specify --estate main or --estate vault-quest exactly once.");
  }
  const value = args[args.indexOf("--estate") + 1];
  if (value !== "main" && value !== "vault-quest") {
    throw new Error("Migration estate must be main or vault-quest.");
  }
  return value;
}

const MIGRATIONS_DIR = migrationProfile().migrationsDir;
const FILE_RE = /^(\d{4,})_.+\.sql$/;

function approvedDestructiveSuffix(filename: string): string {
  if (filename === "0094_scanner_capture_physical_release.sql") return " (approved protected index replacement)";
  if (filename === "0096_partner_card_job_void_management_audit.sql") {
    return " (approved protected constraint replacement)";
  }
  return " (approved protected migration replacement)";
}

/**
 * The migration runner MUST own a dedicated backend for the whole run.
 *
 * WHY (hostile review, 2026-07-25): `pg_try_advisory_lock` is SESSION-scoped, and session
 * advisory locks are RE-ENTRANT for the same session. `MINTVAULT_DATABASE_URL` points at
 * Neon's `-pooler` host — PgBouncer in transaction mode — where two runner processes can be
 * multiplexed onto ONE server backend. The second runner's `pg_try_advisory_lock` would then
 * see the lock as held by its *own* session and return true, so the "refusing to run
 * concurrently" guard passes for BOTH and two runners apply migrations at once. A killed
 * runner also leaks the lock onto a shared backend, blocking every later runner until the
 * pooler recycles it.
 *
 * A SECOND hostile review proved the first version of this guard was bypassable and that a
 * hostname test can never be sufficient:
 *
 *  • `pg-connection-string` copies `host`, `port` and `options` QUERY PARAMETERS onto the
 *    connection config AFTER parsing the URL, so they override the URL's own hostname. The
 *    guard inspected one endpoint while the runner connected to another — and the log line
 *    then printed the safe-looking host, which is worse than silence. Those parameters are
 *    now REFUSED outright: a migration URL has no legitimate need for them.
 *  • Two runners sharing ONE pooled backend share `pg_backend_pid()`, so every pg_locks
 *    ownership branch passes for both. Pattern-matching hostnames cannot detect that.
 *    `assertDedicatedBackend` therefore MEASURES the property that actually matters.
 *
 * Fail closed everywhere: an unparseable URL, a pooler that cannot be rewritten, or a
 * routing parameter all refuse to run rather than proceed unproven.
 */
export function resolveMigrationEndpoint(url: string): { url: string; pooled: boolean; host: string } {
  // The EFFECTIVE target, as node-postgres will actually dial it — not merely the URL host.
  let effectiveHost: string;
  try {
    const u = new URL(url);
    // Routing overrides are refused rather than interpreted. `host`/`port` change the target
    // outright; Neon's `options=endpoint=...` re-routes at the SNI layer. Any of them would
    // make this guard inspect something the runner does not connect to.
    for (const param of ["host", "port", "options", "servername"]) {
      if (u.searchParams.has(param)) {
        throw new Error(
          `Refusing to run migrations: the database URL carries a '${param}' parameter, which overrides the ` +
            "endpoint this guard validates. Remove it so the connection target is unambiguous."
        );
      }
    }
    effectiveHost = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Refusing to run migrations")) throw e;
    // Fail CLOSED on an unparseable URL — the same policy as classifyDbHost in
    // scripts/db/db-host-policy.ts. Previously this returned pooled:false and proceeded.
    throw new Error("Refusing to run migrations: the database URL did not parse, so its endpoint cannot be verified.");
  }
  const looksPooled = /-pooler(?=\.)/i.test(effectiveHost) || /\.pooler(?=\.)/i.test(effectiveHost);
  if (!looksPooled) return { url, pooled: false, host: effectiveHost };
  const direct = toDirectEndpoint(url);
  if (!direct.changed) {
    throw new Error(
      "Refusing to run migrations through a connection pooler: the direct (non-pooler) endpoint " +
        "could not be derived, so single-runner concurrency cannot be guaranteed."
    );
  }
  let rewrittenHost: string;
  try {
    rewrittenHost = new URL(direct.url).hostname.toLowerCase();
  } catch {
    throw new Error("Refusing to run migrations: the rewritten direct endpoint did not parse.");
  }
  return { url: direct.url, pooled: false, host: rewrittenHost };
}

/**
 * POSITIVE proof that this connection owns a dedicated backend.
 *
 * A hostname heuristic cannot see backend SHARING, which is the actual double-apply vector:
 * two runners multiplexed onto one PgBouncer server connection share `pg_backend_pid()`, so
 * every advisory-lock ownership check passes for both. This measures it instead — a second
 * independent connection on the same URL MUST land on a different backend. The incident
 * evidence is exactly this shape: 8 pooler clients shared 1 backend PID, while 4
 * direct-endpoint clients got 4 distinct PIDs.
 *
 * Works regardless of how the endpoint was specified, so it also covers poolers this code
 * cannot recognise by name (a PgBouncer sidecar, a CNAME, a non-Neon provider).
 */
/**
 * The comparison at the heart of the dedicated-backend proof, exported so it can be pinned
 * exhaustively without needing a real PgBouncer in the test environment.
 * Two independent connections MUST land on different server backends.
 */
export function assertNotSharedBackend(ownPid: number, probePid: number): void {
  if (!Number.isFinite(ownPid) || !Number.isFinite(probePid)) {
    throw new Error("Refusing to run migrations: could not verify that this connection owns a dedicated backend.");
  }
  if (ownPid === probePid) {
    throw new Error(
      `Refusing to run migrations: this connection shares its server backend (pid ${ownPid}) with another ` +
        "session, which means a connection pooler is multiplexing it. A session advisory lock cannot " +
        "guarantee a single runner in that configuration."
    );
  }
}

export async function assertDedicatedBackend(
  connectionString: string,
  ownPid: number,
  // Backwards-compatible test call shape only. Caller SSL is never authority;
  // every probe re-derives strict transport from the canonical URL.
  _ignoredLegacySsl?: unknown
): Promise<void> {
  const { Client } = await import("pg");
  const probe = new Client(migrationClientConfig(connectionString));
  probe.on("error", () => {
    /* a probe failure is reported by the awaited query below */
  });
  await probe.connect();
  try {
    const r = await probe.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const probePid = Number(r.rows[0]?.pid);
    if (!Number.isFinite(probePid)) {
      throw new Error("Refusing to run migrations: could not verify that this connection owns a dedicated backend.");
    }
    assertNotSharedBackend(ownPid, probePid);
  } finally {
    try {
      await probe.end();
    } catch {
      /* nothing can leak through a closed connection */
    }
  }
}

export function migrationClientConfig(connectionString: string): pg.ClientConfig {
  return {
    ...securePostgresPoolConnection(connectionString, "MINTVAULT_DATABASE_URL"),
    connectionTimeoutMillis: 20_000,
  };
}

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

function journalDdl(estate: MigrationEstate): string {
  const { journalTable } = migrationProfile(estate);
  return `
CREATE TABLE IF NOT EXISTS ${journalTable} (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'applied',
  applied_by TEXT NOT NULL DEFAULT current_user
);
ALTER TABLE ${journalTable} ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE ${journalTable} ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE ${journalTable} ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied';`;
}

interface PgClientLike {
  query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function ensureJournal(client: PgClientLike, estate: MigrationEstate): Promise<void> {
  await client.query(journalDdl(estate));
}

interface JournalRow {
  checksum: string;
  status: string;
}

async function journalExists(client: PgClientLike, estate: MigrationEstate): Promise<boolean> {
  const { journalTable } = migrationProfile(estate);
  const { rows } = await client.query(`SELECT to_regclass('public.${journalTable}') AS reg`);
  return rows[0]?.reg != null;
}

/**
 * Read-only journal read. If the journal table does not exist yet, returns an empty map
 * WITHOUT creating it — so planMigrations (dry-run) never mutates the database.
 */
async function journalMap(client: PgClientLike, estate: MigrationEstate): Promise<Map<string, JournalRow>> {
  const { journalTable } = migrationProfile(estate);
  const m = new Map<string, JournalRow>();
  if (!(await journalExists(client, estate))) return m;
  const { rows } = await client.query(`SELECT filename, checksum, status FROM ${journalTable}`);
  for (const r of rows) m.set(String(r.filename), { checksum: String(r.checksum), status: String(r.status) });
  return m;
}

export interface MigratePlan {
  pending: string[];
  alreadyApplied: string[];
  checksumMismatches: { filename: string; storedChecksum: string; currentChecksum: string }[];
  inconsistent: { filename: string; status: string }[]; // rows left in a non-'applied' state
  destructive: { filename: string; findings: ReturnType<typeof lintSql> }[];
  /**
   * EVERY filename the journal already holds, not just the ones this release ships.
   * The migration identity guard needs the full set: a colliding historical
   * migration is by definition one this release does NOT contain, so it can only be
   * seen by reading the journal itself.
   */
  journalFilenames: string[];
}

/** Read-only planning: never mutates the database (does not create the journal table). */
export async function planMigrations(
  client: PgClientLike,
  files: MigrationFile[],
  estate: MigrationEstate = "main"
): Promise<MigratePlan> {
  const journal = await journalMap(client, estate);
  const plan: MigratePlan = {
    pending: [],
    alreadyApplied: [],
    checksumMismatches: [],
    inconsistent: [],
    destructive: [],
    journalFilenames: [...journal.keys()],
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

/**
 * LINEAGE EXCLUSION DECLARATIONS (owner-authorised mechanism, 2026-08-14).
 *
 * The migration identity guard fails closed when a pending file's number is already
 * occupied in the journal by a DIFFERENT filename. That is correct — but on a host whose
 * journal carries another lineage's identity at that number (staging holds its own
 * 0044/0046/0047 while this release ships production's), the colliding release files can
 * NEVER legitimately apply there, and the guard's own remedy says to "exclude the
 * colliding file from this environment". This is that exclusion, made explicit and
 * fail-closed rather than manual and per-invocation:
 *
 *  - A declaration names the EXACT (incoming, occupant) pair. It matches only on a host
 *    whose journal holds precisely that occupant at the incoming file's number. A new,
 *    undeclared collision still aborts the whole run, exactly as before.
 *  - Every declaration must name a `supersededBy` migration that exists in this release —
 *    the forward-only convergence file that delivers (or verifies) the excluded content
 *    at a globally free number. A declaration whose superseder is absent is VOID and the
 *    conflict aborts.
 *  - An excluded file is never applied and never journalled on that host; it is reported
 *    loudly instead. Applied history stays immutable everywhere.
 */
export interface LineageExclusion {
  /** Release filename that must not apply where `occupant` holds its number. */
  incoming: string;
  /** The journalled filename that immutably occupies the number on that host. */
  occupant: string;
  /** Convergence migration (present in this release) that carries/verifies the content. */
  supersededBy: string;
  /** Human explanation, printed whenever the exclusion is exercised. */
  reason: string;
}

export function loadLineageExclusions(dir: string = MIGRATIONS_DIR): LineageExclusion[] {
  const path = join(dir, "lineage-exclusions.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // no declarations file — every identity conflict aborts, as before
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`migrations/lineage-exclusions.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("migrations/lineage-exclusions.json must be a JSON array of declarations.");
  }
  const out: LineageExclusion[] = [];
  for (const [i, entry] of parsed.entries()) {
    const e = entry as Record<string, unknown>;
    for (const key of ["incoming", "occupant", "supersededBy", "reason"] as const) {
      if (typeof e[key] !== "string" || (e[key] as string).trim() === "") {
        throw new Error(`lineage-exclusions.json entry ${i}: '${key}' must be a non-empty string.`);
      }
    }
    const incoming = e.incoming as string;
    const occupant = e.occupant as string;
    if (incoming === occupant) {
      throw new Error(`lineage-exclusions.json entry ${i}: incoming and occupant must differ (${incoming}).`);
    }
    if (!FILE_RE.test(incoming) || !FILE_RE.test(occupant)) {
      throw new Error(`lineage-exclusions.json entry ${i}: filenames must match NNNN_name.sql.`);
    }
    if (incoming.match(FILE_RE)![1] !== occupant.match(FILE_RE)![1]) {
      throw new Error(
        `lineage-exclusions.json entry ${i}: incoming and occupant must share one number ` +
          `(${incoming} vs ${occupant}) — an exclusion only resolves a same-number collision.`
      );
    }
    out.push({ incoming, occupant, supersededBy: e.supersededBy as string, reason: e.reason as string });
  }
  return out;
}

export interface IdentityConflictPartition {
  /** Conflicts with no valid declaration — these abort the run. */
  undeclared: { number: string; incoming: string; applied: string }[];
  /** Declared conflicts — these files are excluded from application on this host. */
  excluded: { number: string; incoming: string; applied: string; declaration: LineageExclusion }[];
}

export function partitionIdentityConflicts(
  pending: string[],
  journalFilenames: string[],
  files: MigrationFile[],
  exclusions: LineageExclusion[]
): IdentityConflictPartition {
  const journalByNumber = new Map<number, string>();
  for (const journalledName of journalFilenames) {
    const m = journalledName.match(FILE_RE);
    if (m) journalByNumber.set(Number(m[1]), journalledName);
  }
  const partition: IdentityConflictPartition = { undeclared: [], excluded: [] };
  for (const filename of pending) {
    const m = filename.match(FILE_RE);
    if (!m) continue;
    const occupant = journalByNumber.get(Number(m[1]));
    if (!occupant || occupant === filename) continue;
    const conflict = { number: m[1], incoming: filename, applied: occupant };
    const declaration = exclusions.find((d) => d.incoming === filename && d.occupant === occupant);
    // A declaration is only valid when its convergence migration ships in THIS release.
    if (declaration && files.some((f) => f.filename === declaration.supersededBy)) {
      partition.excluded.push({ ...conflict, declaration });
    } else {
      partition.undeclared.push(conflict);
    }
  }
  return partition;
}

export async function applyMigrations(
  client: PgClientLike,
  files: MigrationFile[],
  opts: { allowDestructive?: boolean; exclusions?: LineageExclusion[]; estate?: MigrationEstate } = {}
): Promise<{ applied: string[] }> {
  const { estate, journalTable, advisoryLockKey } = migrationProfile(opts.estate);
  if (estate === "vault-quest" && opts.exclusions?.length) {
    throw new Error("Vault Quest does not accept main-lineage exclusion declarations.");
  }
  // Serialise concurrent runners: a second runner fails fast instead of double-applying.
  // Capture the backend identity FIRST, so lock ownership can be proven against a specific
  // server process rather than assumed from a boolean.
  const pidRow = await client.query("SELECT pg_backend_pid() AS pid");
  const ownerPid = Number((pidRow.rows[0] as { pid: number | string } | undefined)?.pid);
  if (!Number.isFinite(ownerPid)) {
    throw new Error("Could not determine the migration runner's backend PID. Refusing to run.");
  }
  const lockRes = await client.query("SELECT pg_try_advisory_lock($1) AS got", [advisoryLockKey]);
  if (lockRes.rows[0]?.got !== true) {
    throw new Error("Another migration runner holds the advisory lock. Refusing to run concurrently.");
  }
  /**
   * Prove THIS backend holds the lock, on the CORRECT database. A session advisory lock is
   * re-entrant, so `got === true` alone does not prove exclusivity when the connection could
   * be shared by a pooler — this reads pg_locks and fails closed if the lock is not held by
   * our own PID, or if our PID has changed (a replaced/recycled connection).
   */
  const assertLockOwned = async (stage: string): Promise<void> => {
    const r = await client.query(
      // Precise encoding: PostgreSQL stores a SINGLE-bigint advisory key as
      // classid = high32, objid = low32, objsubid = 1 (the two-int form uses objsubid = 2).
      // Without classid/objsubid an UNRELATED two-int lock sharing the low word matches;
      // without the database filter a lock held in ANOTHER database of the same cluster
      // matches. Either corrupts the "is my lock still held" signal.
      `SELECT l.pid, pg_backend_pid() AS current_pid
         FROM pg_locks l
        WHERE l.locktype = 'advisory'
          AND l.classid = 0 AND l.objid = $1 AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.granted`,
      [advisoryLockKey]
    );
    const rows = r.rows as unknown as { pid: number; current_pid: number }[];
    const currentPid = Number(rows[0]?.current_pid ?? NaN);
    if (rows.length === 0) {
      throw new Error(`Migration advisory lock is no longer held (${stage}). Refusing to continue.`);
    }
    if (Number.isFinite(currentPid) && currentPid !== ownerPid) {
      throw new Error(
        `Migration connection was replaced (${stage}): backend PID changed ${ownerPid} -> ${currentPid}. ` +
          "The advisory lock can no longer be proven exclusive. Refusing to continue."
      );
    }
    if (!rows.some((x) => Number(x.pid) === ownerPid)) {
      throw new Error(`Migration advisory lock is not held by this runner (${stage}). Refusing to continue.`);
    }
  };
  await assertLockOwned("after acquire");
  try {
    await ensureJournal(client, estate); // create/upgrade the journal only on the apply path (never on dry-run)
    const plan = await planMigrations(client, files, estate);
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
    /**
     * MIGRATION IDENTITY GUARD (owner-authorised, 2026-08-11).
     *
     * The duplicate-number check in listMigrationFiles() only compares files WITHIN
     * one release. It cannot see that this database already applied a DIFFERENT
     * migration at the same numeric slot, because the journal's key is `filename`
     * and numbers are used only for sort order. So a release whose 0046 is
     * `partner_mfa_pending_lifecycle` applied cleanly to a database whose 0046 is
     * `scanner_processing_jobs`: the filename was simply absent from the journal,
     * the runner treated it as new, and the database ended up holding two different
     * migrations at 0046 — permanently ambiguous, and silently, because nothing
     * errored.
     *
     * That is exactly how MintVault ended up with three incompatible lineages
     * forking at 0045-0048 across production, staging and main.
     *
     * This guard fails closed BEFORE anything is applied: if a pending migration's
     * number is already occupied in the journal by a different filename, stop and
     * name both identities. It never rewrites, renames or deletes a journal row —
     * applied history stays immutable, which is the whole point. The forward-only
     * fix is to converge with a NEW migration at the next globally free number,
     * never to replay a colliding historical one.
     */
    const conflicts = partitionIdentityConflicts(plan.pending, plan.journalFilenames, files, opts.exclusions ?? []);
    if (conflicts.undeclared.length > 0) {
      throw new Error(
        "Migration identity conflict — this database already applied a DIFFERENT migration at the same number:\n" +
          conflicts.undeclared
            .map((c) => `  ${c.number}: applied '${c.applied}' vs release '${c.incoming}'`)
            .join("\n") +
          "\nApplying would leave two different migrations sharing one numeric slot. Applied history is immutable: " +
          "do NOT renumber or delete the applied row. Converge with a NEW forward migration at the next globally " +
          "free number instead, and exclude the colliding file from this environment via a declaration in " +
          "migrations/lineage-exclusions.json naming this exact (incoming, occupant) pair and the convergence " +
          "migration that supersedes it."
      );
    }
    if (conflicts.excluded.length > 0) {
      const excludedNames = new Set(conflicts.excluded.map((c) => c.incoming));
      for (const c of conflicts.excluded) {
        console.log(
          `[migrate] EXCLUDED on this database: ${c.incoming} — number ${c.number} is immutable history ` +
            `('${c.applied}'). Superseded by ${c.declaration.supersededBy}. ${c.declaration.reason}`
        );
      }
      plan.pending = plan.pending.filter((n) => !excludedNames.has(n));
      plan.destructive = plan.destructive.filter((d) => !excludedNames.has(d.filename));
    }
    const byName = new Map(files.map((f) => [f.filename, f]));
    if (!opts.allowDestructive) {
      const blocking = plan.destructive.filter((d) => {
        const sql = byName.get(d.filename)?.sql ?? "";
        return unapprovedBlockingFindings(d.filename, sql, d.findings).length > 0;
      });
      if (blocking.length > 0) {
        throw new Error(
          `Destructive SQL detected in pending migration(s): ${blocking
            .map((d) => d.filename)
            .join(", ")}. Re-run with --allow-destructive only with owner approval.`
        );
      }
    }
    const applied: string[] = [];
    for (const filename of plan.pending) {
      // Re-prove exclusivity before EVERY file. If the connection were ever replaced or
      // recycled mid-run (the pooled-multiplexing hazard), the run stops between files
      // rather than applying the remainder without a provable lock.
      await assertLockOwned(`before ${filename}`);
      const f = byName.get(filename)!;
      if (f.noTransaction) {
        // Non-transactional migration (e.g. CREATE INDEX CONCURRENTLY): cannot run in a txn.
        // Record intent, run, then mark complete. Must be individually idempotent.
        await client.query(
          `INSERT INTO ${journalTable} (filename, checksum, status) VALUES ($1,$2,'applying') ON CONFLICT (filename) DO UPDATE SET status='applying', started_at=now()`,
          [f.filename, f.checksum]
        );
        try {
          await applyNonTransactionalMigration(client, f);
          await client.query(`UPDATE ${journalTable} SET status='applied', completed_at=now() WHERE filename=$1`, [
            f.filename,
          ]);
        } catch (e) {
          await client.query(`UPDATE ${journalTable} SET status='failed' WHERE filename=$1`, [f.filename]);
          throw new Error(`Non-transactional migration ${f.filename} failed: ${(e as Error).message}`);
        }
      } else {
        await client.query("BEGIN");
        try {
          await client.query(f.sql);
          await client.query(
            `INSERT INTO ${journalTable} (filename, checksum, status, completed_at) VALUES ($1,$2,'applied',now())`,
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
    await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
  }
}

function isMain(): boolean {
  const entry = process.argv[1] ? basename(process.argv[1]) : "";
  return entry === "migrate.ts" || entry === "migrate.cjs";
}

export function redactMigrationErrorMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted-postgres-url]")
    .replace(/MINTVAULT_DATABASE_URL=([^\s"'<>]+)/g, "MINTVAULT_DATABASE_URL=[redacted]");
}

/**
 * SCOPED CONVERGENCE MODE — apply EXACTLY ONE named migration.
 *
 * WHY THIS EXISTS. MintVault's migration history forked: production, staging and
 * main each applied different migrations into the same numeric slots, and the same
 * MFA lifecycle migration exists under TWO immutable identities (0044 on production,
 * 0046 on staging). The ordinary runner is all-or-nothing by design — against
 * production it plans SEVEN historical files nobody may replay before it ever
 * reaches the forward convergence migration, and the identity guard then correctly
 * refuses the whole run. So there is no safe way to deliver 0073 with the default
 * mode, and the two wrong ways out are both forbidden: renumbering applied
 * migrations, or forging journal rows to make the runner believe history it did not
 * execute.
 *
 * This mode is the third way: run the ONE forward migration, record it honestly,
 * and leave every historical identity exactly as it is.
 *
 * IT IS NOT A SHORTCUT, AND IT MUST NOT BECOME ONE. It keeps every safety property
 * of the normal path — advisory lock, dedicated backend, checksum verification,
 * destructive-SQL lint, atomic journal write — and adds two the normal path does not
 * need: an exact-filename requirement (no wildcard, no number-only, no "and
 * everything before it"), and a journal-fingerprint re-check immediately before
 * execution, because production's journal demonstrably moved twice in one day while
 * another operator worked. It requires an explicit acknowledgement flag so it can
 * never be reached by habit.
 */
export interface ScopedMigrationResult {
  applied: boolean;
  reason?: string;
  filename: string;
  checksum: string;
  journalBefore: number;
  journalAfter: number;
}

/** Stable fingerprint of the journal, used to detect a concurrent operator. */
async function journalFingerprint(
  client: PgClientLike,
  estate: MigrationEstate
): Promise<{ count: number; fingerprint: string }> {
  const { journalTable } = migrationProfile(estate);
  const { rows } = await client.query(
    `SELECT count(*)::int AS count,
            coalesce(md5(string_agg(filename || ':' || checksum, '|' ORDER BY filename)), 'empty') AS fingerprint
       FROM ${journalTable}`
  );
  const r = rows[0] as { count: number; fingerprint: string };
  return { count: Number(r.count), fingerprint: r.fingerprint };
}

export async function applyScopedMigration(
  client: PgClientLike,
  targetFilename: string,
  opts: {
    files?: MigrationFile[];
    allowDestructive?: boolean;
    log?: (m: string) => void;
    estate?: MigrationEstate;
  } = {}
): Promise<ScopedMigrationResult> {
  const { estate, journalTable, advisoryLockKey, migrationsDir } = migrationProfile(opts.estate);
  const log = opts.log ?? (() => {});
  const files = opts.files ?? listMigrationFiles(migrationsDir);

  // (1) EXACT filename. No wildcard, no number-only, no prefix matching — an
  // ambiguous target is exactly how a convergence tool becomes a footgun.
  if (!FILE_RE.test(targetFilename)) {
    throw new Error(`Scoped migration target must be an exact NNNN_name.sql filename, got '${targetFilename}'.`);
  }
  const target = files.find((f) => f.filename === targetFilename);
  if (!target) {
    throw new Error(`Scoped migration target '${targetFilename}' does not exist in the migrations directory.`);
  }

  if (!(await journalExists(client, estate))) {
    throw new Error(
      `Scoped migration refuses to run: this database has no ${journalTable} journal. ` +
        "Scoped mode converges an EXISTING lineage; it is not a bootstrap path."
    );
  }

  const before = await journalFingerprint(client, estate);
  const journal = await journalMap(client, estate);

  // (3) Already applied under this exact identity → no-op, never a second execution.
  const existing = journal.get(target.filename);
  if (existing) {
    if (existing.status !== "applied") {
      throw new Error(
        `Scoped migration refuses to run: '${target.filename}' is in the journal with status '${existing.status}' ` +
          "(a crashed run). Resolve it manually before proceeding."
      );
    }
    // (2) Checksum must match the release artifact even on the no-op path, so a
    // silently edited migration is caught rather than reported as "already done".
    if (existing.checksum !== target.checksum) {
      throw new Error(
        `Scoped migration refuses to run: '${target.filename}' is already applied with a DIFFERENT checksum. ` +
          "The file was edited after being applied. Refusing to proceed."
      );
    }
    log(`[scoped] '${target.filename}' is already applied with a matching checksum — nothing to do.`);
    return {
      applied: false,
      reason: "already_applied",
      filename: target.filename,
      checksum: target.checksum,
      journalBefore: before.count,
      journalAfter: before.count,
    };
  }

  // (4) Numeric identity: the target's own number must not already be occupied by a
  // DIFFERENT migration. Historical collisions elsewhere in the journal are
  // deliberately IGNORED here — they are precisely why this mode exists, and they
  // are not this migration's problem. Only a collision on the TARGET is unsafe.
  const targetNumber = Number(target.filename.match(FILE_RE)![1]);
  for (const journalledName of journal.keys()) {
    const m = journalledName.match(FILE_RE);
    if (!m) continue;
    if (Number(m[1]) === targetNumber && journalledName !== target.filename) {
      throw new Error(
        `Scoped migration refuses to run: number ${String(targetNumber).padStart(4, "0")} is already occupied by a ` +
          `DIFFERENT migration in this database ('${journalledName}'). Applying '${target.filename}' would put two ` +
          "migrations in one numeric slot. Choose the next globally free number instead — applied history is immutable."
      );
    }
  }

  // (5)/(2) Destructive-SQL lint, same gate and same opt-in as the normal path.
  const findings = lintSql(target.sql);
  for (const f of findings) {
    const approved = isApprovedDestructiveFinding(target.filename, target.sql, f);
    log(
      `${approved ? "✅" : f.severity === "block" ? "🚫" : "⚠️ "} ` +
        `${target.filename}:${f.line} [${f.kind}] ${f.match}` +
        `${approved ? approvedDestructiveSuffix(target.filename) : ""}`
    );
  }
  if (!opts.allowDestructive && unapprovedBlockingFindings(target.filename, target.sql, findings).length > 0) {
    throw new Error(
      `Destructive SQL detected in '${target.filename}'. Re-run with --allow-destructive only with owner approval.`
    );
  }

  // (7)/(8) Serialise against any other migration operator. Production's journal
  // moved twice in one day while another operator worked the backlog, so this is a
  // real condition, not a theoretical one.
  const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [advisoryLockKey]);
  if ((lock.rows[0] as { ok: boolean } | undefined)?.ok !== true) {
    throw new Error(
      "Scoped migration refuses to run: another migration runner holds the advisory lock. Do not race it."
    );
  }

  try {
    // (9) THE RACE CHECK. Re-read the journal under the lock and require it to be
    // byte-identical to the pre-flight read. If another operator applied anything
    // between planning and execution, the plan is stale — abort rather than act on it.
    const underLock = await journalFingerprint(client, estate);
    if (underLock.fingerprint !== before.fingerprint || underLock.count !== before.count) {
      throw new Error(
        `Scoped migration refuses to run: the journal changed between pre-flight and execution ` +
          `(${before.count} -> ${underLock.count} entries). Another operator is migrating this database. Re-run pre-flight.`
      );
    }

    log(`[scoped] applying ONLY ${target.filename} (checksum ${target.checksum.slice(0, 12)}…)`);
    // (10) Exactly one file, atomically, with its journal row.
    await client.query("BEGIN");
    try {
      await client.query(target.sql);
      await client.query(
        `INSERT INTO ${journalTable} (filename, checksum, completed_at, status) VALUES ($1,$2,now(),'applied')`,
        [target.filename, target.checksum]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Scoped migration '${target.filename}' failed and was rolled back: ${(e as Error).message}`);
    }

    const after = await journalFingerprint(client, estate);
    log(`[scoped] journal ${before.count} -> ${after.count} entries`);
    return {
      applied: true,
      filename: target.filename,
      checksum: target.checksum,
      journalBefore: before.count,
      journalAfter: after.count,
    };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]).catch(() => {});
  }
}

export function resolveMigrationDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MINTVAULT_MIGRATION_DATABASE_URL) return env.MINTVAULT_MIGRATION_DATABASE_URL;

  const fallback = env.MINTVAULT_DATABASE_URL;
  const mode = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (!fallback || (mode !== "test" && mode !== "development")) {
    throw new Error(
      "MINTVAULT_MIGRATION_DATABASE_URL is required; the production web runtime credential is never migration authority."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(fallback);
  } catch {
    throw new Error("The local MINTVAULT_DATABASE_URL migration fallback must be a valid PostgreSQL URL.");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !loopback) {
    throw new Error(
      "MINTVAULT_DATABASE_URL may substitute for migration authority only in test/development on exact loopback."
    );
  }
  return fallback;
}

async function main(): Promise<void> {
  const estate = parseMigrationEstate(process.argv.slice(2));
  const { migrationsDir } = migrationProfile(estate);
  let url: string;
  try {
    url = resolveMigrationDatabaseUrl();
  } catch (error) {
    console.error(`🚫 ${(error as Error).message}`);
    process.exit(2);
    return;
  }
  const apply = process.argv.includes("--apply");
  const allowDestructive = process.argv.includes("--allow-destructive");
  const { Client } = await import("pg");
  // The lock-owning session must be a dedicated backend — see resolveMigrationEndpoint.
  // Throws rather than falling back to a pooled connection.
  let endpoint: { url: string; pooled: boolean };
  try {
    endpoint = resolveMigrationEndpoint(url);
  } catch (e) {
    console.error(`🚫 ${(e as Error).message}`);
    process.exit(2);
    return;
  }
  const client = new Client(migrationClientConfig(endpoint.url));
  try {
    await client.connect();
    const pid = Number((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    await assertDedicatedBackend(endpoint.url, pid);
  } catch (e) {
    // No silent pooled fallback: a migration that cannot prove single-runner exclusivity
    // must not run at all.
    console.error(
      `🚫 Could not connect to the migration endpoint (${(e as Error).message}). ` +
        "Refusing to fall back to a pooled connection."
    );
    process.exit(2);
    return;
  }
  {
    const h = (() => {
      try {
        return new URL(endpoint.url).hostname;
      } catch {
        return "unknown";
      }
    })();
    console.log(`[migrate] lock-owning endpoint: ${h}`);
  }
  try {
    // ── SCOPED CONVERGENCE MODE ────────────────────────────────────────────────
    // Deliberately verbose to invoke and impossible to reach by habit: it needs an
    // exact filename AND an explicit acknowledgement that this is a convergence /
    // recovery action, not routine migration.
    const onlyIdx = process.argv.indexOf("--only");
    if (onlyIdx !== -1) {
      const targetFilename = process.argv[onlyIdx + 1];
      if (!targetFilename || targetFilename.startsWith("--")) {
        console.error("🚫 --only requires an exact migration filename, e.g. --only 0073_lineage_convergence.sql");
        process.exit(2);
        return;
      }
      if (!process.argv.includes("--convergence-mode")) {
        console.error(
          "🚫 --only also requires --convergence-mode.\n" +
            "   Scoped mode applies ONE migration and SKIPS the historical backlog. That is correct only when the\n" +
            "   lineage fork is already understood and documented. Acknowledge it explicitly."
        );
        process.exit(2);
        return;
      }
      const dbFingerprint = await (async () => {
        try {
          const r = await client.query("SELECT current_database() AS db, inet_server_addr()::text AS addr");
          const row = r.rows[0] as { db: string; addr: string | null };
          // Host comes from the endpoint we already resolved; never log credentials.
          const host = (() => {
            try {
              return new URL(endpoint.url).hostname;
            } catch {
              return "unknown";
            }
          })();
          return `${host}/${row.db}`;
        } catch {
          return "unknown";
        }
      })();
      console.log(`[scoped] target database : ${dbFingerprint}`);
      console.log(`[scoped] target migration: ${targetFilename}`);
      if (!apply) {
        const files = listMigrationFiles(migrationsDir);
        const t = files.find((f) => f.filename === targetFilename);
        if (!t) {
          console.error(`🚫 '${targetFilename}' does not exist in the migrations directory.`);
          process.exit(2);
          return;
        }
        const before = await journalFingerprint(client as unknown as PgClientLike, estate);
        console.log(`[scoped] checksum        : ${t.checksum}`);
        console.log(`[scoped] journal entries : ${before.count}`);
        console.log(`(dry-run) would apply ONLY ${targetFilename}. Re-run with --apply to execute.`);
        process.exit(0);
      }
      const result = await applyScopedMigration(client as unknown as PgClientLike, targetFilename, {
        estate,
        allowDestructive,
        log: (m) => console.log(m),
      });
      console.log(
        result.applied
          ? `✓ Applied ONLY ${result.filename} (journal ${result.journalBefore} -> ${result.journalAfter})`
          : `= No change: ${result.filename} (${result.reason})`
      );
      process.exit(0);
    }

    const files = listMigrationFiles(migrationsDir);
    const exclusions = estate === "main" ? loadLineageExclusions(migrationsDir) : [];
    const plan = await planMigrations(client as unknown as PgClientLike, files, estate);
    console.log(
      `Migrations: ${files.length} total, ${plan.alreadyApplied.length} applied, ${plan.pending.length} pending, ` +
        `${plan.inconsistent.length} inconsistent, ${plan.checksumMismatches.length} checksum-mismatch.`
    );
    {
      // Report declared exclusions in BOTH modes so a dry-run tells the truth about what
      // --apply will and will not run against this specific database.
      const preview = partitionIdentityConflicts(plan.pending, plan.journalFilenames, files, exclusions);
      for (const c of preview.excluded) {
        console.log(
          `[migrate] will EXCLUDE on this database: ${c.incoming} — number ${c.number} is immutable history ` +
            `('${c.applied}'). Superseded by ${c.declaration.supersededBy}.`
        );
      }
    }
    if (plan.inconsistent.length > 0) {
      console.error(`🚫 Journal inconsistent: ${plan.inconsistent.map((i) => `${i.filename}=${i.status}`).join(", ")}`);
      process.exit(1);
    }
    if (plan.checksumMismatches.length > 0) {
      console.error(`🚫 Checksum mismatches: ${plan.checksumMismatches.map((m) => m.filename).join(", ")}`);
      process.exit(1);
    }
    for (const d of plan.destructive) {
      const sql = files.find((f) => f.filename === d.filename)?.sql ?? "";
      for (const fd of d.findings) {
        const approved = isApprovedDestructiveFinding(d.filename, sql, fd);
        console.log(
          `${approved ? "✅" : fd.severity === "block" ? "🚫" : "⚠️ "} ${d.filename}:${fd.line} [${fd.kind}] ${fd.match}` +
            `${approved ? approvedDestructiveSuffix(d.filename) : ""}`
        );
      }
    }
    if (!apply) {
      console.log(`(dry-run) pending: ${plan.pending.join(", ") || "none"}. Re-run with --apply to execute.`);
      process.exit(0);
    }
    const { applied } = await applyMigrations(client as unknown as PgClientLike, files, {
      estate,
      allowDestructive,
      exclusions,
    });
    console.log(`✓ Applied ${applied.length}: ${applied.join(", ") || "none"}`);
  } finally {
    await client.end();
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(redactMigrationErrorMessage((err as Error).message || String(err)));
    process.exit(1);
  });
}
