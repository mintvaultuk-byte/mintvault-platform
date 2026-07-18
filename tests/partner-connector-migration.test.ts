/**
 * Trusted Intake Connector — Phase G1: migration/rollback/preflight proof (disposable Postgres,
 * realistic non-superuser role model — mirrors tests/partner-rollback.test.ts's pattern).
 *
 * Proves:
 *   - migration 0008 applies on a fresh database and is journaled;
 *   - reapplying the FULL migration set is a clean no-op (0 newly applied);
 *   - preflight reports zero unknown objects after 0008;
 *   - partner_connector_runtime is NOSUPERUSER/NOBYPASSRLS, and PUBLIC has no privilege on either
 *     new table;
 *   - the G1-only rollback removes exactly the two new tables + the new role and nothing else —
 *     partner_submission_handoffs, partner_submissions, and synthetic pre-existing MintVault data
 *     all survive;
 *   - migrations reapply cleanly after rollback.
 *
 * Runs ONLY when PARTNER_CONNECTOR_MIGRATION_ADMIN is set (superuser URL to a DISPOSABLE local
 * Postgres that is the ONLY partner database in its cluster):
 *   PARTNER_CONNECTOR_MIGRATION_ADMIN=postgresql://postgres@127.0.0.1:5550/dispo \
 *   npx vitest run tests/partner-connector-migration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { runPreflight } from "../scripts/db/preflight-schema";

const ADMIN = process.env.PARTNER_CONNECTOR_MIGRATION_ADMIN;
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
  "Trusted Intake Connector G1 — migration, preflight, rollback (disposable DB)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      // synthetic PRE-EXISTING MintVault data that must survive the G1 rollback
      await admin.query("CREATE TABLE IF NOT EXISTS certificates (id serial primary key, cert_id text, secret text)");
      await admin.query("INSERT INTO certificates (cert_id, secret) VALUES ('MV1','KEEP-A')");
      await applyAllRealistic();
      await admin.query("ALTER TABLE certificates OWNER TO pn_migrator").catch(() => {});
    }, 60_000);

    afterAll(async () => {
      await admin?.end().catch(() => {});
    });

    it("applies migration 0008 and journals it", async () => {
      const { rows } = await admin.query(
        "SELECT status FROM schema_migrations WHERE filename = '0008_partner_connector_foundation.sql'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
    });

    it("all 8 partner migration journal rows are present and applied", async () => {
      const { rows } = await admin.query(
        "SELECT filename, status FROM schema_migrations WHERE filename LIKE '000%_partner%' ORDER BY filename"
      );
      expect(rows).toHaveLength(8);
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
        expect.arrayContaining(["partner_connector_records", "partner_connector_events"])
      );
    });

    it("partner_connector_runtime is NOLOGIN, NOSUPERUSER, NOBYPASSRLS", async () => {
      const { rows } = await admin.query(
        "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'partner_connector_runtime'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolcanlogin).toBe(false);
      expect(rows[0].rolsuper).toBe(false);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("PUBLIC has no privilege on either new connector table", async () => {
      const priv = async (table: string) =>
        admin.query<{ has: boolean }>("SELECT has_table_privilege('public', $1, 'SELECT') AS has", [table]);
      const records = await priv("partner_connector_records");
      const events = await priv("partner_connector_events");
      expect(records.rows[0].has).toBe(false);
      expect(events.rows[0].has).toBe(false);
    });

    it("only partner_connector_runtime holds DML on the two new tables (partner_runtime holds none)", async () => {
      const { rows } = await admin.query<{ grantee: string; table_name: string; privilege_type: string }>(
        `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_name IN ('partner_connector_records','partner_connector_events')
          AND table_schema = 'public'`
      );
      const grantees = new Set(rows.map((r) => r.grantee));
      expect(grantees.has("partner_runtime")).toBe(false);
      expect(grantees.has("partner_connector_runtime")).toBe(true);
    });

    it("G1 rollback removes exactly the two new tables and the new role, nothing else", async () => {
      await admin.query(rb("rollback-partner-connector-g1.sql"));

      const records = await admin.query("SELECT to_regclass('public.partner_connector_records') r");
      const events = await admin.query("SELECT to_regclass('public.partner_connector_events') r");
      expect(records.rows[0].r).toBeNull();
      expect(events.rows[0].r).toBeNull();

      const role = await admin.query(
        "SELECT count(*)::int n FROM pg_roles WHERE rolname = 'partner_connector_runtime'"
      );
      expect(role.rows[0].n).toBe(0);

      // Phase 1/2 objects survive untouched.
      const handoffs = await admin.query("SELECT to_regclass('public.partner_submission_handoffs') r");
      expect(handoffs.rows[0].r).toBe("partner_submission_handoffs");
      const submissions = await admin.query("SELECT to_regclass('public.partner_submissions') r");
      expect(submissions.rows[0].r).toBe("partner_submissions");
      const runtimeRole = await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname = 'partner_runtime'");
      expect(runtimeRole.rows[0].n).toBe(1);

      // Synthetic pre-existing MintVault data survives.
      const certs = await admin.query("SELECT secret FROM certificates ORDER BY id");
      expect(certs.rows.map((r) => r.secret)).toEqual(["KEEP-A"]);

      const journal = await admin.query(
        "SELECT count(*)::int n FROM schema_migrations WHERE filename = '0008_partner_connector_foundation.sql'"
      );
      expect(journal.rows[0].n).toBe(0);
    });

    it("migration 0008 reapplies cleanly after rollback", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const { applied } = await applyMigrations(migrator, listMigrationFiles());
        expect(applied).toContain("0008_partner_connector_foundation.sql");
      } finally {
        await migrator.end();
      }
      const result = await runPreflight(ADMIN!);
      expect(result.ok).toBe(true);
    });
  }
);
