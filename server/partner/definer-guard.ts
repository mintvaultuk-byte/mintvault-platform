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

/** Roles that must NEVER be able to reach a definer role, named for a precise operator message. */
const RUNTIME_ROLES_THAT_MUST_NOT_REACH_DEFINERS = [RUNTIME_ROLE, CONNECTOR_RUNTIME_ROLE] as const;

/**
 * TRANSITIVE reachability of a SECURITY DEFINER role.
 *
 * WHY THIS IS NOT A pg_auth_members QUERY. The previous guard read pg_auth_members directly, which
 * sees exactly ONE hop of the role graph. PostgreSQL role membership is transitive, so
 *
 *     GRANT partner_credit_lifecycle_definer TO ops_intermediate;
 *     GRANT ops_intermediate TO partner_runtime;
 *
 * gives partner_runtime full inherited use of the definer while producing NO pg_auth_members row
 * linking the two. The guard reported healthy and the escalation path was invisible. Chains of
 * arbitrary depth have the same effect.
 *
 * `pg_has_role` walks the whole graph, and its two capability forms are the ones that actually
 * matter — this is the same test migration 0041 applies to itself (see its closing DO block):
 *   USAGE — inherited privilege: the role silently acts with the definer's rights, no SET needed.
 *   SET   — SET ROLE capability: the role can deliberately become the definer.
 *
 * `SET` is the correct form and `MEMBER` is NOT a substitute. pg_has_role(..., 'MEMBER') reports
 * catalog membership and is TRUE for an ADMIN-option-only row, so using it would flag exactly the
 * provider-granted row this guard must tolerate — reintroducing the HTTP 409 described below.
 *
 * ADMIN alone is deliberately NOT a capability: on managed PostgreSQL (Neon) the provider grants
 * the project owner an ADMIN-option-only row via `cloud_admin` which the deployment owner cannot
 * remove. Flagging it made this guard contradict 0041 and fail closed with HTTP 409 on every
 * credit settlement against a real Neon database.
 *
 * EXPLICITLY DOCUMENTED EXCEPTIONS — the only tolerated maintenance capability:
 *   - the DATABASE OWNER (pg_database.datdba). It already owns every object, and it REQUIRES
 *     INHERIT to run CREATE OR REPLACE / DROP FUNCTION against definer-owned functions. Without it
 *     0041 is neither re-runnable nor rollback-capable, and 0042 cannot be applied at all.
 *   - SUPERUSERS. pg_has_role reports true for a superuser against every role by definition; a
 *     superuser is outside this model entirely and cannot be constrained by grants.
 * Every other role with USAGE or SET is a genuine privilege-escalation path.
 */
export async function definerReachabilityViolations(query: DbQuery, definerRole: string): Promise<string[]> {
  const violations: string[] = [];
  const reachable = await query(
    `SELECT r.rolname,
            r.rolsuper,
            pg_has_role(r.oid, d.oid, 'USAGE') AS inherits,
            pg_has_role(r.oid, d.oid, 'SET')   AS can_set_role,
            (r.oid = (SELECT datdba FROM pg_database WHERE datname = current_database()))
              AS is_database_owner
       FROM pg_roles r
       JOIN pg_roles d ON d.rolname = $1
      WHERE r.rolname NOT LIKE 'pg\\_%'
        AND r.rolname <> $1
      ORDER BY r.rolname`,
    [definerRole]
  );

  const offenders = reachable.rows.filter((row) => {
    const r = row as Record<string, unknown>;
    if (r.inherits !== true && r.can_set_role !== true) return false;
    if (r.rolsuper === true) return false; // outside the model by definition
    return r.is_database_owner !== true; // documented maintenance capability
  });

  for (const row of offenders) {
    const r = row as Record<string, unknown>;
    const how = [r.inherits === true ? "USAGE" : null, r.can_set_role === true ? "SET ROLE" : null]
      .filter(Boolean)
      .join(" + ");
    const name = String(r.rolname);
    // Name the runtime roles explicitly: this is the escalation that matters most.
    const severity = (RUNTIME_ROLES_THAT_MUST_NOT_REACH_DEFINERS as readonly string[]).includes(name)
      ? `RUNTIME ROLE ${name} can reach ${definerRole}`
      : `${name} can reach ${definerRole}`;
    violations.push(`${severity} (${how}) — only the database owner may hold maintenance capability`);
  }
  return violations;
}

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

  // 1b) partner_definer must be unreachable too. This role owns the PRE-AUTH lookups and is
  //     BYPASSRLS, so a role that can inherit it reads every tenant's credentials across the whole
  //     Partner Network. It previously had NO membership check of any kind — only its attribute
  //     set was verified — so the entire escalation surface was unguarded on the authentication
  //     definer while being (partially) guarded on the credit definer.
  v.push(...(await definerReachabilityViolations(query, DEFINER_ROLE)));

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

  violations.push(...(await definerReachabilityViolations(query, CREDIT_LIFECYCLE_DEFINER_ROLE)));

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
