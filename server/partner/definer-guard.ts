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
export const CREDIT_LIFECYCLE_DEFINER_ROLE = "partner_credit_lifecycle_definer";
export const CONNECTOR_RUNTIME_ROLE = "partner_connector_runtime";

const CREDIT_LIFECYCLE_FUNCTIONS = [
  {
    name: "partner_connector_release_submission_credit",
    arguments: "uuid, uuid, uuid, text",
    runtimeRole: CONNECTOR_RUNTIME_ROLE,
  },
  {
    name: "partner_destination_credit_hold_guard",
    arguments: "",
    runtimeRole: null,
  },
] as const;

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

/**
 * G6D's definer is deliberately separate from authentication. These checks are
 * invoked only by G6D lifecycle work, so an unavailable credit schema cannot
 * prevent the normal Partner Portal from starting or authenticating users.
 */
export async function partnerCreditDefinerModelViolations(query: DbQuery): Promise<string[]> {
  const violations: string[] = [];
  const role = await query(
    `SELECT rolbypassrls, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication
       FROM pg_roles WHERE rolname=$1`,
    [CREDIT_LIFECYCLE_DEFINER_ROLE]
  );
  if (role.rows.length !== 1) {
    violations.push(`role ${CREDIT_LIFECYCLE_DEFINER_ROLE} is missing`);
  } else {
    const r = role.rows[0] as Record<string, boolean>;
    if (!r.rolbypassrls) violations.push(`${CREDIT_LIFECYCLE_DEFINER_ROLE} must have BYPASSRLS`);
    if (r.rolcanlogin) violations.push(`${CREDIT_LIFECYCLE_DEFINER_ROLE} must be NOLOGIN`);
    if (r.rolsuper) violations.push(`${CREDIT_LIFECYCLE_DEFINER_ROLE} must be NOSUPERUSER`);
    if (r.rolcreaterole) violations.push(`${CREDIT_LIFECYCLE_DEFINER_ROLE} must be NOCREATEROLE`);
    if (r.rolcreatedb) violations.push(`${CREDIT_LIFECYCLE_DEFINER_ROLE} must be NOCREATEDB`);
    if (r.rolreplication) violations.push(`${CREDIT_LIFECYCLE_DEFINER_ROLE} must be NOREPLICATION`);
  }

  /**
   * Membership policy — deliberately capability-based, NOT row-based.
   *
   * WHY (hostile review, 2026-08-03): the previous check flagged ANY row in pg_auth_members.
   * On managed PostgreSQL (Neon) the provider creates an ADMIN-option-only membership row for
   * the project owner, granted by `cloud_admin`, which the deployment owner cannot remove.
   * Migration 0041 explicitly tolerates that row (it asserts only on the 'set'/'usage' forms of
   * pg_has_role, see 0041 L664-672) — but this guard did not, so the two contradicted each other
   * and the guard failed closed with HTTP 409 on every credit settlement on a real Neon database.
   * The test harness never caught it because it applies 0041 as a SUPERUSER, where the row does
   * not survive. Migration-time and runtime rules are now the same rule.
   *
   * What actually matters is whether a role can USE the definer, and which role that is:
   *  - ADMIN-option-only rows confer no runtime privilege -> tolerated.
   *  - The database owner may hold SET/INHERIT. It already owns every object and is BYPASSRLS,
   *    so membership grants it nothing it does not already have, and it is REQUIRED for the
   *    migration owner to run CREATE OR REPLACE / DROP FUNCTION against definer-owned functions
   *    (without it, 0041 is neither re-runnable nor rollback-capable) -> tolerated.
   *  - ANY OTHER role holding SET or INHERIT is a genuine privilege-escalation path, and in
   *    particular partner_runtime / partner_connector_runtime must never appear here -> violation.
   */
  const members = await query(
    `SELECT member.rolname,
            membership.admin_option,
            membership.inherit_option,
            membership.set_option,
            (member.oid = (SELECT datdba FROM pg_database WHERE datname = current_database()))
              AS is_database_owner
       FROM pg_auth_members membership
       JOIN pg_roles role ON role.oid=membership.roleid
       JOIN pg_roles member ON member.oid=membership.member
      WHERE role.rolname=$1
      ORDER BY member.rolname`,
    [CREDIT_LIFECYCLE_DEFINER_ROLE]
  );
  const usableBy = members.rows.filter((row) => {
    const r = row as Record<string, unknown>;
    // Only SET/INHERIT confer usable privilege; ADMIN alone does not.
    if (r.inherit_option !== true && r.set_option !== true) return false;
    return r.is_database_owner !== true;
  });
  if (usableBy.length > 0) {
    violations.push(
      `${CREDIT_LIFECYCLE_DEFINER_ROLE} must not be usable by any role other than the database owner ` +
        `(found ${usableBy.map((row) => String((row as Record<string, unknown>).rolname)).join(", ")})`
    );
  }

  for (const fn of CREDIT_LIFECYCLE_FUNCTIONS) {
    const functions = await query(
      `SELECT p.prosecdef,
              pg_get_userbyid(p.proowner) AS owner,
              COALESCE(array_to_string(p.proconfig, ','), '') AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              CASE WHEN $3::text IS NULL THEN false
                   ELSE has_function_privilege($3, p.oid, 'EXECUTE') END AS runtime_exec,
              COALESCE(string_agg(grantee.rolname, ',') FILTER (
                WHERE acl.privilege_type='EXECUTE'
                  AND acl.grantee <> 0
                  AND acl.grantee <> p.proowner
                  AND ($3::text IS NULL OR acl.grantee <> to_regrole($3))
              ), '') AS unexpected_execute_grantees
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace
         LEFT JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl ON true
         LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
        WHERE n.nspname='public'
          AND p.oid = to_regprocedure('public.' || $1 || '(' || $2 || ')')
        GROUP BY p.oid`,
      [fn.name, fn.arguments, fn.runtimeRole]
    );
    if (functions.rows.length !== 1) {
      violations.push(`function ${fn.name}(${fn.arguments}) is missing`);
      continue;
    }
    const row = functions.rows[0] as Record<string, unknown>;
    if (!row.prosecdef) violations.push(`${fn.name} must be SECURITY DEFINER`);
    if (row.owner !== CREDIT_LIFECYCLE_DEFINER_ROLE) {
      violations.push(`${fn.name} must be owned by ${CREDIT_LIFECYCLE_DEFINER_ROLE} (is ${String(row.owner)})`);
    }
    if (row.config !== "search_path=pg_catalog, public, pg_temp") {
      violations.push(`${fn.name} must pin search_path to pg_catalog, public, pg_temp`);
    }
    if (row.public_exec) violations.push(`${fn.name} must NOT be executable by PUBLIC`);
    if (fn.runtimeRole && !row.runtime_exec) violations.push(`${fn.name} must be executable by ${fn.runtimeRole}`);
    const unexpected = String(row.unexpected_execute_grantees ?? "");
    if (unexpected) {
      violations.push(`${fn.name} has unexpected EXECUTE grantee(s): ${unexpected}`);
    }
  }

  const recordUpdate = await query(
    `SELECT has_table_privilege($1, 'partner_connector_records', 'UPDATE') AS update_grant`,
    [CREDIT_LIFECYCLE_DEFINER_ROLE]
  );
  if ((recordUpdate.rows[0] as Record<string, boolean> | undefined)?.update_grant) {
    violations.push(`${CREDIT_LIFECYCLE_DEFINER_ROLE} must not have UPDATE on partner_connector_records`);
  }
  return violations;
}

export async function assertPartnerCreditDefinerModel(query: DbQuery): Promise<void> {
  const violations = await partnerCreditDefinerModelViolations(query);
  if (violations.length > 0) {
    throw new Error(`Partner G6D lifecycle definer model is broken. Violations: ${violations.join("; ")}`);
  }
}
