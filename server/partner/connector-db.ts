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

let pool: pg.Pool | null = null;

export function connectorDbConfigured(): boolean {
  return !!process.env.PARTNER_CONNECTOR_DATABASE_URL;
}

function getPool(): pg.Pool {
  if (!process.env.PARTNER_CONNECTOR_DATABASE_URL) {
    throw new Error("PARTNER_CONNECTOR_DATABASE_URL is not configured — connector refuses to start (fail closed).");
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.PARTNER_CONNECTOR_DATABASE_URL,
      max: Number(process.env.PARTNER_CONNECTOR_DB_POOL_MAX ?? 4),
    });
  }
  return pool;
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
