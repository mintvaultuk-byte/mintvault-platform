/**
 * Standing guard on the Partner DB ROLE CAPABILITY MATRIX.
 *
 * WHY THIS EXISTS. The Partner platform's isolation rests on a small set of role attributes:
 * exactly two roles may hold BYPASSRLS (the SECURITY DEFINER owners), and the two application
 * runtime roles must hold neither BYPASSRLS nor SUPERUSER, or every row-level policy in the schema
 * becomes decorative. Those attributes are asserted today only in scattered per-role checks — and
 * the one covering partner_connector_runtime lives in a suite that currently aborts in beforeAll
 * (tests/partner-connector-migration.test.ts fails at 0018 on a missing audit_log fixture, which
 * vitest renders as "14 skipped"), so it is not actually running. A single guard over the whole
 * matrix cannot rot that way.
 *
 * It also generalises migration 0006's SEC-1 hardening across every SECURITY DEFINER function
 * rather than the three it happened to fix: a definer function that is reachable by PUBLIC, or
 * whose search_path lets a caller's pg_temp shadow a table name, hands an attacker the definer's
 * BYPASSRLS. 0006's header documents that exact escalation for the pre-auth lookups; nothing
 * stopped a later migration from adding a fourth definer function without the same care.
 *
 * These are INVARIANTS, not a snapshot: each assertion states a security property and names the
 * roles/functions it holds for, so adding a legitimate new role or function requires a conscious
 * edit here.
 *
 * The suite starts and owns its own disposable PostgreSQL 17 cluster.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  migratorUrlFrom,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";

let cluster: DisposablePostgres17;
let admin: Client;

/** The application runtime roles. A partner request is always served as one of these. */
const RUNTIME_ROLES = ["partner_runtime", "partner_connector_runtime"] as const;

/**
 * The ONLY roles permitted to bypass row-level security. Both exist solely to own SECURITY DEFINER
 * functions that must read across tenant context (pre-auth lookups; credit settlement). Adding a
 * third is a deliberate architectural decision, not an incidental migration side effect.
 */
const BYPASSRLS_ROLES = ["partner_definer", "partner_credit_lifecycle_definer"] as const;

