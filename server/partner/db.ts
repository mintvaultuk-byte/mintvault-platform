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

export function databaseIdentity(raw: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL connection URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error(`${variable} must identify a PostgreSQL host and database.`);
  }
  const port = parsed.port || "5432";
  const hostname = normalizePartnerDatabaseHostname(parsed.hostname);
  // PostgreSQL accepts both URL spellings; they name the same protocol and
  // must not make an otherwise atomic G6D topology look split.
  return `postgresql://${hostname}:${port}${parsed.pathname}`;
}

/** Neon exposes direct and pooled endpoints for the same database. Their first
 * hostname label differs only by `-pooler`; normalize that provider-specific
 * routing marker while leaving every other host name exact. */
function normalizePartnerDatabaseHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized.endsWith(".neon.tech")) return normalized;
  const labels = normalized.split(".");
  if (labels[0]?.endsWith("-pooler")) labels[0] = labels[0].slice(0, -"-pooler".length);
  return labels.join(".");
}

/**
 * G6D writes a MintVault submission status and Partner accounting evidence in one PostgreSQL
 * transaction. Separate credentials are required, but a separate database is not supported: it
 * would turn the commit into an unrecoverable distributed transaction. Assert the topology before
 * routes/jobs start instead of discovering it after a card has completed grading.
 */
export function assertPartnerAccountingDatabaseTopology(): void {
  const mintVault = process.env.MINTVAULT_DATABASE_URL;
  if (!mintVault) return; // server/config.ts reports the canonical missing-DB error during startup.
  const expected = databaseIdentity(mintVault, "MINTVAULT_DATABASE_URL");
  for (const variable of [
    "PARTNER_ADMIN_DATABASE_URL",
    "PARTNER_DATABASE_URL",
    "PARTNER_CONNECTOR_DATABASE_URL",
  ] as const) {
    const value = process.env[variable];
    if (value && databaseIdentity(value, variable) !== expected) {
      throw new Error(
        `${variable} must target the same PostgreSQL database as MINTVAULT_DATABASE_URL for Partner credit settlement.`
      );
    }
  }
}

/** A non-throwing readiness view for process startup. A mismatch disables only
 * G6D's single-database credit lifecycle; it must not take down MintVault. */
export function partnerAccountingTopologyReadiness(): { ready: true } | { ready: false; code: string } {
  try {
    assertPartnerAccountingDatabaseTopology();
    return { ready: true };
  } catch {
    return { ready: false, code: "partner_credit_topology_unavailable" };
  }
}

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

function assertTenantContext(ctx: TenantContext, caller: string): void {
  if (!ctx || !ctx.tenantId || !UUID_RE.test(ctx.tenantId)) {
    throw new Error(`${caller}: missing or malformed tenant context — fail closed.`);
  }
  if (ctx.locationId != null && ctx.locationId !== "" && !UUID_RE.test(ctx.locationId)) {
    throw new Error(`${caller}: malformed location context — fail closed.`);
  }
}

/**
 * Run `fn` inside a transaction scoped to a single tenant (and optional location). The client is
 * bound to `app.tenant_id`/`app.location_id` for the life of the transaction only. Fails closed on
 * a missing/malformed tenant id BEFORE touching the DB.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  assertTenantContext(ctx, "withTenant");
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
  assertPartnerAccountingDatabaseTopology();
  const url = process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL;
  if (!url) throw new Error("No admin DB URL configured for partner control shell.");
  if (!adminPool) {
    adminPool = new pg.Pool({ connectionString: url, max: 4 });
    // Idle pooled clients emit errors on the POOL, not on any query promise. Without a listener
    // Node treats that as an uncaught exception and exits — a boot-loop on Fly now that the RBAC
    // bootstrap creates this pool on every machine. Matches server/db.ts and the session pool.
    adminPool.on("error", (err) => console.error("[partner-admin-pool] idle client error (evicted):", err.message));
  }
  return adminPool.query<T>(sql, params);
}

/** Privileged partner-schema transaction helper for domain services that need row locks. */
export async function withPartnerAdminTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  assertPartnerAccountingDatabaseTopology();
  const url = process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL;
  if (!url) throw new Error("No admin DB URL configured for partner control shell.");
  if (!adminPool) {
    adminPool = new pg.Pool({ connectionString: url, max: 4 });
    // Idle pooled clients emit errors on the POOL, not on any query promise. Without a listener
    // Node treats that as an uncaught exception and exits — a boot-loop on Fly now that the RBAC
    // bootstrap creates this pool on every machine. Matches server/db.ts and the session pool.
    adminPool.on("error", (err) => console.error("[partner-admin-pool] idle client error (evicted):", err.message));
  }
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

/**
 * Durable fail-closed evidence uses a separate tiny pool, so an accounting exception raised inside
 * a Partner settlement transaction cannot exhaust the same admin pool it is currently holding.
 */
let accountingAuditPool: pg.Pool | null = null;
export async function withPartnerAccountingAuditTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  assertPartnerAccountingDatabaseTopology();
  const url = process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL;
  if (!url) throw new Error("No admin DB URL configured for partner accounting audit.");
  if (!accountingAuditPool) {
    accountingAuditPool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PARTNER_ACCOUNTING_AUDIT_POOL_MAX ?? 2),
      connectionTimeoutMillis: Number(process.env.PARTNER_ACCOUNTING_AUDIT_CONNECT_TIMEOUT_MS ?? 1_000),
      query_timeout: Number(process.env.PARTNER_ACCOUNTING_AUDIT_QUERY_TIMEOUT_MS ?? 2_000),
    } as pg.PoolConfig);
  }
  const client = await accountingAuditPool.connect();
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

/**
 * Privileged transaction with an explicit, transaction-local tenant context.
 *
 * This is intentionally NOT an RLS substitute: the admin connection can bypass RLS, so every
 * tenant-owned query used from this helper must still carry an explicit tenant predicate and
 * validate cross-table tenant invariants. It exists only for small accounting workflows which need
 * the G6B wallet row lock and immutable lifecycle/event writes that the restricted Partner role is
 * deliberately not allowed to perform.
 */
export async function withPartnerAdminTenantTransaction<T>(
  ctx: TenantContext,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  assertTenantContext(ctx, "withPartnerAdminTenantTransaction");
  return withPartnerAdminTransaction(async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.location_id', $1, true)", [ctx.locationId ?? ""]);
    return fn(client);
  });
}

/**
 * Test/shutdown helper. Also drops the admin capability cache: that cache records a property of the
 * ROLE behind adminPool, so once the pool is discarded the cached verdict describes a connection that
 * no longer exists. Without this, replacing PARTNER_ADMIN_DATABASE_URL with a role that lacks
 * BYPASSRLS keeps reporting ready.
 */
export async function closePartnerPools(): Promise<void> {
  await pool?.end().catch(() => {});
  await adminPool?.end().catch(() => {});
  await accountingAuditPool?.end().catch(() => {});
  pool = null;
  adminPool = null;
  accountingAuditPool = null;
  const { resetPartnerAdminCapabilityCache } = await import("./admin-capability");
  resetPartnerAdminCapabilityCache();
}
