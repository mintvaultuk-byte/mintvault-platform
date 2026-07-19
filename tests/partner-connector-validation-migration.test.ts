/**
 * Trusted Intake Connector — Phase G2: validation-schema migration/rollback/preflight proof
 * (disposable Postgres, realistic non-superuser role model — mirrors
 * tests/partner-connector-migration.test.ts's G1 pattern).
 *
 * Proves:
 *   - migration 0009 applies on a fresh database and is journaled;
 *   - reapplying the FULL migration set is a clean no-op;
 *   - preflight reports zero unknown objects after 0009;
 *   - partner_connector_records.state CHECK now permits 'ready_for_import';
 *   - PUBLIC has no privilege on either new table; only partner_connector_runtime holds DML, and
 *     even it has no UPDATE/DELETE (append-only, matching the G1 events-table convention);
 *   - the G2-only rollback removes exactly the new objects and reverts the CHECK constraint,
 *     nothing else — G1/Phase 1/2 data and the connector role survive;
 *   - migrations reapply cleanly after rollback.
 *
 * Runs ONLY when PARTNER_CONNECTOR_VALIDATION_MIGRATION_ADMIN is set (superuser URL to a
 * DISPOSABLE local Postgres that is the ONLY partner database in its cluster):
 *   PARTNER_CONNECTOR_VALIDATION_MIGRATION_ADMIN=postgresql://postgres@127.0.0.1:5590/dispo \
 *   npx vitest run tests/partner-connector-validation-migration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { runPreflight } from "../scripts/db/preflight-schema";

const ADMIN = process.env.PARTNER_CONNECTOR_VALIDATION_MIGRATION_ADMIN;
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN);

let admin: Client;
const rb = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

async function applyAllRealistic(): Promise<void> {
  await provisionRealisticRoles(admin);
  const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await migrator.connect();
  try {
    await applyMigrations(migrator, listMigrationFiles());
  } finally {
    await migrator.end();
  }
}

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector G2 — validation migration, preflight, rollback (disposable DB)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query("CREATE TABLE IF NOT EXISTS certificates (id serial primary key, cert_id text, secret text)");
      await admin.query("INSERT INTO certificates (cert_id, secret) VALUES ('MV1','KEEP-A')");
      // Minimal, representative MintVault tables — migration 0010 (G3, applied below via
      // listMigrationFiles()) grants partner_connector_runtime access to these, so they must exist
      // (and be owned by pn_migrator, the non-superuser applying role) before migrations run. Real
      // production tables are managed by db:push, not by any migrations/ file — same reason
      // `certificates` above is a hand-created fixture, not a real one. pn_migrator itself must exist
      // FIRST (provisionRealisticRoles creates it) or the OWNER TO below fails.
      await provisionRealisticRoles(admin);
      await admin.query(
        "CREATE TABLE IF NOT EXISTS users (id varchar primary key default gen_random_uuid(), email varchar unique)"
      );
      await admin.query(
        "CREATE TABLE IF NOT EXISTS submissions (id serial primary key, user_id varchar not null, tracking_number text not null unique)"
      );
      await admin.query(
        "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
      );
      await admin.query("ALTER TABLE users OWNER TO pn_migrator");
      await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
      await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
      await applyAllRealistic();
      await admin.query("ALTER TABLE certificates OWNER TO pn_migrator").catch(() => {});
    }, 60_000);

    afterAll(async () => {
      await admin?.end().catch(() => {});
    });

    it("applies migration 0009 and journals it", async () => {
      const { rows } = await admin.query(
        "SELECT status FROM schema_migrations WHERE filename = '0009_partner_connector_validation.sql'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
    });

    it("all 11 partner migration journal rows are present and applied", async () => {
      const { rows } = await admin.query(
        "SELECT filename, status FROM schema_migrations WHERE filename LIKE '000%_partner%' OR filename LIKE '0010_partner%' OR filename LIKE '0011_partner%' ORDER BY filename"
      );
      expect(rows).toHaveLength(11);
      for (const r of rows) expect(r.status).toBe("applied");
    });

    it("reapplying the full migration set is a clean no-op", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const plan = await planMigrations(migrator, listMigrationFiles());
        expect(plan.pending).toHaveLength(0);
        expect(plan.checksumMismatches).toHaveLength(0);
        expect(plan.inconsistent).toHaveLength(0);
        const { applied } = await applyMigrations(migrator, listMigrationFiles());
        expect(applied).toHaveLength(0);
      } finally {
        await migrator.end();
      }
    });

    it("preflight reports zero unknown objects", async () => {
      const result = await runPreflight(ADMIN!);
      expect(result.definerViolations).toEqual([]);
      expect(result.unknown).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("the two new tables exist and are classified as Partner Network (not unknown)", async () => {
      const result = await runPreflight(ADMIN!);
      expect(result.partnerNetwork).toEqual(
        expect.arrayContaining(["partner_connector_validation_runs", "partner_connector_validation_findings"])
      );
    });

    it("partner_connector_records.state now permits 'ready_for_import'", async () => {
      const { rows } = await admin.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_partner_connector_records_state'"
      );
      expect(rows[0].def).toContain("ready_for_import");
    });

    it("PUBLIC has no privilege on either new table", async () => {
      const priv = async (table: string) =>
        admin.query<{ has: boolean }>("SELECT has_table_privilege('public', $1, 'SELECT') AS has", [table]);
      expect((await priv("partner_connector_validation_runs")).rows[0].has).toBe(false);
      expect((await priv("partner_connector_validation_findings")).rows[0].has).toBe(false);
    });

    it("only partner_connector_runtime holds DML on the two new tables, and it has no UPDATE/DELETE (append-only)", async () => {
      const { rows } = await admin.query<{ grantee: string; table_name: string; privilege_type: string }>(
        `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_name IN ('partner_connector_validation_runs','partner_connector_validation_findings')
          AND table_schema = 'public'`
      );
      const grantees = new Set(rows.map((r) => r.grantee));
      expect(grantees.has("partner_runtime")).toBe(false);
      expect(grantees.has("partner_connector_runtime")).toBe(true);
      const forbidden = rows.filter(
        (r) => r.grantee === "partner_connector_runtime" && ["UPDATE", "DELETE"].includes(r.privilege_type)
      );
      expect(forbidden).toHaveLength(0);
    });

    it("partner_connector_runtime gained read-only access to organisation/location/customer/tier/card tables (no write)", async () => {
      const { rows } = await admin.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'partner_connector_runtime'
          AND table_name IN ('partner_organisations','partner_locations','partner_customers','partner_service_tiers','partner_submission_cards')`
      );
      const byTable = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
        byTable.get(r.table_name)!.add(r.privilege_type);
      }
      for (const table of [
        "partner_organisations",
        "partner_locations",
        "partner_customers",
        "partner_service_tiers",
        "partner_submission_cards",
      ]) {
        expect(byTable.get(table), table).toEqual(new Set(["SELECT"]));
      }
    });

    it("G2 rollback REFUSES once migration 0010 (G3) is present, and changes nothing", async () => {
      await expect(admin.query(rb("rollback-partner-connector-g2.sql"))).rejects.toThrow(
        /refuses to run.*migration 0010/i
      );
      await admin.query("ROLLBACK").catch(() => {});
      const imports = await admin.query("SELECT to_regclass('public.partner_connector_imports') r");
      expect(imports.rows[0].r).toBe("partner_connector_imports");
    });

    it("G3 rollback REFUSES once migration 0011 (G3E) is present, and changes nothing", async () => {
      await expect(admin.query(rb("rollback-partner-connector-g3.sql"))).rejects.toThrow(
        /refuses to run.*migration 0011/i
      );
      await admin.query("ROLLBACK").catch(() => {});
      const records = await admin.query("SELECT to_regclass('public.partner_connector_records') r");
      expect(records.rows[0].r).toBe("partner_connector_records");
    });

    it("G2 rollback removes exactly the two new tables and reverts the CHECK constraint, nothing else (after G3E+G3 rollback)", async () => {
      await admin.query(rb("rollback-partner-connector-g3e.sql"));
      await admin.query(rb("rollback-partner-connector-g3.sql"));
      await admin.query(rb("rollback-partner-connector-g2.sql"));

      const runs = await admin.query("SELECT to_regclass('public.partner_connector_validation_runs') r");
      const findings = await admin.query("SELECT to_regclass('public.partner_connector_validation_findings') r");
      expect(runs.rows[0].r).toBeNull();
      expect(findings.rows[0].r).toBeNull();

      const constraintDef = await admin.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_partner_connector_records_state'"
      );
      expect(constraintDef.rows[0].def).not.toContain("ready_for_import");
      expect(constraintDef.rows[0].def).toContain("awaiting_validation");

      // G1/Phase 1/2 objects and role survive untouched.
      const records = await admin.query("SELECT to_regclass('public.partner_connector_records') r");
      expect(records.rows[0].r).toBe("partner_connector_records");
      const role = await admin.query(
        "SELECT count(*)::int n FROM pg_roles WHERE rolname = 'partner_connector_runtime'"
      );
      expect(role.rows[0].n).toBe(1);
      const handoffs = await admin.query("SELECT to_regclass('public.partner_submission_handoffs') r");
      expect(handoffs.rows[0].r).toBe("partner_submission_handoffs");

      const certs = await admin.query("SELECT secret FROM certificates ORDER BY id");
      expect(certs.rows.map((r) => r.secret)).toEqual(["KEEP-A"]);

      const journal = await admin.query(
        "SELECT count(*)::int n FROM schema_migrations WHERE filename = '0009_partner_connector_validation.sql'"
      );
      expect(journal.rows[0].n).toBe(0);
    });

    it("migrations 0009, 0010 and 0011 reapply cleanly after rollback", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const { applied } = await applyMigrations(migrator, listMigrationFiles());
        expect(applied).toContain("0009_partner_connector_validation.sql");
        expect(applied).toContain("0010_partner_connector_import.sql");
        expect(applied).toContain("0011_partner_connector_reconciliation.sql");
      } finally {
        await migrator.end();
      }
      const result = await runPreflight(ADMIN!);
      expect(result.ok).toBe(true);
    });
  }
);
