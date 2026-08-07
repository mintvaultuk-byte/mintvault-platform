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
import { lintSql, hasBlocking } from "./lint-destructive-sql";

function defaultMigrationsDir(): string {
  const entry = process.argv[1] ?? "";
  return basename(entry) === "migrate.cjs"
    ? join(dirname(entry), "..", "migrations")
    : join(process.cwd(), "migrations");
}

const MIGRATIONS_DIR = defaultMigrationsDir();
const FILE_RE = /^(\d{4,})_.+\.sql$/;
// Fixed advisory-lock key for the migration runner (arbitrary constant, namespaced).
const ADVISORY_LOCK_KEY = 4_150_205; // "P0.5" mnemonic; any stable int works.

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
  let rewrittenHost = effectiveHost;
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
  ssl: { rejectUnauthorized: boolean } | undefined
): Promise<void> {
  const { Client } = await import("pg");
  const probe = new Client({ connectionString, ssl, connectionTimeoutMillis: 20_000 });
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

interface MigrationFile {
  number: string;
  filename: string;
  path: string;
  sql: string;
  checksum: string;
  noTransaction: boolean;
  /** Per-file override in milliseconds; 0 = wait forever. undefined = use the run default. */
  lockTimeoutMs?: number;
}

/**
 * Default `lock_timeout` for every migration file, in milliseconds.
 *
 * WHY (lock-safety review, 2026-08-07): the runner wraps each transaction-safe file in ONE
 * BEGIN..COMMIT, so every lock a file takes is held for the WHOLE FILE, not the statement.
 * Measured on a disposable PostgreSQL 17 cluster:
 *   - 0049 (grading bridge) takes ShareRowExclusive+Share on certificates/submissions/
 *     submission_items and 9 partner tables. Blocks WRITES only. 13 ms @ 3k rows,
 *     253 ms @ 600k, ~0.9-1.6 s @ 3M.
 *   - 0047 (RLS repair) takes ACCESS EXCLUSIVE on partner_owner_invariant_tenants (2.4-7.9 ms).
 *     Blocks reads AND writes, and a SECURITY INVOKER trigger on partner_users /
 *     partner_user_roles / partner_organisations writes that table, so partner user
 *     management stalls behind it too.
 *   - rollback-0049 takes ACCESS EXCLUSIVE on `certificates` — the table behind PUBLIC
 *     certificate lookup (~16 ms, does not scale with rows).
 *
 * The danger is not the hold time, it is the QUEUE. Proven: with a pre-existing transaction
 * holding a mere AccessShareLock, an ACCESS EXCLUSIVE request queues — and a plain SELECT
 * arriving BEHIND that waiter is blocked too. That is the mechanism that turns a 3 ms
 * migration into an outage: one idle-in-transaction session is enough.
 *
 * `lock_timeout` bounds ONLY the wait to ACQUIRE a lock; it never interrupts a statement that
 * already holds one. So a legitimately slow migration is unaffected — only a CONTENDED one
 * aborts. Five seconds is long enough to ride out ordinary short transactions and far shorter
 * than a user-visible outage.
 *
 * This is a behaviour change for EVERY future migration: a migration that cannot get its lock
 * within the timeout now FAILS and ROLLS BACK instead of queueing production traffic behind
 * itself. That is deliberate and it is the safe default — the failure mode is "re-run it",
 * which is strictly better than "the site is down and nobody knows why". A migration that
 * genuinely needs to wait longer must say so explicitly with
 * `-- migrate:lock-timeout 30s` (or `0` to disable, for an owner-approved maintenance window).
 */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

const LOCK_TIMEOUT_DIRECTIVE_RE = /^\s*--\s*migrate:lock-timeout\s+(\d+)\s*(ms|s)?\s*$/gim;

/** PostgreSQL SQLSTATE raised when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Parse an optional `-- migrate:lock-timeout <N>[ms|s]` directive. `0` means "wait forever"
 * (PostgreSQL's own semantics for lock_timeout = 0) and must be declared deliberately.
 * More than one directive in a file is a hard error — an ambiguous bound is worse than none.
 */
export function parseLockTimeoutDirective(sql: string, filename = "migration"): number | undefined {
  const matches = [...sql.matchAll(LOCK_TIMEOUT_DIRECTIVE_RE)];
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new Error(`Migration ${filename} declares migrate:lock-timeout more than once. Refusing to guess.`);
  }
  const value = Number(matches[0][1]);
  const ms = matches[0][2] === "s" ? value * 1000 : value;
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(`Migration ${filename} declares an invalid migrate:lock-timeout value.`);
  }
  return ms;
}

