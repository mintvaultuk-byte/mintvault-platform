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
 * THE DESIGN, in layers:
 *  1. TRANSACTION-SCOPED read-only (`BEGIN TRANSACTION READ ONLY`) — applies to exactly
 *     one transaction and is discarded when it ends, so the incident's mechanism cannot
 *     recur through it. A session-level `SET` issued *inside* the transaction is even
 *     undone by the ROLLBACK.
 *  2. SESSION-SCOPED read-only as well (`SET default_transaction_read_only = on`), so
 *     protection does not evaporate if the transaction ends early. Hostile review of the
 *     first version of this module proved a callback could issue `COMMIT` and then write
 *     successfully in the resulting autocommit window — the transaction layer alone is
 *     one statement deep. The session layer closes that window, and cleanup provably
 *     removes it (the verification below reads exactly this GUC, so it is self-testing).
 *  3. Transaction-control statements are REFUSED to the callback, so it cannot end the
 *     protected transaction at all, and the query handle is revoked once the session is
 *     released — a retained reference cannot execute later.
 *  4. DIRECT (non-pooler) endpoint preferred, so inspection tooling does not share a
 *     backend with the application; falls back to the original URL if the direct
 *     endpoint is unreachable, so the deploy gate can never be blocked by the rewrite.
 *  5. FAIL CLOSED on release: `DISCARD ALL` clears session state that ROLLBACK and
 *     `RESET ALL` do NOT (advisory locks, prepared statements), then the read-only GUC
 *     is verified `off`. If it cannot be verified clean the caller gets a hard error
 *     rather than a silently poisoned pool.
 *
 * Never logs a connection string or credential. (Driver messages can contain a host or
 * port; those are passed through as-is.)
 */
import type { Client as PgClient, QueryResult, QueryResultRow } from "pg";
import type pg from "pg";
import { securePostgresPoolConnection } from "../../server/lib/postgres-transport-security";

/** Query function handed to the caller. Confined to the read-only transaction. */
export type ReadOnlyQuery = <R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
) => Promise<QueryResult<R>>;

export interface ReadOnlySessionInfo {
  /** True when the pooled host was rewritten to its direct equivalent. */
  usedDirectEndpoint: boolean;
}

/** Minimal surface this module needs — lets the session lifecycle be driven over a
 *  caller-supplied connection, which is how the leak is made observable in tests. */
export interface ReadOnlyCapableClient {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult<never>>;
}

export function readOnlyClientConfig(databaseUrl: string): pg.ClientConfig {
  return {
    ...securePostgresPoolConnection(databaseUrl, "MINTVAULT_DATABASE_URL"),
    connectionTimeoutMillis: 15_000,
  };
}

/** Statements that would end or re-open the protected transaction. Refused outright. */
const TRANSACTION_CONTROL =
  /^\s*(?:commit|rollback|end|begin|start\s+transaction|savepoint|release\s+savepoint|set\s+transaction|discard|reset)\b/i;

/**
 * Rewrite a Neon pooled host to its direct equivalent (`ep-x-123-pooler.…` → `ep-x-123.…`).
 *
 * Only ever touches a `*.neon.tech` host — a local cluster, a self-hosted Postgres or any
 * other provider is returned byte-identical, because the `-pooler` convention is Neon's.
 * Pure and total: never throws, and returns the input unchanged if it cannot be parsed.
 *
 * Case-insensitive (`postgresql:` is a non-special URL scheme, so WHATWG parsing does NOT
 * lowercase the host — a mixed-case host previously skipped the rewrite silently), and the
 * `-pooler` label is matched anchored to a label boundary so a host containing `-pooler`
 * twice cannot be mis-rewritten into something that is neither endpoint.
 */
export function toDirectEndpoint(databaseUrl: string): { url: string; changed: boolean } {
  try {
    const u = new URL(databaseUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith(".neon.tech")) return { url: databaseUrl, changed: false };
    if (!/-pooler(?=\.)/i.test(u.hostname)) return { url: databaseUrl, changed: false };
    const rewritten = u.hostname.replace(/-pooler(?=\.)/i, "");
    // Post-condition: a "changed" rewrite must leave no pooler label behind.
    if (/-pooler(?=\.)/i.test(rewritten)) return { url: databaseUrl, changed: false };
    u.hostname = rewritten;
    return { url: u.toString(), changed: true };
  } catch {
    return { url: databaseUrl, changed: false };
  }
}

/**
 * Drive the read-only session lifecycle over an ALREADY-CONNECTED client.
 *
 * Exported because it is the only way to observe the defect this module exists to fix: a
 * session-state leak is only visible on the SAME connection, and a test that opens a
 * fresh client gets a fresh backend and can never see it. Tests drive this directly and
 * then inspect their own connection afterwards.
 */
