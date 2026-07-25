/**
 * Leak-proof read-only database session for preflight/inspection tooling.
 *
 * WHY THIS EXISTS — incident 2026-07-25 (staging):
 * `preflight-schema.ts` ran `SET default_transaction_read_only = on` and never reset it.
 * `MINTVAULT_DATABASE_URL` points at Neon's `-pooler` host, which is PgBouncer in
 * TRANSACTION pooling mode. Transaction mode does not issue a server reset query, so a
 * session-level `SET` persists on the shared server-side backend and is inherited by
 * whichever client is handed that backend next. Thirty seconds after a preflight, the
 * application's own print-batch write failed with
 * `cannot execute UPDATE in a read-only transaction`. Evidence: `pg_settings` reported
 * `source=session` with `reset_val=off`/`boot_val=off`, no `options=` in the connection
 * string, and null role/db-role settings; 8 pooler clients shared 1 backend PID while 4
 * direct-endpoint clients got 4 distinct PIDs.
 *
 * THE FIX, in layers (defence in depth, strongest first):
 *  1. TRANSACTION-SCOPED read-only instead of session-scoped. `BEGIN TRANSACTION READ
 *     ONLY` applies to exactly one transaction and is discarded when it ends, so there
 *     is nothing left to leak even if cleanup is skipped, the process is killed, or the
 *     pooler recycles the backend mid-flight. This alone closes the defect.
 *  2. DIRECT (non-pooler) endpoint preferred for session-mutating inspection work, so
 *     the tool does not share a backend with the application at all.
 *  3. Explicit ROLLBACK in a strict try/finally — a read-only transaction has nothing
 *     to commit, so rollback is always the correct exit.
 *  4. FAIL CLOSED: before the connection is released, verify the session carries no
 *     residual read-only default. If it cannot be verified clean, the connection is
 *     closed and the caller gets a hard error rather than a silently poisoned pool.
 *
 * Read-only protection is STRENGTHENED, not weakened: an explicit READ ONLY transaction
 * blocks writes directly, whereas `default_transaction_read_only` only altered the
 * default for subsequent transactions.
 *
 * Never logs a connection string, credential or host.
 */
import type { Client as PgClient, QueryResult, QueryResultRow } from "pg";

/** Query function handed to the caller. Confined to the read-only transaction. */
export type ReadOnlyQuery = <R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<R>>;

export interface ReadOnlySessionInfo {
  /** True when the pooled host was rewritten to its direct equivalent. */
  usedDirectEndpoint: boolean;
}

const isLocal = (url: string): boolean => url.includes("127.0.0.1") || url.includes("localhost");

/**
 * Rewrite a Neon pooled host to its direct equivalent (`ep-x-123-pooler.…` → `ep-x-123.…`).
 *
 * Only ever touches a `*.neon.tech` host — a local cluster, a self-hosted Postgres or any
 * other provider is returned byte-identical, because the `-pooler` convention is Neon's.
 * Pure and total: never throws, and returns the input unchanged if it cannot be parsed.
 */
export function toDirectEndpoint(databaseUrl: string): { url: string; changed: boolean } {
  try {
    const u = new URL(databaseUrl);
    if (!u.hostname.endsWith(".neon.tech")) return { url: databaseUrl, changed: false };
    if (!u.hostname.includes("-pooler")) return { url: databaseUrl, changed: false };
    u.hostname = u.hostname.replace("-pooler", "");
    return { url: u.toString(), changed: true };
  } catch {
    return { url: databaseUrl, changed: false };
  }
}

/**
 * Run `fn` inside a read-only transaction on a fresh connection, then release the
 * connection provably clean.
 *
 * Cleanup runs on every exit path — normal return, early return, thrown query, or
 * rejected promise. If the caller's work fails AND cleanup fails, the caller's error is
 * the one thrown (it is the more useful diagnosis) and the cleanup failure is reported
 * separately; a cleanup failure alone is itself thrown, so a potentially contaminated
 * session is never treated as success.
 *
 * `preferDirectEndpoint` defaults to true and exists so tests can exercise the pooled
 * path explicitly.
 */
export async function withReadOnlySession<T>(
  databaseUrl: string,
  fn: (query: ReadOnlyQuery, info: ReadOnlySessionInfo) => Promise<T>,
  opts: { preferDirectEndpoint?: boolean } = {},
): Promise<T> {
  const preferDirect = opts.preferDirectEndpoint !== false;
  const direct = preferDirect ? toDirectEndpoint(databaseUrl) : { url: databaseUrl, changed: false };
  const { Client } = await import("pg");
  const client: PgClient = new Client({
    connectionString: direct.url,
    ssl: isLocal(direct.url) ? undefined : { rejectUnauthorized: false },
  });
  // A pg Client emits a connection-level 'error' event when the socket dies unexpectedly
  // (backend terminated, pooler recycled it, network dropped). With no listener that
  // becomes an UNCAUGHT EXCEPTION and takes the whole preflight process down — which
  // would turn a recoverable inspection failure into a crash, and in CI into a confusing
  // unrelated stack trace. Swallow it here; the awaited query below still rejects, so the
  // failure is reported through the normal path and never silently ignored.
  client.on("error", (err: Error) => {
    console.error(`[preflight] database connection error: ${err.message}`);
  });
  await client.connect();

  const query: ReadOnlyQuery = (sql, params) =>
    client.query(sql, params as unknown[]) as unknown as Promise<QueryResult<never>>;

  let workError: unknown = null;
  let result: T | undefined;
  try {
    // Transaction-scoped, NOT session-scoped: discarded when the transaction ends.
    await client.query("BEGIN TRANSACTION READ ONLY");
    result = await fn(query, { usedDirectEndpoint: direct.changed });
  } catch (err) {
    workError = err;
  }

  // ── Cleanup + fail-closed verification. Runs on every path. ──────────────────
  let cleanupError: Error | null = null;
  try {
    // A read-only transaction has nothing to commit; rollback is always correct and is
    // a no-op when the transaction has already been aborted by a failed statement.
    await client.query("ROLLBACK");
  } catch (err) {
    cleanupError = new Error(`preflight cleanup: ROLLBACK failed (${(err as Error).message})`);
  }
  try {
    const check = await client.query<{ v: string }>(
      "SELECT current_setting('default_transaction_read_only') AS v",
    );
    if (check.rows[0]?.v !== "off") {
      // Should be unreachable now that the setting is transaction-scoped — but if a
      // session-level default ever reappears, clear it and re-verify rather than
      // handing a contaminated session back to the pooler.
      await client.query("RESET ALL");
      const again = await client.query<{ v: string }>(
        "SELECT current_setting('default_transaction_read_only') AS v",
      );
      if (again.rows[0]?.v !== "off") {
        cleanupError =
          cleanupError ??
          new Error(
            "preflight cleanup: session still reports default_transaction_read_only=on after RESET ALL — " +
              "connection discarded to avoid contaminating a pooled backend",
          );
      }
    }
  } catch (err) {
    cleanupError = cleanupError ?? new Error(`preflight cleanup: could not verify a clean session (${(err as Error).message})`);
  }
  try {
    await client.end();
  } catch {
    /* the socket is already gone; nothing can leak through a closed connection */
  }

  if (workError) {
    if (cleanupError) console.error(`[preflight] ${cleanupError.message}`);
    throw workError;
  }
  if (cleanupError) throw cleanupError;
  return result as T;
}
