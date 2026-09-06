/**
 * Trusted Intake Connector (Phase G1) — dedicated database connection.
 *
 * A SEPARATE pool from server/partner/db.ts's partner_runtime pool, connecting via
 * PARTNER_CONNECTOR_DATABASE_URL as the partner_connector_runtime role. Reusing the partner_runtime
 * pool here would collapse the two roles into one shared identity at the connection level, making
 * "partner_runtime cannot touch connector tables" untestable — a distinct pool is what makes that a
 * real, enforced property (see ARCHITECTURE.md §4-6). No RLS/tenant transaction wrapper is needed
 * here (see ARCHITECTURE.md §7) — every connector query is plain parameterised SQL scoped by
 * explicit id/tenant-id predicates in connector-service.ts, not by a session GUC.
 */
import pg from "pg";
import { assertMintVaultDatabaseEnvironmentSafety } from "../lib/database-environment-guard";
import { securePostgresPoolConnection } from "../lib/postgres-transport-security";

let pool: pg.Pool | null = null;

export function connectorDbConfigured(): boolean {
  return !!process.env.PARTNER_CONNECTOR_DATABASE_URL;
}

function getPool(): pg.Pool {
  if (!process.env.PARTNER_CONNECTOR_DATABASE_URL) {
    throw new Error("PARTNER_CONNECTOR_DATABASE_URL is not configured — connector refuses to start (fail closed).");
  }
  // Same environment-isolation gate as MINTVAULT_DATABASE_URL (server/config.ts).
  assertMintVaultDatabaseEnvironmentSafety(
    process.env.PARTNER_CONNECTOR_DATABASE_URL,
    process.env,
    "PARTNER_CONNECTOR_DATABASE_URL"
  );
  if (!pool) {
    // G3F: optional, env-gated bounded acquisition timeout. Unset (the default) preserves prior
    // behaviour (node-postgres waits indefinitely for a free client); when set, an exhausted pool
    // rejects `connect()` with a bounded error instead of hanging — proven by the pool-saturation
    // fault test. `max` unchanged (default 4).
    const acquireMs = Number(process.env.PARTNER_CONNECTOR_ACQUIRE_TIMEOUT_MS ?? 0);
    pool = new pg.Pool({
      ...securePostgresPoolConnection(process.env.PARTNER_CONNECTOR_DATABASE_URL, "PARTNER_CONNECTOR_DATABASE_URL"),
      max: Number(process.env.PARTNER_CONNECTOR_DB_POOL_MAX ?? 4),
      ...(acquireMs > 0 ? { connectionTimeoutMillis: acquireMs } : {}),
    });
  }
  return pool;
}

/**
 * G3F: optional, env-gated per-transaction statement/lock timeouts. Both unset (the default) preserve
 * prior behaviour (server defaults, typically unbounded). When set, a runaway statement or a blocked
 * `FOR UPDATE` fails fast with a bounded error rather than hanging a pooled connection — proven by
 * the transaction-timeout / lock-timeout fault tests. Applied as SET LOCAL so they scope to this
 * transaction only.
 */
async function applyOptionalTimeouts(client: pg.PoolClient): Promise<void> {
  const stmtMs = Number(process.env.PARTNER_CONNECTOR_STATEMENT_TIMEOUT_MS ?? 0);
  const lockMs = Number(process.env.PARTNER_CONNECTOR_LOCK_TIMEOUT_MS ?? 0);
  if (stmtMs > 0) await client.query(`SET LOCAL statement_timeout = ${Math.floor(stmtMs)}`);
  if (lockMs > 0) await client.query(`SET LOCAL lock_timeout = ${Math.floor(lockMs)}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a single transaction on the connector pool. Commits/rolls back as one unit.
 *
 * When `tenantId` is provided, sets the SAME `app.tenant_id` GUC server/partner/db.ts's withTenant()
 * uses, transaction-local (`set_config(..., true)`), before `fn` runs — this is what lets a
 * connector query against the two EXISTING, FORCE-RLS'd tables it may read
 * (partner_submission_handoffs, partner_submissions; see migration 0008) return rows scoped to
 * exactly the tenant the caller claims, and zero rows for any other tenant's data (RLS fails closed
 * on a mismatched/absent GUC). The two NEW connector tables have no RLS (ARCHITECTURE.md §7), so
 * this GUC has no effect on them either way.
 */
export async function withConnectorTx<T>(fn: (client: pg.PoolClient) => Promise<T>, tenantId?: string): Promise<T> {
  if (tenantId != null && !UUID_RE.test(tenantId)) {
    throw new Error("withConnectorTx: malformed tenant id — fail closed.");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await applyOptionalTimeouts(client);
    if (tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only query on the connector pool, no explicit transaction (status reads only). */
export async function connectorQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  const client = await getPool().connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    client.release();
  }
}

/** Test/shutdown helper. */
export async function closeConnectorPool(): Promise<void> {
  await pool?.end().catch(() => {});
  pool = null;
}
