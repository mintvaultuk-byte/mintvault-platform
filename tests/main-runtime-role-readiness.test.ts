import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { RELEASE_READINESS_SQL } from "../server/readiness";
import { closePartnerPools, resolvePartnerAdminDatabaseUrl } from "../server/partner/db";
import {
  partnerOperationalReadAuthorityReady,
  REQUIRED_PARTNER_OPERATIONAL_LOCK_RELATIONS,
  REQUIRED_PARTNER_OPERATIONAL_READ_RELATIONS,
} from "../server/partner/operational-authority";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const FILENAME = "0121_main_runtime_role_authority.sql";
let cluster: DisposablePostgres17;
let admin: Client;
let runtime: Client;
let savedEnv: Record<string, string | undefined> = {};

function migration() {
  const found = listMigrationFiles().find((candidate) => candidate.filename === FILENAME);
  if (!found) throw new Error(`${FILENAME} missing`);
  return found;
}

async function runtimeReady(): Promise<boolean> {
  const result = await runtime.query<{ runtime_authority_ready: boolean }>(RELEASE_READINESS_SQL, [
    [],
    [],
    [],
    [],
    true,
  ]);
  return result.rows[0]?.runtime_authority_ready === true;
}

beforeAll(async () => {
  cluster = await startPostgres17("main-runtime-role-readiness");
  admin = new Client({ connectionString: cluster.url });
  await admin.connect();
  await admin.query(`
    CREATE TABLE certificates (id bigserial PRIMARY KEY, status text NOT NULL);
    CREATE TABLE session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
    CREATE TABLE partner_applications (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE partner_organisations (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE print_batches (id serial PRIMARY KEY);
    CREATE TABLE print_events (id serial PRIMARY KEY);
    CREATE TABLE label_prints (id serial PRIMARY KEY);
    CREATE TABLE label_overrides (id serial PRIMARY KEY);
    CREATE TABLE reprint_log (id serial PRIMARY KEY);
    CREATE TABLE audit_log (
      id serial PRIMARY KEY,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      action text NOT NULL,
      admin_user text,
      details jsonb DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await applyMigrations(admin, [migration()]);
  await admin.query(`
    CREATE ROLE mintvault_readiness_login LOGIN PASSWORD 'synthetic' INHERIT
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    GRANT mintvault_app TO mintvault_readiness_login;
    CREATE ROLE partner_admin_readiness_login LOGIN PASSWORD 'synthetic-admin' INHERIT
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  `);
  for (const relation of REQUIRED_PARTNER_OPERATIONAL_READ_RELATIONS) {
    if (relation !== "partner_organisations") {
      await admin.query(`CREATE TABLE IF NOT EXISTS ${relation} (id integer)`);
    }
    await admin.query(`GRANT SELECT ON ${relation} TO partner_admin_readiness_login`);
  }
  for (const relation of REQUIRED_PARTNER_OPERATIONAL_LOCK_RELATIONS) {
    await admin.query(`GRANT UPDATE ON ${relation} TO partner_admin_readiness_login`);
  }
  const url = new URL(cluster.url);
  url.username = "mintvault_readiness_login";
  url.password = "synthetic";
  runtime = new Client({ connectionString: url.toString() });
  await runtime.connect();
  savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
    PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
  };
  const adminUrl = new URL(cluster.url);
  adminUrl.username = "partner_admin_readiness_login";
  adminUrl.password = "synthetic-admin";
  process.env.NODE_ENV = "test";
  process.env.MINTVAULT_DATABASE_URL = url.toString();
  process.env.PARTNER_ADMIN_DATABASE_URL = adminUrl.toString();
}, 60_000);

afterAll(async () => {
  await closePartnerPools();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await runtime?.end().catch(() => {});
  await admin?.end().catch(() => {});
  await cluster?.stop();
});

describe("main database runtime readiness authority", () => {
  it("never falls back from Partner admin authority to the restricted production runtime URL", () => {
    expect(() =>
      resolvePartnerAdminDatabaseUrl({
        NODE_ENV: "production",
        MINTVAULT_DATABASE_URL: "postgres://runtime@db.invalid/mintvault",
      })
    ).toThrow(/PARTNER_ADMIN_DATABASE_URL is required/);
    expect(
      resolvePartnerAdminDatabaseUrl({
        NODE_ENV: "production",
        MINTVAULT_DATABASE_URL: "postgres://runtime@db.invalid/mintvault",
        PARTNER_ADMIN_DATABASE_URL: "postgres://partner-admin@db.invalid/mintvault",
      })
    ).toBe("postgres://partner-admin@db.invalid/mintvault");
    expect(
      resolvePartnerAdminDatabaseUrl({
        NODE_ENV: "test",
        MINTVAULT_DATABASE_URL: "postgres://local@127.0.0.1/test",
      })
    ).toBe("postgres://local@127.0.0.1/test");
  });

  it("accepts only the inheriting, non-owner, unprivileged mintvault_app LOGIN", async () => {
    await expect(runtimeReady()).resolves.toBe(true);

    await admin.query("ALTER ROLE mintvault_readiness_login NOINHERIT");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("ALTER ROLE mintvault_readiness_login INHERIT");

    await admin.query("GRANT SELECT ON partner_organisations TO mintvault_readiness_login");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("REVOKE SELECT ON partner_organisations FROM mintvault_readiness_login");

    await admin.query("ALTER TABLE certificates OWNER TO mintvault_readiness_login");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("ALTER TABLE certificates OWNER TO postgres");
    await admin.query("GRANT SELECT, INSERT, UPDATE ON certificates TO mintvault_app");

    await admin.query("GRANT pg_read_all_data TO mintvault_readiness_login");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("REVOKE pg_read_all_data FROM mintvault_readiness_login");

    await admin.query("ALTER ROLE mintvault_readiness_login SUPERUSER");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("ALTER ROLE mintvault_readiness_login NOSUPERUSER");

    await expect(runtimeReady()).resolves.toBe(true);
  });

  it("fails closed on print relation and owned-sequence privilege drift", async () => {
    await expect(runtimeReady()).resolves.toBe(true);

    await admin.query("REVOKE INSERT ON print_events FROM mintvault_app");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("GRANT INSERT ON print_events TO mintvault_app");

    await admin.query("GRANT UPDATE ON audit_log TO mintvault_app");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("REVOKE UPDATE ON audit_log FROM mintvault_app");

    await admin.query("GRANT DELETE ON print_batches TO mintvault_app");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("REVOKE DELETE ON print_batches FROM mintvault_app");

    await admin.query("REVOKE USAGE ON SEQUENCE print_events_id_seq FROM mintvault_app");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("GRANT USAGE ON SEQUENCE print_events_id_seq TO mintvault_app");

    await admin.query("GRANT UPDATE ON SEQUENCE audit_log_id_seq TO mintvault_app");
    await expect(runtimeReady()).resolves.toBe(false);
    await admin.query("REVOKE UPDATE ON SEQUENCE audit_log_id_seq FROM mintvault_app");

    await expect(runtimeReady()).resolves.toBe(true);
  });

  it("executes the append-only reprint receipt read and insert under the production runtime role", async () => {
    await runtime.query("BEGIN");
    try {
      await runtime.query("SELECT pg_advisory_xact_lock($1)", [8_422_611]);
      await expect(
        runtime.query(
          `SELECT details FROM audit_log
            WHERE entity_type='print_reprint_request'
              AND entity_id='print_reprint_request_runtime_proof'
              AND action='idempotency_committed'
            ORDER BY id`
        )
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        runtime.query(
          `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details)
           VALUES ('print_reprint_request','print_reprint_request_runtime_proof',
                   'idempotency_committed','runtime-proof','{}'::jsonb)`
        )
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await runtime.query("ROLLBACK");
    }
  });

  it("requires the distinct Partner authority to read every operational relation", async () => {
    await expect(partnerOperationalReadAuthorityReady()).resolves.toBe(true);
    await admin.query("REVOKE SELECT ON partner_station_calibrations FROM partner_admin_readiness_login");
    await expect(partnerOperationalReadAuthorityReady()).resolves.toBe(false);
    await admin.query("GRANT SELECT ON partner_station_calibrations TO partner_admin_readiness_login");
    await admin.query("REVOKE SELECT ON certificates FROM partner_admin_readiness_login");
    await expect(partnerOperationalReadAuthorityReady()).resolves.toBe(false);
    await admin.query("GRANT SELECT ON certificates TO partner_admin_readiness_login");
    await admin.query("REVOKE SELECT ON scanner_capture_sessions FROM partner_admin_readiness_login");
    await expect(partnerOperationalReadAuthorityReady()).resolves.toBe(false);
    await admin.query("GRANT SELECT ON scanner_capture_sessions TO partner_admin_readiness_login");
    await admin.query("REVOKE UPDATE ON partner_connector_records FROM partner_admin_readiness_login");
    await expect(partnerOperationalReadAuthorityReady()).resolves.toBe(false);
    await admin.query("GRANT UPDATE ON partner_connector_records TO partner_admin_readiness_login");
    await expect(partnerOperationalReadAuthorityReady()).resolves.toBe(true);
  });
});
