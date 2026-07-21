/**
 * Partner Portal — tenant-context database wrapper (Phase 1, HARD security requirement).
 *
 * The partner runtime connects with a SEPARATE, RESTRICTED role (`partner_runtime`) via
 * `PARTNER_DATABASE_URL` — never the privileged MintVault connection. Every partner DB operation
 * runs through `withTenant`, which:
 *   - opens a dedicated transaction on a single pooled client,
 *   - sets `app.tenant_id` (and optional `app.location_id`) with `set_config(..., true)` so it is
 *     LOCAL to that transaction (never global on a pooled connection → no cross-request leakage),
 *   - passes ONLY parameterised values (no string interpolation),
 *   - commits on success / rolls back on error, and the LOCAL setting is discarded at txn end,
 *   - FAILS CLOSED if tenant context is missing.
 *
 * Tenant/location context comes from the validated session — NEVER from a request payload.
 */
import pg from "pg";

let pool: pg.Pool | null = null;

/** Whether a restricted partner runtime DB URL is configured. */
export function partnerDbConfigured(): boolean {
  return !!process.env.PARTNER_DATABASE_URL;
}

function getPool(): pg.Pool {
  if (!process.env.PARTNER_DATABASE_URL) {
    // Fail closed: the partner runtime must not fall back to the privileged connection.
    throw new Error("PARTNER_DATABASE_URL is not configured — partner runtime refuses to start (fail closed).");
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.PARTNER_DATABASE_URL,
      max: Number(process.env.PARTNER_DB_POOL_MAX ?? 8),
      // no SSL for local/disposable; real infra provides its own sslmode in the URL.
    });
  }
  return pool;
}

export interface TenantContext {
  tenantId: string;
  locationId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction scoped to a single tenant (and optional location). The client is
 * bound to `app.tenant_id`/`app.location_id` for the life of the transaction only. Fails closed on
 * a missing/malformed tenant id BEFORE touching the DB.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!ctx || !ctx.tenantId || !UUID_RE.test(ctx.tenantId)) {
    throw new Error("withTenant: missing or malformed tenant context — fail closed.");
  }
  if (ctx.locationId != null && ctx.locationId !== "" && !UUID_RE.test(ctx.locationId)) {
    throw new Error("withTenant: malformed location context — fail closed.");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // transaction-local, parameterised — cannot leak to other pooled requests, cannot be injected.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.location_id', $1, true)", [ctx.locationId ?? ""]);
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

/**
 * Run a query on the restricted partner_runtime pool WITHOUT tenant context. This exists ONLY for
 * the pre-auth path: calling the narrow SECURITY DEFINER function partner_auth_lookup(email) before
 * a tenant is known. RLS-protected tables return NOTHING here (no context = fail closed); only the
 * explicitly-granted definer function returns data. Never use for tenant data access.
 */
export async function partnerRuntimeQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
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

/**
 * A privileged partner-schema operation that is NOT tenant-scoped (super-admin control-shell reads
 * of partner data across tenants). Uses a SEPARATE privileged URL and must only be reachable behind
 * MintVault admin auth. Kept distinct from the tenant runtime path.
 */
let adminPool: pg.Pool | null = null;
export function partnerAdminDbConfigured(): boolean {
  return !!(process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL);
}
export async function partnerAdminQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  const url = process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL;
  if (!url) throw new Error("No admin DB URL configured for partner control shell.");
  if (!adminPool) adminPool = new pg.Pool({ connectionString: url, max: 4 });
  return adminPool.query<T>(sql, params);
}

/** Privileged partner-schema transaction helper for domain services that need row locks. */
export async function withPartnerAdminTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const url = process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL;
  if (!url) throw new Error("No admin DB URL configured for partner control shell.");
  if (!adminPool) adminPool = new pg.Pool({ connectionString: url, max: 4 });
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Test/shutdown helper. */
export async function closePartnerPools(): Promise<void> {
  await pool?.end().catch(() => {});
  await adminPool?.end().catch(() => {});
  pool = null;
  adminPool = null;
}