describe("Partner DB role capability matrix (disposable cluster)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-role-capability-matrix");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();

    await provisionRealisticRoles(admin);
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_credit_lifecycle_definer
           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE pn_credit_schema_owner
           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query(
      "GRANT partner_credit_lifecycle_definer TO pn_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE"
    );

    await createMintvaultCertificatesTable(admin);
    await createMintvaultLabelPrintsTable(admin);
    await admin.query("CREATE TABLE IF NOT EXISTS users (id varchar primary key, email varchar unique)");
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial primary key, user_id varchar not null, tracking_number text not null unique)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
    );
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
      admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
    for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }

    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      const all = listMigrationFiles();
      await applyMigrations(
        migrator,
        all.filter((f) => Number(f.number) <= 41),
        { allowDestructive: true }
      );
      await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
      await applyMigrations(migrator, all, { allowDestructive: true });
    } finally {
      await migrator.end();
    }
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("the runtime roles can neither bypass RLS nor log in directly", async () => {
    for (const role of RUNTIME_ROLES) {
      const { rows } = await admin.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolreplication: boolean;
      }>(
        `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication
           FROM pg_roles WHERE rolname = $1`,
        [role]
      );
      expect(rows, `${role} must exist`).toHaveLength(1);
      // BYPASSRLS or SUPERUSER on a runtime role would silently void every tenant-isolation policy.
      expect(rows[0].rolbypassrls, `${role} must not bypass RLS`).toBe(false);
      expect(rows[0].rolsuper, `${role} must not be superuser`).toBe(false);
      // NOLOGIN: these are reached by membership from the application's login role, so a leaked
      // password can never authenticate AS the privileged role itself.
      expect(rows[0].rolcanlogin, `${role} must be NOLOGIN`).toBe(false);
      expect(rows[0].rolcreaterole, `${role} must not create roles`).toBe(false);
      expect(rows[0].rolcreatedb, `${role} must not create databases`).toBe(false);
      expect(rows[0].rolreplication, `${role} must not replicate`).toBe(false);
    }
  });

  it("exactly two roles hold BYPASSRLS, and they are the SECURITY DEFINER owners", async () => {
    const { rows } = await admin.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles
        WHERE rolbypassrls AND NOT rolsuper AND rolname NOT LIKE 'pg\\_%'
        ORDER BY rolname`
    );
    expect(rows.map((r) => r.rolname)).toEqual([...BYPASSRLS_ROLES].sort());
  });

  it("no partner role is a superuser", async () => {
    const { rows } = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolsuper AND rolname LIKE 'partner\\_%' ORDER BY rolname"
    );
    expect(rows).toEqual([]);
  });

  it("every SECURITY DEFINER function is owned by a BYPASSRLS definer role", async () => {
    // A definer function owned by an ordinary role cannot cross FORCE RLS and fails open/closed
    // unpredictably; one owned by anything MORE privileged than these two is an escalation.
    const { rows } = await admin.query<{ proname: string; owner: string }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY p.proname`
    );
    expect(rows.length, "expected SECURITY DEFINER functions to exist").toBeGreaterThan(0);
    const offenders = rows.filter((r) => !(BYPASSRLS_ROLES as readonly string[]).includes(r.owner));
    expect(offenders, "SECURITY DEFINER functions with an unexpected owner").toEqual([]);
  });

  it("every SECURITY DEFINER function pins search_path with pg_temp LAST", async () => {
    /**
     * 0006's SEC-1 finding, generalised. With `search_path = public` alone, PostgreSQL still
     * searches the caller's pg_temp FIRST for relation names, so a caller who can
     * CREATE TEMP TABLE partner_users shadows the real table — and the function, running with the
     * definer's BYPASSRLS, reads the attacker's table. Naming pg_temp explicitly LAST removes the
     * implicit-first behaviour. A definer function with NO search_path at all is worse still.
     */
    const { rows } = await admin.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY p.proname`
    );
    for (const fn of rows) {
      const setting = (fn.proconfig ?? []).find((c) => c.startsWith("search_path="));
      expect(setting, `${fn.proname} must pin an explicit search_path`).toBeDefined();
      const entries = setting!.slice("search_path=".length).split(",").map((s) => s.trim());
      expect(entries, `${fn.proname} must list pg_temp explicitly`).toContain("pg_temp");
      expect(entries[entries.length - 1], `${fn.proname} must list pg_temp LAST`).toBe("pg_temp");
    }
  });

  it("no SECURITY DEFINER function is executable by PUBLIC", async () => {
    // EXECUTE granted to PUBLIC on a BYPASSRLS-owned function hands its privilege to every role in
    // the cluster, including the tenant-scoped runtime roles.
    const { rows } = await admin.query<{ proname: string; acl: string | null }>(
      `SELECT p.proname, p.proacl::text AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY p.proname`
    );
    for (const fn of rows) {
      // A NULL ACL means default privileges, which for functions INCLUDES PUBLIC EXECUTE.
      expect(fn.acl, `${fn.proname} must have an explicit ACL (a null ACL grants PUBLIC EXECUTE)`).not.toBeNull();
      // "=X/owner" (an entry with an empty grantee) is the PUBLIC grant.
      expect(fn.acl, `${fn.proname} must not grant EXECUTE to PUBLIC`).not.toMatch(/(^|[{,])=[a-zA-Z]*X/);
    }
  });

  it("the tenant-scoped runtime login cannot reach a BYPASSRLS role by SET ROLE", async () => {
    /**
     * The escalation that matters at request time: if the portal's database login could SET ROLE
     * into a BYPASSRLS role, every policy in the schema would be one statement away from irrelevant.
     *
     * THIS MUST USE ITS OWN CONNECTION. PostgreSQL authorises SET ROLE against the SESSION user,
     * not the current role — so issuing `SET ROLE partner_runtime; SET ROLE partner_definer;` on
     * the superuser admin connection succeeds and proves nothing. An earlier draft of this test did
     * exactly that and passed vacuously in the direction that mattered.
     */
    await admin.query("DROP ROLE IF EXISTS partner_app_matrix_rt").catch(() => {});
    await admin.query("CREATE ROLE partner_app_matrix_rt LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_matrix_rt");
    const url = new URL(cluster.url);
    url.username = "partner_app_matrix_rt";
    url.password = "synthetic";
    const app = new Client({ connectionString: url.toString() });
    await app.connect();
    try {
      // Sanity: the login really can become the runtime role, so a refusal below is meaningful.
      await expect(app.query("SET ROLE partner_runtime")).resolves.toBeDefined();
      await app.query("RESET ROLE");
      for (const definer of BYPASSRLS_ROLES) {
        await expect(app.query(`SET ROLE ${definer}`)).rejects.toThrow(/permission denied to set role/);
      }
    } finally {
      await app.end().catch(() => {});
      await admin.query("DROP ROLE IF EXISTS partner_app_matrix_rt").catch(() => {});
    }
  });
});
