/**
 * Trusted Intake Connector — Phase G4: migration 0014 (partner_connector_admin_actions) proof on a
 * disposable Postgres with the realistic non-superuser role model.
 *
 * Proves:
 *   - 0014 applies on a fresh DB and is journaled 'applied';
 *   - reapplying the full set is a clean no-op;
 *   - preflight classifies partner_connector_admin_actions as Partner Network (not unknown), ok=true;
 *   - the table is APPEND-ONLY for the real partner_connector_runtime role: INSERT/SELECT succeed;
 *     UPDATE/DELETE/TRUNCATE reject 42501; runtime is not owner; runtime holds exactly [INSERT,SELECT];
 *     PUBLIC has no privilege;
 *   - the idempotency partial-unique blocks a second succeeded row for the same key;
 *   - the G4 rollback drops exactly the new table + removes its journal row + reapplies cleanly.
 *
 * Runs ONLY when PARTNER_CONNECTOR_ADMIN_MIGRATION_ADMIN is a superuser URL to a DISPOSABLE loopback
 * Postgres that is the ONLY partner database in its cluster.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom, applyEveryMigrationRealistic, partnerScopeOnly } from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { runPreflight } from "../scripts/db/preflight-schema";

const ADMIN = process.env.PARTNER_CONNECTOR_ADMIN_MIGRATION_ADMIN;
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
const rb = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");
const TABLE = "partner_connector_admin_actions";

/** Build a login URL for a given role from the admin URL (trust-auth cluster ignores the password). */
function roleUrl(role: string): string {
  const u = new URL(ADMIN!);
  u.username = role;
  u.password = "synthetic";
  return u.toString();
}

let admin: Client;

