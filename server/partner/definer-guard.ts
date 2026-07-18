/**
 * Partner Network — SECURITY DEFINER ownership guard (DB-F1 fix, migration 0006).
 *
 * The pre-auth lookups (partner_auth_lookup / partner_session_lookup / partner_reset_token_tenant)
 * run before any tenant context exists and must read across all tenants under FORCE ROW LEVEL
 * SECURITY. That only works if they are owned by a dedicated BYPASSRLS role (partner_definer) and
 * NOT by the runtime role. If that ownership model is absent or wrong, partner authentication
 * silently fails closed (0 rows) — so we assert it explicitly and fail LOUD instead.
 *
 * This is a read-only inspection of pg_proc / pg_roles / ACLs. It runs at Partner Portal startup
 * (so the runtime refuses to boot in a broken configuration) and in the migration-safety preflight
 * and tests. It never mutates anything.
 */

export type DbQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** The three pre-auth SECURITY DEFINER functions that must be owned by partner_definer. */
export const DEFINER_FUNCTIONS = [
  "partner_auth_lookup",
  "partner_session_lookup",
  "partner_reset_token_tenant",
] as const;

export const DEFINER_ROLE = "partner_definer";
export const RUNTIME_ROLE = "partner_runtime";

/**
 * Returns a list of human-readable violations of the definer ownership model. Empty array = healthy.
 * Each check maps 1:1 to a DB-F1 safety property so the caller/operator can see exactly what is wrong.
 */
export async function definerModelViolations(query: DbQuery): Promise<string[]> {
  const v: string[] = [];

  // 1) Definer role exists with the exact least-privilege attribute set.
  const role = await query(
    `SELECT rolname, rolbypassrls, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication
       FROM pg_roles WHERE rolname = $1`,
    [DEFINER_ROLE]
  );
  if (role.rows.length !== 1) {
    v.push(`role ${DEFINER_ROLE} is missing`);
  } else {
    const r = role.rows[0] as Record<string, boolean>;
    if (!r.rolbypassrls) v.push(`${DEFINER_ROLE} must have BYPASSRLS`);
    if (r.rolcanlogin) v.push(`${DEFINER_ROLE} must be NOLOGIN`);
    if (r.rolsuper) v.push(`${DEFINER_ROLE} must be NOSUPERUSER`);
    if (r.rolcreaterole) v.push(`${DEFINER_ROLE} must be NOCREATEROLE`);
    if (r.rolcreatedb) v.push(`${DEFINER_ROLE} must be NOCREATEDB`);
    if (r.rolreplication) v.push(`${DEFINER_ROLE} must be NOREPLICATION`);
  }

  // 2) Runtime role must never bypass RLS or be a superuser.
  const runtime = await query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [RUNTIME_ROLE]);
  if (runtime.rows.length === 1) {
    const r = runtime.rows[0] as Record<string, boolean>;
    if (r.rolbypassrls) v.push(`${RUNTIME_ROLE} must NOT have BYPASSRLS`);
    if (r.rolsuper) v.push(`${RUNTIME_ROLE} must NOT be a superuser`);
  }

  // 3) Each pre-auth function exists, is SECURITY DEFINER, owned by partner_definer, has a set
  //    search_path, is not executable by PUBLIC, and IS executable by partner_runtime.
  for (const fn of DEFINER_FUNCTIONS) {
    const f = await query(
      `SELECT p.prosecdef,
              pg_get_userbyid(p.proowner)                             AS owner,
              -- SEC-1: require a hardened search_path with pg_temp explicitly LAST, not just any set.
              (p.proconfig IS NOT NULL AND EXISTS (
                 SELECT 1 FROM unnest(p.proconfig) c
                  WHERE c LIKE 'search_path=%' AND c LIKE '%pg_temp')) AS safe_search_path,
              has_function_privilege('public', p.oid, 'EXECUTE')       AS public_exec,
              has_function_privilege($2,       p.oid, 'EXECUTE')       AS runtime_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = $1 AND n.nspname = 'public'`,
      [fn, RUNTIME_ROLE]
    );
    if (f.rows.length !== 1) {
      v.push(`function ${fn} is missing`);
      continue;
    }
    const row = f.rows[0] as Record<string, unknown>;
    if (!row.prosecdef) v.push(`${fn} must be SECURITY DEFINER`);
    if (row.owner !== DEFINER_ROLE) v.push(`${fn} must be owned by ${DEFINER_ROLE} (is ${String(row.owner)})`);
    if (!row.safe_search_path) v.push(`${fn} must set a hardened search_path with pg_temp last (SEC-1)`);
    if (row.public_exec) v.push(`${fn} must NOT be executable by PUBLIC`);
    if (!row.runtime_exec) v.push(`${fn} must be executable by ${RUNTIME_ROLE}`);
  }

  return v;
}

/** Throws a single, operator-facing error if the definer ownership model is not intact. */
export async function assertDefinerModel(query: DbQuery): Promise<void> {
  const violations = await definerModelViolations(query);
  if (violations.length > 0) {
    throw new Error(
      `Partner Network definer ownership model is broken (DB-F1). Partner authentication would fail closed. ` +
        `Apply migration 0006 with a role that can provision ${DEFINER_ROLE}. Violations: ${violations.join("; ")}`
    );
  }
}
