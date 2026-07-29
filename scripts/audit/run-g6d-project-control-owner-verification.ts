/**
 * Disposable verification only. It proves the governed migration split against a new local PG17
 * cluster: 0001–0018 as the restricted migrator, 0019 and frozen Project Control 0020 as the
 * deployment owner. It never reads a configured application database.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { applyMigrations, listMigrationFiles } from "../db/migrate";
import { migratorUrlFrom, provisionRealisticRoles } from "../../tests/helpers/partner-realistic-db";
import { startPostgres17 } from "../../tests/helpers/postgres17-cluster";

const frozenProjectControl = process.env.MINTVAULT_PROJECT_CONTROL_CANDIDATE;

if (!frozenProjectControl) {
  throw new Error("MINTVAULT_PROJECT_CONTROL_CANDIDATE must identify the frozen Project Control source worktree.");
}

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

function migration(filename: string, path: string) {
  const sql = readFileSync(path, "utf8");
  return {
    number: filename.slice(0, 4),
    filename,
    path,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
    noTransaction: /--\s*migrate:no-transaction/i.test(sql),
  };
}

async function seedMintVaultPrerequisites(admin: PgClient): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function assertAppendOnly(
  admin: PgClient,
  insert: string,
  update: string,
  expectedMessage: string
): Promise<void> {
  await admin.query(insert);
  try {
    await admin.query(update);
  } catch (error) {
    if ((error as Error).message.includes(expectedMessage)) return;
  }
  throw new Error(`Expected append-only rejection containing: ${expectedMessage}`);
}

async function main(): Promise<void> {
  const cluster = await startPostgres17("g6d-project-control-owner-verification");
  const admin = new Client({ connectionString: cluster.url });
  await admin.connect();
  try {
    const version = await admin.query<{ server_version: string }>("SHOW server_version");
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
    await provisionRealisticRoles(admin);
    await seedMintVaultPrerequisites(admin);

    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      const base = listMigrationFiles().filter((file) => Number(file.number) <= 18);
      const first = await applyMigrations(migrator, base);
      console.log(`APPLIED_0001_0018=${first.applied.join(",")}`);
    } finally {
      await migrator.end();
    }

    const g6d = migration(
      "0027_partner_submission_credit_lifecycle.sql",
      resolve("migrations/0027_partner_submission_credit_lifecycle.sql")
    );
    const projectControl = migration(
      "0020_project_control_dashboard.sql",
      resolve(frozenProjectControl, "migrations/0020_project_control_dashboard.sql")
    );
    const g6dResult = await applyMigrations(admin, [g6d]);
    const projectControlResult = await applyMigrations(admin, [projectControl]);

    const journal = await admin.query<{ filename: string; status: string; applied_by: string }>(
      "SELECT filename,status,applied_by FROM schema_migrations WHERE filename ~ '^(00(0[1-9]|1[0-9]|20)_).*' ORDER BY filename"
    );
    const owner = await admin.query<{
      role: string;
      bypassrls: boolean;
      canlogin: boolean;
      superuser: boolean;
    }>(`
      SELECT role.rolname AS role, role.rolbypassrls AS bypassrls,
             role.rolcanlogin AS canlogin, role.rolsuper AS superuser
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        JOIN pg_roles role ON role.oid=procedure.proowner
       WHERE namespace.nspname='public'
         AND procedure.oid='partner_connector_release_submission_credit(uuid,uuid,uuid,text)'::regprocedure
    `);
    const privileges = await admin.query<{
      direct_reservation_update: boolean;
      narrow_release_execute: boolean;
      runtime_schema_create: boolean;
    }>(`
      SELECT has_table_privilege('partner_connector_runtime','partner_credit_reservations','UPDATE') AS direct_reservation_update,
             has_function_privilege('partner_connector_runtime','partner_connector_release_submission_credit(uuid,uuid,uuid,text)','EXECUTE') AS narrow_release_execute,
             has_schema_privilege('partner_connector_runtime','public','CREATE') AS runtime_schema_create
    `);

    await assertAppendOnly(
      admin,
      `INSERT INTO partner_credit_accounting_exceptions
        (tenant_id,event_type,reason_code,idempotency_key)
       VALUES ('00000000-0000-0000-0000-000000000019','settlement_exception','verification','g6d-owner-verification')`,
      "UPDATE partner_credit_accounting_exceptions SET reason_code='forged' WHERE idempotency_key='g6d-owner-verification'",
      "append-only"
    );
    await assertAppendOnly(
      admin,
      `INSERT INTO project_control_evidence
        (evidence_id,requirement_id,evidence_classification,source_kind,summary)
       VALUES ('g6d-owner-verification','MEGS-PCD-009','database','audit','disposable owner-role proof')`,
      "UPDATE project_control_evidence SET summary='forged' WHERE evidence_id='g6d-owner-verification'",
      "append-only"
    );

    console.log(`POSTGRES=${version.rows[0].server_version}`);
    console.log("PGVECTOR=installed");
    console.log(`APPLIED_0019=${g6dResult.applied.join(",")}`);
    console.log(`APPLIED_0020=${projectControlResult.applied.join(",")}`);
    console.log(`JOURNAL=${JSON.stringify(journal.rows)}`);
    console.log(`DEFINER_OWNER=${JSON.stringify(owner.rows[0])}`);
    console.log(`RUNTIME_BOUNDARY=${JSON.stringify(privileges.rows[0])}`);
    console.log("G6D_APPEND_ONLY=enforced");
    console.log("PROJECT_CONTROL_APPEND_ONLY=enforced");
  } finally {
    await admin.end().catch(() => {});
    await cluster.stop();
  }
}

await main();