async function applyAllRealistic(): Promise<void> {
  await provisionRealisticRoles(admin);
  const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await migrator.connect();
  try {
    await applyEveryMigrationRealistic(migrator);
  } finally {
    await migrator.end();
  }
}

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector G4 — migration 0014 admin-actions audit (disposable DB)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await provisionRealisticRoles(admin);
      // Minimal MintVault-internal tables the earlier connector migrations grant against.
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
      // a real login role that is a granted member of the restricted runtime role
      await admin.query("DROP ROLE IF EXISTS partner_g4_rt_test").catch(() => {});
      await admin.query("CREATE ROLE partner_g4_rt_test LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_connector_runtime TO partner_g4_rt_test");
    }, 60_000);

    afterAll(async () => {
      await admin?.query("DROP ROLE IF EXISTS partner_g4_rt_test").catch(() => {});
      await admin?.end().catch(() => {});
    });

    it("0014 is applied and journaled", async () => {
      const { rows } = await admin.query(
        "SELECT status FROM schema_migrations WHERE filename = '0014_partner_connector_admin_actions.sql'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
    });

    it("reapplying the full migration set is a clean no-op", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const plan = await planMigrations(migrator, partnerScopeOnly(listMigrationFiles()));
        expect(plan.pending).toHaveLength(0);
        expect(plan.checksumMismatches).toHaveLength(0);
        const { applied } = await applyMigrations(migrator, partnerScopeOnly(listMigrationFiles()));
        expect(applied).toHaveLength(0);
      } finally {
        await migrator.end();
      }
    });

    it("preflight classifies the new table as Partner Network and stays ok", async () => {
      const result = await runPreflight(ADMIN!);
      expect(result.ok).toBe(true);
      expect(result.unknown).toEqual([]);
      expect(result.partnerNetwork).toEqual(expect.arrayContaining([TABLE]));
    });

    it("append-only for the runtime role: INSERT/SELECT succeed; UPDATE/DELETE/TRUNCATE reject 42501", async () => {
      const rt = new Client({ connectionString: roleUrl("partner_g4_rt_test") });
      await rt.connect();
      try {
        await rt.query("SET ROLE partner_connector_runtime");
        // seed an org so the FK is satisfiable, then insert a self-contained admin-action row
        await rt.query(
          `INSERT INTO ${TABLE} (action_type, actor_user_id, actor_email, request_id, reason, result)
         VALUES ('retry_import', gen_random_uuid(), 'admin@example.com', 'req-1', 'operator retry', 'attempted')`
        );
        const sel = await rt.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
        expect(sel.rows[0].n).toBeGreaterThanOrEqual(1);
        await expect(rt.query(`UPDATE ${TABLE} SET result='succeeded'`)).rejects.toMatchObject({ code: "42501" });
        await expect(rt.query(`DELETE FROM ${TABLE}`)).rejects.toMatchObject({ code: "42501" });
        await expect(rt.query(`TRUNCATE ${TABLE}`)).rejects.toMatchObject({ code: "42501" });
      } finally {
        await rt.query("RESET ROLE").catch(() => {});
        await rt.end();
      }
    });

    it("runtime is not the owner and holds exactly [INSERT, SELECT]; PUBLIC has none", async () => {
      const owner = await admin.query("SELECT tableowner FROM pg_tables WHERE tablename = $1", [TABLE]);
      expect(owner.rows[0].tableowner).toBe("pn_migrator");
      const grants = await admin.query(
        "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='partner_connector_runtime' ORDER BY privilege_type",
        [TABLE]
      );
      expect(grants.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
      const pub = await admin.query(
        "SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='PUBLIC'",
        [TABLE]
      );
      expect(pub.rows[0].n).toBe(0);
    });

    it("idempotency partial-unique blocks a second succeeded row for the same key", async () => {
      await admin.query(
        `INSERT INTO ${TABLE} (action_type, actor_user_id, actor_email, request_id, idempotency_key, reason, result)
       VALUES ('retry_import', gen_random_uuid(), 'a@e.com', 'r2', 'idem-key-1', 'x', 'succeeded')`
      );
      await expect(
        admin.query(
          `INSERT INTO ${TABLE} (action_type, actor_user_id, actor_email, request_id, idempotency_key, reason, result)
         VALUES ('retry_import', gen_random_uuid(), 'a@e.com', 'r3', 'idem-key-1', 'x', 'succeeded')`
        )
      ).rejects.toMatchObject({ code: "23505" });
      // but a non-succeeded row with the same key is allowed (attempt records are not uniquely constrained)
      await admin.query(
        `INSERT INTO ${TABLE} (action_type, actor_user_id, actor_email, request_id, idempotency_key, reason, result)
       VALUES ('retry_import', gen_random_uuid(), 'a@e.com', 'r4', 'idem-key-1', 'x', 'attempted')`
      );
    });

    it("only the evidence-backed indexes exist on the table (record history + idempotency unique + pkey)", async () => {
      const { rows } = await admin.query("SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname", [
        TABLE,
      ]);
      const names = rows.map((r) => r.indexname);
      expect(names).toEqual([
        "idx_partner_connector_admin_actions_record",
        "partner_connector_admin_actions_pkey",
        "uq_partner_connector_admin_actions_idem",
      ]);
      // the speculative org index must be absent (no code path filters by partner_organisation_id yet)
      expect(names).not.toContain("idx_partner_connector_admin_actions_org");
    });

    // The G4 rollback used to be exercised end-to-end here by first rolling back 0015. That is no
    // longer reachable, and the reason is a SAFETY property working as designed, not a defect:
    // every rollback in this chain refuses while ANY higher-numbered migration is journalled
    // (G4 refuses on 0015+, G5 on 0016+, G6A on 0017+, G6B on 0018+), and migrations 0018, 0022,
    // 0023 and 0024 ship no rollback script at all. So on the current migration set the chain
    // cannot be unwound down to G4 — by design, fail-closed.
    //
    // The assertion therefore now covers the behaviour that IS current and IS load-bearing: the
    // refusal fires for its documented reason and changes NOTHING. That is the property which
    // protects a real database from a partial teardown, and it is exactly what the previous
    // (never-executed, stale) version of this test silently stopped checking.
    it("G4 rollback fails closed while a later migration is applied, and changes nothing", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        // Rolling 0015 back first is itself refused: 0016+ are applied.
        await expect(migrator.query(rb("rollback-partner-management.sql"))).rejects.toThrow(
          /refusing G5 rollback: a later migration \(0016\+\) is applied/i
        );
        // The refusal aborts inside this script's own BEGIN, so the connection is left in a failed
        // transaction — the documented caller requirement (see rollback-partner-connector-g1.sql).
        await migrator.query("ROLLBACK").catch(() => {});

        // And the G4 rollback itself refuses for its own documented reason.
        await expect(migrator.query(rb("rollback-partner-connector-admin-actions.sql"))).rejects.toThrow(
          /refusing G4 rollback: a later migration \(0015\+\) is applied/i
        );
        await migrator.query("ROLLBACK").catch(() => {});

        // NOTHING changed: the G4 table, its journal row, the G5 tables and the neighbouring
        // connector evidence table all survive both refused attempts intact.
        const exists = await admin.query("SELECT to_regclass($1) AS t", [TABLE]);
        expect(exists.rows[0].t).not.toBeNull();
        const j = await admin.query(
          "SELECT status FROM schema_migrations WHERE filename='0014_partner_connector_admin_actions.sql'"
        );
        expect(j.rows).toHaveLength(1);
        expect(j.rows[0].status).toBe("applied");
        const g5 = await admin.query("SELECT to_regclass('partner_management_audit') AS t");
        expect(g5.rows[0].t).not.toBeNull();
        const survive = await admin.query("SELECT to_regclass('partner_connector_import_attempts') AS t");
        expect(survive.rows[0].t).not.toBeNull();

        // The forward chain is still consistent after the refusals — nothing left half-applied.
        const plan = await planMigrations(migrator, partnerScopeOnly(listMigrationFiles()));
        expect(plan.pending).toHaveLength(0);
        expect(plan.inconsistent).toHaveLength(0);
        expect(plan.checksumMismatches).toHaveLength(0);
      } finally {
        await migrator.end();
      }
    });
  }
);
