/**
 * OWNER-GATED ACTION PROOF — migration 0006 leaves the migration login a member of
 * partner_definer (BYPASSRLS) and never revokes it.
 *
 * Runs entirely on a DISPOSABLE PostgreSQL 17 cluster created and destroyed by this script.
 * It never touches staging or production. See docs/owner-gated-partner-definer-revoke.md.
 */
import pg from "pg";
import { startPostgres17 } from "../../tests/helpers/postgres17-cluster";
import {
  MIGRATOR_ROLE,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
  applyMigrationsRealistic,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  migratorUrlFrom,
  provisionRealisticRoles,
} from "../../tests/helpers/partner-realistic-db";

function log(s: string): void {
  console.log(s);
}

async function seedMintVaultTables(admin: pg.Client): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)");
  await admin.query(`CREATE TABLE submissions (
    id serial PRIMARY KEY, user_id varchar, status varchar(30) NOT NULL DEFAULT 'draft',
    tracking_number text NOT NULL UNIQUE, deleted_at timestamptz,
    shipped_at timestamptz, completed_at timestamptz,
    status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(
    "CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL REFERENCES submissions(id))"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await createMintvaultCertificatesTable(admin);
  await createMintvaultLabelPrintsTable(admin);
  await admin.query(
    "CREATE TABLE cert_counter (id integer PRIMARY KEY DEFAULT 1, last_issued integer NOT NULL DEFAULT 0)"
  );
  await admin.query("CREATE UNIQUE INDEX uq_submission_items_submission ON submission_items (submission_id, id)");
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "audit_log",
    "certificates",
    "label_prints",
    "cert_counter",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO ${MIGRATOR_ROLE}`);
  }
}

interface Membership {
  grantor: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

async function membership(c: pg.Client): Promise<Membership[]> {
  const r = await c.query<Membership>(
    `SELECT g.rolname AS grantor, m.admin_option, m.inherit_option, m.set_option
       FROM pg_auth_members m
       JOIN pg_roles role   ON role.oid   = m.roleid
       JOIN pg_roles member ON member.oid = m.member
       JOIN pg_roles g      ON g.oid      = m.grantor
      WHERE role.rolname = 'partner_definer' AND member.rolname = $1`,
    [MIGRATOR_ROLE]
  );
  return r.rows;
}

async function capability(c: pg.Client): Promise<{ set: boolean; usage: boolean }> {
  const r = await c.query<{ s: boolean; u: boolean }>(
    `SELECT pg_has_role($1,'partner_definer','set') AS s, pg_has_role($1,'partner_definer','usage') AS u`,
    [MIGRATOR_ROLE]
  );
  return { set: r.rows[0].s, usage: r.rows[0].u };
}

/** Try to read across tenants by escalating into the BYPASSRLS definer. */
async function crossTenantRead(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SET ROLE partner_definer");
    const r = await c.query<{ n: string; email: string | null }>(
      "SELECT count(*)::text AS n, min(email) AS email FROM partner_users"
    );
    return `SET ROLE SUCCEEDED — read ${r.rows[0].n} partner_users row(s) with NO tenant context; sample email=${
      r.rows[0].email ?? "(none)"
    }`;
  } catch (e) {
    return `blocked: ${(e as Error).message}`;
  } finally {
    await c.end().catch(() => {});
  }
}

async function seedTwoTenants(admin: pg.Client): Promise<void> {
  await admin.query(
    `INSERT INTO partner_organisations (legal_name, status) VALUES ('Tenant A','ACTIVE'), ('Tenant B','ACTIVE')`
  );
  await admin.query(
    `INSERT INTO partner_users (tenant_id, partner_id, email, password_hash, status)
       SELECT o.id, o.id, lower(replace(o.legal_name,' ','-'))||'@example.test', '$2b$10$notarealhash', 'ACTIVE'
         FROM partner_organisations o`
  );
}