/**
 * `--lock-timeout=<N>[ms|s]` — a run-wide override for an owner-approved maintenance window.
 * Absent, the run uses DEFAULT_LOCK_TIMEOUT_MS. `0` disables the bound entirely.
 */
export function parseLockTimeoutFlag(argv: readonly string[]): number {
  const arg = argv.find((a) => a.startsWith("--lock-timeout="));
  if (!arg) return DEFAULT_LOCK_TIMEOUT_MS;
  const raw = arg.slice("--lock-timeout=".length).trim();
  const m = /^(\d+)(ms|s)?$/.exec(raw);
  if (!m) throw new Error(`Invalid --lock-timeout value: ${raw}. Use e.g. --lock-timeout=5s or --lock-timeout=5000ms.`);
  return assertSafeTimeoutMs(m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]));
}

/** Guard every value that reaches a `SET` statement — SET does not accept bind parameters. */
function assertSafeTimeoutMs(ms: number): number {
  if (!Number.isInteger(ms) || ms < 0 || ms > 3_600_000) {
    throw new Error(`Refusing to apply an out-of-range lock_timeout: ${String(ms)}`);
  }
  return ms;
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
        lockTimeoutMs: parseLockTimeoutDirective(sql, filename),
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

/**
 * Turn a raw driver error into something an operator can act on. A `lock_timeout` abort is
 * NOT a broken migration — it means live traffic was holding a conflicting lock, the runner
 * refused to queue behind it, and NOTHING was applied. Say exactly that.
 */
export function describeMigrationFailure(e: unknown, lockTimeoutMs: number): string {
  const err = e as { code?: string; message?: string };
  const message = err?.message ?? String(e);
  if (err?.code === LOCK_NOT_AVAILABLE) {
    return (
      `${message} — lock_timeout (${lockTimeoutMs} ms) expired while WAITING for a lock. ` +
      "Nothing was applied and the transaction was rolled back. This is the guard working: " +
      "a conflicting session held a lock, and continuing to wait would have queued live " +
      "traffic behind this migration. Find the blocker (SELECT pid, state, query, " +
      "state_change FROM pg_stat_activity WHERE state <> 'idle' OR xact_start IS NOT NULL), " +
      "clear it or wait for a quieter moment, then re-run. Only raise the timeout with " +
      "`-- migrate:lock-timeout <N>s` (or --lock-timeout) inside an agreed maintenance window."
    );
  }
  return message;
}

export async function applyMigrations(
  client: PgClientLike,
  files: MigrationFile[],
  opts: { allowDestructive?: boolean; lockTimeoutMs?: number } = {}
): Promise<{ applied: string[] }> {
  const runLockTimeoutMs = assertSafeTimeoutMs(opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  // Serialise concurrent runners: a second runner fails fast instead of double-applying.
  // Capture the backend identity FIRST, so lock ownership can be proven against a specific
  // server process rather than assumed from a boolean.
  const pidRow = await client.query("SELECT pg_backend_pid() AS pid");
  const ownerPid = Number((pidRow.rows[0] as { pid: number | string } | undefined)?.pid);
  if (!Number.isFinite(ownerPid)) {
    throw new Error("Could not determine the migration runner's backend PID. Refusing to run.");
  }
  const lockRes = await client.query("SELECT pg_try_advisory_lock($1) AS got", [ADVISORY_LOCK_KEY]);
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
      [ADVISORY_LOCK_KEY]
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
      // Re-prove exclusivity before EVERY file. If the connection were ever replaced or
      // recycled mid-run (the pooled-multiplexing hazard), the run stops between files
      // rather than applying the remainder without a provable lock.
      await assertLockOwned(`before ${filename}`);
      const f = byName.get(filename)!;
      const fileLockTimeoutMs = assertSafeTimeoutMs(f.lockTimeoutMs ?? runLockTimeoutMs);
      if (f.noTransaction) {
        // Non-transactional migration (e.g. CREATE INDEX CONCURRENTLY): cannot run in a txn.
        // Record intent, run, then mark complete. Must be individually idempotent.
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum, status) VALUES ($1,$2,'applying') ON CONFLICT (filename) DO UPDATE SET status='applying', started_at=now()",
          [f.filename, f.checksum]
        );
        try {
          // No enclosing transaction here, so SET LOCAL would be a no-op: set the GUC at
          // session scope and put it back afterwards, whatever happens.
          await client.query(`SET lock_timeout = ${fileLockTimeoutMs}`);
          try {
            await applyNonTransactionalMigration(client, f);
          } finally {
            await client.query("SET lock_timeout = DEFAULT");
          }
          await client.query("UPDATE schema_migrations SET status='applied', completed_at=now() WHERE filename=$1", [
            f.filename,
          ]);
        } catch (e) {
          await client.query("UPDATE schema_migrations SET status='failed' WHERE filename=$1", [f.filename]);
          throw new Error(
            `Non-transactional migration ${f.filename} failed: ${describeMigrationFailure(e, fileLockTimeoutMs)}`
          );
        }
      } else {
        await client.query("BEGIN");
        try {
          // Bound the wait to ACQUIRE every lock this file takes. SET LOCAL is scoped to this
          // transaction and is discarded at COMMIT/ROLLBACK, so it cannot leak into the
          // journal write or the next file. It never interrupts a statement that already
          // holds its locks — only a CONTENDED acquisition aborts.
          await client.query(`SET LOCAL lock_timeout = ${fileLockTimeoutMs}`);
          await client.query(f.sql);
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum, status, completed_at) VALUES ($1,$2,'applied',now())",
            [f.filename, f.checksum]
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw new Error(
            `Migration ${f.filename} failed and was rolled back: ${describeMigrationFailure(e, fileLockTimeoutMs)}`
          );
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
  const entry = process.argv[1] ? basename(process.argv[1]) : "";
  return entry === "migrate.ts" || entry === "migrate.cjs";
}

export function redactMigrationErrorMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted-postgres-url]")
    .replace(/MINTVAULT_DATABASE_URL=([^\s"'<>]+)/g, "MINTVAULT_DATABASE_URL=[redacted]");
}

async function main(): Promise<void> {
  const url = process.env.MINTVAULT_DATABASE_URL;
  if (!url) {
    console.error("MINTVAULT_DATABASE_URL is required");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");
  const allowDestructive = process.argv.includes("--allow-destructive");
  let lockTimeoutMs: number;
  try {
    lockTimeoutMs = parseLockTimeoutFlag(process.argv);
  } catch (e) {
    console.error(`🚫 ${(e as Error).message}`);
    process.exit(2);
    return;
  }
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
  const client = new Client({
    connectionString: endpoint.url,
    ssl: endpoint.url.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });
  try {
    await client.connect();
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
    console.log(
      `🔒 lock_timeout for this run: ${lockTimeoutMs === 0 ? "DISABLED (will wait forever)" : `${lockTimeoutMs} ms`}` +
        " (per-file `-- migrate:lock-timeout` overrides this)"
    );
    const { applied } = await applyMigrations(client as unknown as PgClientLike, files, {
      allowDestructive,
      lockTimeoutMs,
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
