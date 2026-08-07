/**
 * Privilege-model regression proof for the Partner platform kill switches.
 *
 * WHAT THIS PINS. `partner_feature_flags` and `partner_emergency_controls` are super-admin
 * write-only: every write in the repository goes through the PRIVILEGED admin pool
 * (server/partner/admin-routes.ts:257,261,271 and server/partner/flag-admin-routes.ts:185,189),
 * and every `partner_runtime` reference is a SELECT (flags.ts:40,59; emergency.ts:32;
 * dashboard-service.ts:944; connector-runtime.ts:297).
 *
 * 0001_partner_foundation.sql nevertheless granted the runtime role SELECT, INSERT, UPDATE, DELETE
 * on both, via the blanket ELSE branch of its grant loop. That was not contained by the row-level
 * policy: 0001 deliberately widens the feature-flag USING clause to `tenant_id IS NULL OR ...` so
 * a GLOBAL row is readable by every tenant, and PostgreSQL governs DELETE by USING ALONE — the
 * WITH CHECK clause that confines INSERT and UPDATE to one's own tenant is never consulted when a
 * row is removed. So any tenant-scoped session could DELETE the platform-wide kill-switch rows.
 *
 * WHY A TEST RATHER THAN JUST THE MIGRATION. No test anywhere asserted the shape of these grants,
 * so the defect was reintroducible by a single line in a future grant loop — which is exactly how
 * it arrived. These assertions are behavioural (they attempt the writes as the real role under
 * real RLS), not a snapshot of catalogue rows, so they fail on the CONSEQUENCE rather than on a
 * cosmetic change to how the privilege is spelled.
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

const TENANT = "11111111-1111-1111-1111-111111111111";

/**
 * Run `fn` with the session acting as the restricted runtime role inside a legitimate,
 * authenticated tenant context — i.e. the most privileged position a real Partner session can ever
 * occupy. RESET ROLE always runs, so one failing expectation cannot leak elevated state into the
 * next test.
 */
async function asPartnerRuntime<T>(fn: () => Promise<T>): Promise<T> {
  await admin.query("SET ROLE partner_runtime");
  await admin.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
  try {
    return await fn();
  } finally {
    await admin.query("RESET ROLE");
  }
}

/** Attempt a statement as partner_runtime; return the rows affected, or the SQLSTATE if refused. */
async function attempt(sql: string, params: unknown[] = []): Promise<number | string> {
  return await asPartnerRuntime(async () => {
    try {
      const r = await admin.query(sql, params as never[]);
      return r.rowCount ?? 0;
    } catch (e) {
      // The connection stays usable: none of these statements open an explicit transaction.
      return (e as { code?: string }).code ?? "error";
    }
  });
}