async function main(): Promise<void> {
  const cluster = await startPostgres17("owner-gated-definer-revoke");
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  try {
    await provisionRealisticRoles(admin);
    await seedMintVaultTables(admin);
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);
    await seedTwoTenants(admin).catch((e) => log(`  (seed note: ${(e as Error).message})`));
    const migratorUrl = migratorUrlFrom(cluster.url);

    log("========== BEFORE ==========");
    log(`membership rows for ${MIGRATOR_ROLE} on partner_definer:`);
    for (const m of await membership(admin)) log(`  ${JSON.stringify(m)}`);
    log(`capability: ${JSON.stringify(await capability(admin))}`);
    log(
      `bypassrls of partner_definer: ${(await admin.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='partner_definer'")).rows[0]?.rolbypassrls}`
    );
    log(`cross-tenant read as ${MIGRATOR_ROLE}: ${await crossTenantRead(migratorUrl)}`);

    log("\n========== WHY A MIGRATION CANNOT FIX THIS ==========");
    const self = new pg.Client({ connectionString: migratorUrl });
    await self.connect();
    for (const stmt of [
      `REVOKE partner_definer FROM ${MIGRATOR_ROLE}`,
      `REVOKE ADMIN OPTION FOR partner_definer FROM ${MIGRATOR_ROLE}`,
    ]) {
      try {
        await self.query(stmt);
        log(`  as ${MIGRATOR_ROLE}: "${stmt}" -> SUCCEEDED`);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        log(`  as ${MIGRATOR_ROLE}: "${stmt}" -> ${err.code} ${err.message}`);
      }
    }
    await self.end();
    log(`  capability after the migrator's own attempt: ${JSON.stringify(await capability(admin))}`);
    log(`  cross-tenant read still possible: ${await crossTenantRead(migratorUrl)}`);

    log("\n========== THE OWNER-GATED ACTION (executed as the GRANTOR) ==========");
    for (const stmt of [
      `REVOKE ADMIN OPTION FOR partner_definer FROM ${MIGRATOR_ROLE}`,
      `REVOKE partner_definer FROM ${MIGRATOR_ROLE}`,
    ]) {
      await admin.query(stmt);
      log(`  as grantor: "${stmt}" -> OK`);
    }

    log("\n========== AFTER ==========");
    const after = await membership(admin);
    log(`membership rows: ${after.length === 0 ? "(none)" : JSON.stringify(after)}`);
    log(`capability: ${JSON.stringify(await capability(admin))}`);
    log(`cross-tenant read as ${MIGRATOR_ROLE}: ${await crossTenantRead(migratorUrl)}`);

    log("\n========== REGRESSION: the partner runtime still works ==========");
    for (const fn of ["partner_auth_lookup", "partner_session_lookup", "partner_reset_token_tenant"]) {
      const r = await admin.query<{ owner: string }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.proname=$1`,
        [fn]
      );
      log(`  ${fn} owner = ${r.rows[0]?.owner} (unchanged by the revoke)`);
    }
    // Exercise the pre-auth path as the RUNTIME role — the only role 0006 grants EXECUTE to.
    await admin.query(`DO $$ BEGIN
        CREATE ROLE pn_runtime_login LOGIN PASSWORD 'disposable-proof-pw' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query("GRANT partner_runtime TO pn_runtime_login");
    const runtimeUrl = (() => {
      const u = new URL(cluster.url);
      u.username = "pn_runtime_login";
      u.password = "disposable-proof-pw";
      return u.toString();
    })();
    const rt = new pg.Client({ connectionString: runtimeUrl });
    await rt.connect();
    const auth = await rt.query("SELECT * FROM partner_auth_lookup('tenant-a@example.test')");
    log(`  partner_auth_lookup as partner_runtime -> ${auth.rowCount} row(s) (SECURITY DEFINER path intact)`);
    await rt.end();

    log("\n========== ROLLBACK (re-grant, as the grantor) ==========");
    await admin.query(`GRANT partner_definer TO ${MIGRATOR_ROLE}`);
    log(`  re-granted; capability: ${JSON.stringify(await capability(admin))}`);
    log(`  cross-tenant read restored: ${await crossTenantRead(migratorUrl)}`);
  } finally {
    await admin.end().catch(() => {});
    await cluster.stop().catch(() => {});
  }
}

void main();