export async function runReadOnlySession<T>(
  client: ReadOnlyCapableClient,
  fn: (query: ReadOnlyQuery, info: ReadOnlySessionInfo) => Promise<T>,
  info: ReadOnlySessionInfo = { usedDirectEndpoint: false }
): Promise<T> {
  let released = false;

  const query: ReadOnlyQuery = (sql, params) => {
    if (released) {
      return Promise.reject(new Error("read-only session already released — this query handle is no longer valid"));
    }
    if (TRANSACTION_CONTROL.test(sql)) {
      return Promise.reject(
        new Error(
          `refusing to run transaction-control statement inside a read-only session: ${sql.trim().slice(0, 40)}`
        )
      );
    }
    return client.query(sql, params) as unknown as Promise<QueryResult<never>>;
  };

  let workError: unknown = null;
  let result: T | undefined;
  try {
    // Layer 2 first: a session-level default, so protection survives the transaction
    // ending for any reason. Cleanup below removes it and verifies the removal.
    await client.query("SET default_transaction_read_only = on");
    // Layer 1: transaction-scoped, discarded when the transaction ends.
    await client.query("BEGIN TRANSACTION READ ONLY");
    result = await fn(query, info);
  } catch (err) {
    workError = err;
  }

  // ── Cleanup + fail-closed verification. Runs on every path. ──────────────────
  released = true;
  let cleanupError: Error | null = null;
  const note = (e: unknown, what: string): void => {
    cleanupError = cleanupError ?? new Error(`preflight cleanup: ${what} (${(e as Error).message})`);
  };
  try {
    // A read-only transaction has nothing to commit; rollback is always correct and is a
    // no-op when the transaction has already been aborted or never opened.
    await client.query("ROLLBACK");
  } catch (err) {
    note(err, "ROLLBACK failed");
  }
  try {
    // DISCARD ALL, not RESET ALL: advisory locks and prepared statements survive both
    // ROLLBACK and RESET ALL, and would be handed back to the next pooled client.
    // It also clears the session-level read-only default set above.
    await client.query("DISCARD ALL");
  } catch (err) {
    note(err, "DISCARD ALL failed");
  }
  try {
    const check = await client.query("SELECT current_setting('default_transaction_read_only') AS v");
    const v = (check.rows[0] as unknown as { v?: string } | undefined)?.v;
    if (v !== "off") {
      cleanupError =
        cleanupError ??
        new Error(
          "preflight cleanup: session still reports default_transaction_read_only=on after DISCARD ALL — " +
            "connection must be discarded rather than returned to a pooled backend"
        );
    }
  } catch (err) {
    note(err, "could not verify a clean session");
  }

  if (workError) {
    // Preserve BOTH failures: the caller's error is the useful diagnosis, the cleanup
    // failure is machine-readable on `cause` rather than stderr-only.
    if (cleanupError) {
      const e = workError instanceof Error ? workError : new Error(String(workError));
      throw new Error(e.message, { cause: cleanupError });
    }
    throw workError;
  }
  if (cleanupError) throw cleanupError;
  return result as T;
}

/**
 * Connect, run `fn` inside a read-only session, and release the connection provably clean.
 *
 * `preferDirectEndpoint` defaults to true and exists so tests can exercise the pooled path
 * explicitly. If the direct endpoint cannot be reached, the original URL is used — a
 * hostname rewrite must never be able to block the deploy gate.
 */
export async function withReadOnlySession<T>(
  databaseUrl: string,
  fn: (query: ReadOnlyQuery, info: ReadOnlySessionInfo) => Promise<T>,
  opts: { preferDirectEndpoint?: boolean } = {}
): Promise<T> {
  const preferDirect = opts.preferDirectEndpoint !== false;
  const direct = preferDirect ? toDirectEndpoint(databaseUrl) : { url: databaseUrl, changed: false };
  const { Client } = await import("pg");

  const connect = async (url: string): Promise<PgClient> => {
    // Bound the connection attempt: this runs as a deploy gate, so a blackholed host
    // must fail fast rather than hang. Transport is the same verified authority as runtime.
    const c: PgClient = new Client(readOnlyClientConfig(url));
    // A pg Client emits a connection-level 'error' event when the socket dies
    // unexpectedly (backend terminated, pooler recycled it, network dropped). With no
    // listener that becomes an UNCAUGHT EXCEPTION and takes the whole preflight process
    // down. Swallow it here; the awaited query still rejects, so the failure is reported
    // through the normal path and never silently ignored.
    c.on("error", (err: Error) => {
      console.error(`[preflight] database connection error: ${err.message}`);
    });
    await c.connect();
    return c;
  };

  let client: PgClient;
  let usedDirect = direct.changed;
  try {
    client = await connect(direct.url);
  } catch (err) {
    if (!direct.changed) throw err;
    // The direct endpoint may not be provisioned for this project/role. Fall back rather
    // than turning a hostname preference into a release blocker.
    console.error(
      `[preflight] direct endpoint unavailable (${(err as Error).message}); falling back to the configured endpoint`
    );
    client = await connect(databaseUrl);
    usedDirect = false;
  }

  try {
    return await runReadOnlySession(client as unknown as ReadOnlyCapableClient, fn, { usedDirectEndpoint: usedDirect });
  } finally {
    try {
      await client.end();
    } catch {
      /* the socket is already gone; nothing can leak through a closed connection */
    }
  }
}
