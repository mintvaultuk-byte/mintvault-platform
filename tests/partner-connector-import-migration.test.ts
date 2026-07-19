/**
 * Trusted Intake Connector — Phase G3: import-provenance migration/rollback/preflight proof
 * (disposable Postgres, realistic non-superuser role model — mirrors
 * tests/partner-connector-validation-migration.test.ts's G2 pattern).
 *
 * Runs ONLY when PARTNER_CONNECTOR_IMPORT_MIGRATION_ADMIN is set (superuser URL to a DISPOSABLE
 * local Postgres that is the ONLY partner database in its cluster):
 *   PARTNER_CONNECTOR_IMPORT_MIGRATION_ADMIN=postgresql://postgres@127.0.0.1:5592/dispo \
 *   npx vitest run tests/partner-connector-import-migration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { runPreflight } from "../scripts/db/preflight-schema";

const ADMIN = process.env.PARTNER_CONNECTOR_IMPORT_MIGRATION_ADMIN;
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

/** Minimal, real-shaped MintVault tables (users/submissions/submission_items) — these are
 * pre-existing production tables managed by db:push, not by any migrations/ file, so the
 * migration/rollback proof must create representative versions itself, exactly as the G2 migration
 * test already does for `certificates`. */
async function seedMintVaultTables(): Promise<void> {
  await admin.query(`CREATE TABLE IF NOT EXISTS users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar UNIQUE,
    first_name varchar,
    last_name varchar,
    role varchar(20) NOT NULL DEFAULT 'customer',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS submissions (
    id serial PRIMARY KEY,
    user_id varchar NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'draft',
    tracking_number text NOT NULL UNIQUE,
    card_count integer NOT NULL DEFAULT 0,
    total_price decimal(10,2) NOT NULL DEFAULT 0,
    total_declared_value integer NOT NULL DEFAULT 0,
    payment_status varchar(20) NOT NULL DEFAULT 'unpaid',
    service_type text,
    service_tier text,
    grading_cost integer DEFAULT 0,
    customer_email text,
    customer_first_name text,
    customer_last_name text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS submission_items (
    id serial PRIMARY KEY,
    submission_id integer NOT NULL,
    card_index integer NOT NULL DEFAULT 0,
    game text, card_set text, card_name text, card_number text, year text,
    declared_value integer DEFAULT 0, declared_new boolean DEFAULT false, notes text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // pn_migrator (non-superuser) must OWN these to GRANT on them during migration 0010 — same
  // ownership-transfer step the G2 migration test performs for its own `certificates` fixture.
  await admin.query("ALTER TABLE users OWNER TO pn_migrator").catch(() => {});
  await admin.query("ALTER TABLE submissions OWNER TO pn_migrator").catch(() => {});
  await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator").catch(() => {});
}

async function applyAllRealistic(): Promise<void> {
  await provisionRealisticRoles(admin);
  await seedMintVaultTables();
  const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await migrator.connect();
  try {
    await applyMigrations(migrator, listMigrationFiles());
  } finally {
    await migrator.end();
  }
}

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector G3 — import migration, preflight, rollback (disposable DB)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await applyAllRealistic();
    }, 60_000);

    afterAll(async () => {
      await admin?.end().catch(() => {});
    });

    it("applies migration 0010 and journals it", async () => {
      const { rows } = await admin.query(
        "SELECT status FROM schema_migrations WHERE filename = '0010_partner_connector_import.sql'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
    });

    it("all 10 partner migration journal rows are present and applied", async () => {
      const { rows } = await admin.query(
        "SELECT filename, status FROM schema_migrations WHERE filename LIKE '000%_partner%' OR filename LIKE '0010_partner%' ORDER BY filename"
      );
      expect(rows).toHaveLength(10);
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

    it("partner_connector_records.state now permits 'importing'", async () => {
      const { rows } = await admin.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_partner_connector_records_state'"
      );
      expect(rows[0].def).toContain("importing");
    });

    it("PUBLIC has no privilege on either new connector table", async () => {
      const priv = async (table: string) =>
        admin.query<{ has: boolean }>("SELECT has_table_privilege('public', $1, 'SELECT') AS has", [table]);
      expect((await priv("partner_connector_imports")).rows[0].has).toBe(false);
      expect((await priv("partner_connector_customer_links")).rows[0].has).toBe(false);
    });

    it("partner_connector_runtime has narrow column-level UPDATE on partner_connector_imports (not full-row)", async () => {
      // has_table_privilege('UPDATE') checks only whole-table grants, not column-level ones — this
      // deliberately returns false here (the grant is column-scoped by design); has_column_privilege
      // below is the correct, meaningful check for this narrow-mutation model.
      const full = await admin.query<{ has: boolean }>(
        "SELECT has_table_privilege('partner_connector_runtime', 'partner_connector_imports', 'UPDATE') AS has"
      );
      expect(full.rows[0].has).toBe(false);
      const mutable = await admin.query<{ has: boolean }>(
        "SELECT has_column_privilege('partner_connector_runtime', 'partner_connector_imports', 'state', 'UPDATE') AS has"
      );
      expect(mutable.rows[0].has).toBe(true);
      const immutable = await admin.query<{ has: boolean }>(
        "SELECT has_column_privilege('partner_connector_runtime', 'partner_connector_imports', 'source_fingerprint', 'UPDATE') AS has"
      );
      expect(immutable.rows[0].has).toBe(false);
    });

    it("partner_connector_runtime has SELECT+INSERT (not UPDATE/DELETE) on users/submissions/submission_items", async () => {
      const { rows } = await admin.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'partner_connector_runtime' AND table_name IN ('users','submissions','submission_items')`
      );
      const byTable = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
        byTable.get(r.table_name)!.add(r.privilege_type);
      }
      for (const table of ["users", "submissions", "submission_items"]) {
        expect(byTable.get(table), table).toEqual(new Set(["SELECT", "INSERT"]));
      }
    });

    it("partner_runtime (the Partner-facing role) has ZERO access to the new import tables", async () => {
      const { rows } = await admin.query<{ grantee: string }>(
        `SELECT DISTINCT grantee FROM information_schema.role_table_grants
          WHERE table_name IN ('partner_connector_imports','partner_connector_customer_links')`
      );
      expect(rows.map((r) => r.grantee)).not.toContain("partner_runtime");
    });

    it("a submission created before rollback survives a G3-only rollback untouched", async () => {
      await admin.query(
        "INSERT INTO users (id, first_name) VALUES ('rollback-proof-user', 'Proof') ON CONFLICT DO NOTHING"
      );
      await admin.query(
        "INSERT INTO submissions (user_id, tracking_number, status) VALUES ('rollback-proof-user', 'MV-SUB-ROLLBACK-1', 'draft')"
      );

      const rollbackSql = require("node:fs").readFileSync(
        require("node:path").join(process.cwd(), "migrations", "rollback-partner-connector-g3.sql"),
        "utf8"
      );
      await admin.query(rollbackSql);

      const { rows } = await admin.query("SELECT status FROM submissions WHERE tracking_number = 'MV-SUB-ROLLBACK-1'");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("draft");

      const tables = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_name IN ('partner_connector_imports','partner_connector_customer_links')`
      );
      expect(tables.rows[0].n).toBe(0);

      const journal = await admin.query(
        "SELECT 1 FROM schema_migrations WHERE filename = '0010_partner_connector_import.sql'"
      );
      expect(journal.rows).toHaveLength(0);

      // G1/G2 objects survive.
      const g2 = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'partner_connector_validation_runs'`
      );
      expect(g2.rows[0].n).toBe(1);

      // Re-apply cleanly, so the disposable DB is left consistent for anything running after this suite.
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const { applied } = await applyMigrations(migrator, listMigrationFiles());
        expect(applied).toContain("0010_partner_connector_import.sql");
      } finally {
        await migrator.end();
      }
    });
  }
);