describe("Partner runtime role — platform kill switches are read-only (disposable cluster)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-runtime-flag-privilege");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();

    // Roles FIRST: the MintVault base tables must be owned by pn_migrator before migrations grant
    // on them, or 0010 fails with "permission denied for table users".
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
      // ORDER IS LOAD-BEARING: 0041 revokes its own INHERIT membership as its final act, so the
      // repair grant 0042 needs must land BETWEEN the two applies. See tests/partner-rollback.test.ts.
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

    // One tenant, one PLATFORM-GLOBAL kill-switch row, one HQ-imposed freeze on that tenant.
    await admin.query(
      "INSERT INTO partner_organisations (id, legal_name, status) VALUES ($1,'Test Partner Ltd','ACTIVE') ON CONFLICT DO NOTHING",
      [TENANT]
    );
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL, NULL, 'partner_emergency_stop', true)"
    );
    await admin.query(
      "INSERT INTO partner_emergency_controls (tenant_id, scope, frozen, set_by, reason) VALUES ($1,'partner',true,'hq-admin','fraud hold')",
      [TENANT]
    );
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("the runtime role holds no write privilege on either kill-switch table", async () => {
    const { rows } = await admin.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='public' AND grantee='partner_runtime'
          AND table_name IN ('partner_feature_flags','partner_emergency_controls')
          AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES')`
    );
    expect(rows).toEqual([]);
  });

  it("keeps SELECT on both — every portal gate reads them on the runtime pool", async () => {
    for (const t of ["partner_feature_flags", "partner_emergency_controls"]) {
      const { rows } = await admin.query<{ ok: boolean }>(
        "SELECT has_table_privilege('partner_runtime', $1, 'SELECT') AS ok",
        [`public.${t}`]
      );
      expect(rows[0].ok, `${t} must stay readable`).toBe(true);
    }
  });

  it("cannot DELETE the platform-global kill switch (the original defect)", async () => {
    const result = await attempt(
      "DELETE FROM partner_feature_flags WHERE flag='partner_emergency_stop' AND tenant_id IS NULL"
    );
    expect(result, "expected refusal, not a row count").toBe("42501"); // insufficient_privilege
    const { rows } = await admin.query("SELECT 1 FROM partner_feature_flags WHERE tenant_id IS NULL");
    expect(rows).toHaveLength(1);
  });

  it("cannot UPDATE or forge a platform-global flag row", async () => {
    expect(
      await attempt("UPDATE partner_feature_flags SET enabled=false WHERE flag='partner_emergency_stop' AND tenant_id IS NULL")
    ).toBe("42501");
    expect(
      await attempt(
        "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL,NULL,'partner_portal_enabled',false)"
      )
    ).toBe("42501");
    const { rows } = await admin.query<{ flag: string; enabled: boolean }>(
      "SELECT flag, enabled FROM partner_feature_flags WHERE tenant_id IS NULL"
    );
    expect(rows).toEqual([{ flag: "partner_emergency_stop", enabled: true }]);
  });

  it("cannot self-lift an HQ-imposed emergency freeze", async () => {
    expect(await attempt("DELETE FROM partner_emergency_controls WHERE tenant_id=$1", [TENANT])).toBe("42501");
    expect(await attempt("UPDATE partner_emergency_controls SET frozen=false WHERE tenant_id=$1", [TENANT])).toBe(
      "42501"
    );
    const { rows } = await admin.query("SELECT 1 FROM partner_emergency_controls WHERE frozen=true");
    expect(rows).toHaveLength(1);
  });

  it("still reads what the portal gates depend on: the global flag with no tenant context", async () => {
    // resolveGlobalFlag() (server/partner/flags.ts:53) queries on the runtime pool with NO tenant
    // context at all. It only works because the read policy admits tenant_id IS NULL rows.
    await admin.query("SET ROLE partner_runtime");
    try {
      const { rows } = await admin.query<{ enabled: boolean }>(
        "SELECT enabled FROM partner_feature_flags WHERE flag='partner_emergency_stop' AND tenant_id IS NULL AND location_id IS NULL"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].enabled).toBe(true);
    } finally {
      await admin.query("RESET ROLE");
    }
    // readEmergencyState() reads frozen rows inside a tenant transaction.
    const frozen = await asPartnerRuntime(async () =>
      (await admin.query("SELECT scope FROM partner_emergency_controls WHERE frozen = true")).rows
    );
    expect(frozen).toHaveLength(1);
  });

  /**
   * DEFENCE IN DEPTH. The revoke is layer one; the policy split is layer two. This test deliberately
   * hands the DELETE privilege back — simulating a future blanket grant loop reintroducing it — and
   * proves the global row is STILL unreachable, while ordinary tenant-owned flag management keeps
   * working. Without the policy split this test fails with rowCount 1.
   */
  it("global rows stay protected even if the write grant is restored", async () => {
    await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON partner_feature_flags TO partner_runtime");
    try {
      expect(
        await attempt("DELETE FROM partner_feature_flags WHERE flag='partner_emergency_stop' AND tenant_id IS NULL"),
        "policy must yield zero affected rows, not a deletion"
      ).toBe(0);
      expect(await admin.query("SELECT 1 FROM partner_feature_flags WHERE tenant_id IS NULL")).toHaveProperty(
        "rowCount",
        1
      );
      // A tenant's own flags must remain fully manageable — the policy split must not over-tighten.
      expect(
        await attempt(
          "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES ($1,NULL,'partner_connector_enabled',true)",
          [TENANT]
        )
      ).toBe(1);
      expect(await attempt("DELETE FROM partner_feature_flags WHERE tenant_id=$1", [TENANT])).toBe(1);
    } finally {
      await admin.query("REVOKE INSERT, UPDATE, DELETE ON partner_feature_flags FROM partner_runtime");
    }
  });
});
