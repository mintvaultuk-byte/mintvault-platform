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
      //
      // Bounded waits are a SECURITY control here, not just a latency one. The kill-switch and
      // portal-enabled gates read partner_feature_flags on this pool on EVERY request, uncached,
      // and they fail closed via `catch`. A fail-closed branch only runs if an error actually
      // arrives — so an unbounded wait does not fail closed, it hangs: with no acquire timeout and
      // no query timeout, an ACCESS EXCLUSIVE lock on that table (a migration, or a stuck admin
      // writer) parks every request on a pool slot, exhausts all `max` of them, and then parks the
      // rest in the pool queue forever. The user sees a proxy-level timeout with no body and the
      // logs say nothing. These bounds convert that hang into an error, so the EXISTING
      // fail-closed `unavailable(res)` branches in mount.ts/public-routes.ts execute as designed.
      connectionTimeoutMillis: Number(process.env.PARTNER_DB_ACQUIRE_TIMEOUT_MS ?? 2000),
      query_timeout: Number(process.env.PARTNER_DB_QUERY_TIMEOUT_MS ?? 3000),
    });
    // Idle pooled clients emit errors on the POOL, not on any query promise. Without a listener
    // Node treats that as an uncaught exception and exits. Matches adminPool and server/db.ts.
    pool.on("error", (err) => console.error("[partner-runtime-pool] idle client error (evicted):", err.message));
    // query_timeout is client-side: it frees the JS promise and the pool slot, but leaves the
    // server-side query still waiting on the lock. lock_timeout is what actually stops the
    // DB-side pile-up, so set it per connection as well. Applied via `connect` rather than a
    // `SET LOCAL` because partnerRuntimeQuery is deliberately non-transactional. Session-scoped
    // and idempotent, so it is safe to re-apply on a pooled endpoint.
    const lockTimeoutMs = Number(process.env.PARTNER_DB_LOCK_TIMEOUT_MS ?? 2000);
    pool.on("connect", (client) => {
      client.query(`SET lock_timeout = ${Math.floor(lockTimeoutMs)}`).catch((err) => {
        console.error("[partner-runtime-pool] failed to set lock_timeout:", (err as Error).message);
      });
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

// =============================================================================================
// PUBLIC READER — anonymous Shop Finder / public shop profile
// =============================================================================================

/** Error the public path raises when its own database identity is not configured or not reachable. */
export class PartnerPublicDbUnavailable extends Error {
  readonly code = "PUBLIC_DB_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "PartnerPublicDbUnavailable";
  }
}

let publicPool: pg.Pool | null = null;

/** Whether the dedicated public-reader DB URL is configured. */
export function partnerPublicDbConfigured(): boolean {
  return !!process.env.PARTNER_PUBLIC_DATABASE_URL;
}

/**
 * The dedicated pool for anonymous public traffic.
 *
 * THERE IS DELIBERATELY NO FALLBACK. Not to the admin pool, not to the runtime pool, and above all
 * not to MINTVAULT_DATABASE_URL — `partnerAdminQuery` does fall back that way, and that is how two
 * anonymous queries ended up executing on the broadest connection in the system. A missing public
 * URL here produces a controlled 503, not a quiet privilege escalation. Failing the public site
 * closed is recoverable in minutes; serving it from an owner connection is not.
 *
 * SIZED AND BOUNDED FOR SHORT READS. Every public query is a single indexed SELECT against one of
 * the two 0061 projections, so these numbers are chosen for "fast or fail", not for throughput:
 *
 *   max                 6   Capacity is deliberately SMALL and separate. The point of isolation is
 *                           that a public traffic spike exhausts THIS pool and nothing else — Super
 *                           Admin keeps its own connections either way.
 *   acquire timeout  1000ms Once the pool is saturated a caller must be told quickly. Queueing
 *                           anonymous requests behind a full pool converts a spike into a pile-up.
 *   query timeout    2000ms Client-side. Frees the JS promise and the pool slot.
 *   lock timeout     1000ms Server-side, and the one that actually matters: query_timeout releases
 *                           the slot but leaves the backend still waiting on the lock. Without this
 *                           an ACCESS EXCLUSIVE lock (a migration, a stuck writer) parks every
 *                           backend and the DB-side pile-up outlives the HTTP requests.
 *   idle timeout    10000ms Public traffic is bursty; idle connections should not be held open
 *                           against a shared Neon endpoint between bursts.
 *
 * Every one is overridable by env for staging tuning, but each has a working default so the pool is
 * never accidentally unbounded.
 */
function getPublicPool(): pg.Pool {
  const url = process.env.PARTNER_PUBLIC_DATABASE_URL;
  if (!url) {
    throw new PartnerPublicDbUnavailable(
      "PARTNER_PUBLIC_DATABASE_URL is not configured — the public network refuses to serve from a privileged connection (fail closed)."
    );
  }
  if (!publicPool) {
    publicPool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PARTNER_PUBLIC_DB_POOL_MAX ?? 6),
      connectionTimeoutMillis: Number(process.env.PARTNER_PUBLIC_DB_ACQUIRE_TIMEOUT_MS ?? 1000),
      query_timeout: Number(process.env.PARTNER_PUBLIC_DB_QUERY_TIMEOUT_MS ?? 2000),
      idleTimeoutMillis: Number(process.env.PARTNER_PUBLIC_DB_IDLE_TIMEOUT_MS ?? 10000),
    });
    publicPool.on("error", (err) =>
      console.error("[partner-public-pool] idle client error (evicted):", err.message)
    );
    const lockTimeoutMs = Number(process.env.PARTNER_PUBLIC_DB_LOCK_TIMEOUT_MS ?? 1000);
    const statementTimeoutMs = Number(process.env.PARTNER_PUBLIC_DB_STATEMENT_TIMEOUT_MS ?? 2000);
    publicPool.on("connect", (client) => {
      // SET ROLE is what makes the least privilege REAL rather than aspirational: the connection
      // may authenticate as a login role that is merely a member of partner_public_reader (the
      // house convention is NOLOGIN group roles, granted to a login role out of band), and in tests
      // it may authenticate as the superuser that owns the cluster. Dropping to the group role on
      // every new connection means the identity actually executing public SQL is the restricted one
      // in every environment, so the negative-privilege proofs mean what they claim.
      //
      // Session-scoped and idempotent, so re-applying on a pooled endpoint is safe. A failure here
      // is logged and NOT swallowed into silence — a connection that stayed on the login role would
      // pass every functional test while holding privileges the whole design says it must not.
      client
        .query(
          `SET ROLE partner_public_reader;
           SET lock_timeout = ${Math.floor(lockTimeoutMs)};
           SET statement_timeout = ${Math.floor(statementTimeoutMs)}`
        )
        .catch((err) => {
          console.error("[partner-public-pool] failed to drop to partner_public_reader:", (err as Error).message);
        });
    });
  }
  return publicPool;
}

/**
 * Run one anonymous public read.
 *
 * Non-transactional by design: every public query is a single SELECT, and a transaction would hold
 * a pool slot across statements for no benefit.
 */
export async function partnerPublicQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  const client = await getPublicPool().connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    client.release();
  }
}

/** Test-only: drop the memoised pool so a suite can re-point PARTNER_PUBLIC_DATABASE_URL. */
export async function __resetPartnerPublicPoolForTests(): Promise<void> {
  const p = publicPool;
  publicPool = null;
  if (p) await p.end().catch(() => {});
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
