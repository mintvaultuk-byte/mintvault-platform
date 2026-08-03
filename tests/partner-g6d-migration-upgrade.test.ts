import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  migratorUrlFrom,
  PARTNER_MIGRATIONS_WITH_G6B,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { partnerCreditDefinerModelViolations } from "../server/partner/definer-guard";

let cluster: DisposablePostgres17;
let admin: Client;

async function seedMintVaultTables(): Promise<void> {
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

describe("G6D migration 0041 upgrade path", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-g6d-migration-upgrade");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_G6B);
    await applyMigrationsRealistic(admin, cluster.url, [
      "0018_correction_audit_index",
      "0041_partner_submission_credit_lifecycle",
    ]);
  });

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("requests explicit PostgreSQL 16+ SET permission for the temporary ownership transfer", () => {
    const migration = readFileSync("migrations/0041_partner_submission_credit_lifecycle.sql", "utf8");
    expect(migration).toContain("WITH SET TRUE");
    expect(migration).toContain("pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'set')");
    expect(migration).toContain("pg_has_role(current_user, 'partner_credit_lifecycle_definer', 'usage')");
    expect(migration).toContain("REVOKE ADMIN OPTION FOR partner_credit_lifecycle_definer");
  });

  it("adds the release function, immutable exception evidence and no direct connector accounting grants", async () => {
    const state = await admin.query<{
      release_function: string | null;
      exception_table: string | null;
      connector_update: boolean;
      connector_event_insert: boolean;
      connector_execute: boolean;
    }>(
      `SELECT to_regprocedure('public.partner_connector_release_submission_credit(uuid,uuid,uuid,text)')::text AS release_function,
              to_regclass('public.partner_credit_accounting_exceptions')::text AS exception_table,
              has_column_privilege('partner_connector_runtime','partner_credit_reservations','status','UPDATE') AS connector_update,
              has_column_privilege('partner_connector_runtime','partner_credit_reservation_events','event_type','INSERT') AS connector_event_insert,
              has_function_privilege('partner_connector_runtime','partner_connector_release_submission_credit(uuid,uuid,uuid,text)','EXECUTE') AS connector_execute`
    );
    expect(state.rows).toEqual([
      {
        release_function: "partner_connector_release_submission_credit(uuid,uuid,uuid,text)",
        exception_table: "partner_credit_accounting_exceptions",
        connector_update: false,
        connector_event_insert: false,
        connector_execute: true,
      },
    ]);
  });

  it("leaves no USABLE migration-role path into the lifecycle definer or direct G6D hold mutation", async () => {
    /**
     * REVISED 2026-08-03. This previously asserted `migrator_memberships = 0`, which was only
     * ever achievable because the harness applied 0041 as a SUPERUSER. On managed PostgreSQL the
     * provider (Neon's `cloud_admin`) grants the project owner an ADMIN-option membership row,
     * and because PostgreSQL 16+ records the grantor, 0041's closing `REVOKE ADMIN OPTION FOR`
     * cannot remove a row it did not grant. The row therefore SURVIVES in production.
     *
     * Asserting zero rows hid the real defect: `definer-guard.ts` treated that surviving row as
     * fatal, so credit settlement returned HTTP 409 on every real deployment while this test was
     * green. The correct invariant is not "no membership" but "no USABLE membership" — the row
     * may exist, but it must confer neither SET nor INHERIT.
     */
    const state = await admin.query<{
      usable_memberships: string;
      admin_only_memberships: string;
      definer_record_update: boolean;
    }>(
      `SELECT
         (SELECT count(*)::bigint
            FROM pg_auth_members membership
            JOIN pg_roles role ON role.oid=membership.roleid
            JOIN pg_roles member ON member.oid=membership.member
           WHERE role.rolname='partner_credit_lifecycle_definer'
             AND member.rolname='pn_migrator'
             AND (membership.set_option OR membership.inherit_option)) AS usable_memberships,
         (SELECT count(*)::bigint
            FROM pg_auth_members membership
            JOIN pg_roles role ON role.oid=membership.roleid
            JOIN pg_roles member ON member.oid=membership.member
           WHERE role.rolname='partner_credit_lifecycle_definer'
             AND member.rolname='pn_migrator'
             AND membership.admin_option
             AND NOT membership.set_option
             AND NOT membership.inherit_option) AS admin_only_memberships,
         has_table_privilege('partner_credit_lifecycle_definer','partner_connector_records','UPDATE')
           AS definer_record_update`
    );
    expect(state.rows).toEqual([
      { usable_memberships: "0", admin_only_memberships: "1", definer_record_update: false },
    ]);

    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      await expect(migrator.query("SET ROLE partner_credit_lifecycle_definer")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        migrator.query("UPDATE partner_credit_reservations SET status='released' WHERE false")
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        migrator.query(
          "INSERT INTO partner_credit_reservation_events (reservation_id,wallet_id,tenant_id,event_type,amount,idempotency_key,request_fingerprint,source,reason,actor_type) VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'released',1,'forged','forged','system','forged','system')"
        )
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await migrator.end();
    }

    /**
     * `partner_submission_credit_holds` is CREATED BY 0041, so under the realistic harness the
     * migration owner owns it and can therefore write to it — exactly as `neondb_owner` owns it
     * on staging (verified against the live catalogue). The previous assertion that the migrator
     * could NOT update it only held because the superuser harness left the table owned by
     * `postgres`; it was false comfort about a privilege boundary that does not exist.
     *
     * The boundary that IS real, and the one 0041 actually establishes, is that neither partner
     * RUNTIME role can reach the table at all. That is what is asserted here instead.
     */
    const runtimeReach = await admin.query<{ role: string; priv: string; allowed: boolean }>(
      `SELECT r.rolname AS role, p.priv, has_table_privilege(r.rolname,'partner_submission_credit_holds',p.priv) AS allowed
         FROM (VALUES ('partner_runtime'),('partner_connector_runtime')) AS r(rolname),
              (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS p(priv)
        ORDER BY r.rolname, p.priv`
    );
    expect(runtimeReach.rows.every((row) => row.allowed === false)).toBe(true);
  });

  it("registers both G6D definer functions and catches hardened-path drift", async () => {
    const query = (sql: string, params?: unknown[]) => admin.query(sql, params);
    await expect(partnerCreditDefinerModelViolations(query)).resolves.toEqual([]);
    await admin.query("CREATE ROLE g6d_unrelated_execute NOLOGIN");
    await admin.query(
      "GRANT EXECUTE ON FUNCTION partner_connector_release_submission_credit(uuid,uuid,uuid,text) TO g6d_unrelated_execute"
    );
    await expect(partnerCreditDefinerModelViolations(query)).resolves.toContain(
      "partner_connector_release_submission_credit has unexpected EXECUTE grantee(s): g6d_unrelated_execute"
    );
    await admin.query(
      "REVOKE EXECUTE ON FUNCTION partner_connector_release_submission_credit(uuid,uuid,uuid,text) FROM g6d_unrelated_execute"
    );
    await admin.query("DROP ROLE g6d_unrelated_execute");
    await admin.query(
      "ALTER FUNCTION partner_connector_release_submission_credit(uuid,uuid,uuid,text) SET search_path = public, pg_temp"
    );
    await expect(partnerCreditDefinerModelViolations(query)).resolves.toContain(
      "partner_connector_release_submission_credit must pin search_path to pg_catalog, public, pg_temp"
    );
    await admin.query(
      "ALTER FUNCTION partner_connector_release_submission_credit(uuid,uuid,uuid,text) SET search_path = pg_catalog, public, pg_temp"
    );
  });

  it("refuses rollback while a later migration is journalled", async () => {
    await admin.query(
      "CREATE TABLE schema_migrations (filename text primary key, status text not null, checksum text, completed_at timestamptz)"
    );
    await admin.query("INSERT INTO schema_migrations (filename,status) VALUES ('0042_later.sql','applied')");
    const rollback = readFileSync("migrations/rollback-partner-submission-credit-lifecycle.sql", "utf8");
    await expect(admin.query(rollback)).rejects.toThrow("later numbered migration");
    await admin.query("ROLLBACK");
    await admin.query("DROP TABLE schema_migrations");
  });
});
