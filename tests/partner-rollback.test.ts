/**
 * DB-F2 — Partner Network rollback safety, proven on a disposable Postgres with a populated
 * migration journal (driven through the real migrate runner's applyMigrations).
 *
 * Proves:
 *   - the legacy 0001-only rollback REFUSES to run once later migrations (0002–0006) are applied;
 *   - the comprehensive rollback removes migrations 0001–0006 fully — every partner_* table,
 *     helper function, both restricted roles (partner_definer + partner_runtime), and all journal
 *     rows — while PRESERVING pre-existing MintVault data;
 *   - migrations reapply cleanly afterwards.
 *
 * Runs ONLY when PARTNER_ROLLBACK_ADMIN (a superuser URL to a DISPOSABLE local Postgres that is the
 * ONLY partner database in its cluster) is set, because dropping the cluster-level roles requires
 * no cross-database dependency:
 *   PARTNER_ROLLBACK_ADMIN=postgresql://postgres@127.0.0.1:5546/rollbackdb \
 *   npx vitest run tests/partner-rollback.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";

const ADMIN = process.env.PARTNER_ROLLBACK_ADMIN;
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
    await applyMigrations(migrator, listMigrationFiles()); // populates schema_migrations journal
  } finally {
    await migrator.end();
  }
}

(isLocal ? describe : describe.skip)("Partner Network rollback safety (DB-F2, disposable DB)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    // synthetic PRE-EXISTING MintVault data that must survive the rollback
    await admin.query("CREATE TABLE IF NOT EXISTS certificates (id serial primary key, cert_id text, secret text)");
    await admin.query("INSERT INTO certificates (cert_id, secret) VALUES ('MV1','KEEP-A'),('MV2','KEEP-B')");
    await admin.query("ALTER TABLE certificates OWNER TO pn_migrator").catch(() => {}); // owned by migrator too (after roles exist)
    await applyAllRealistic();
    // ensure certificates exists+owned even though roles are created inside applyAllRealistic
    await admin.query("ALTER TABLE certificates OWNER TO pn_migrator").catch(() => {});
  }, 40_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
  });

  it("legacy rollback-0001 REFUSES once later migrations are applied (node-pg path)", async () => {
    await expect(admin.query(rb("rollback-0001-partner-foundation.sql"))).rejects.toThrow(
      /0001-ONLY rollback.*later Partner migrations|full Phase 1 rollback/
    );
  });

  it("legacy rollback-0001 guard PROTECTS even via `psql -f` without ON_ERROR_STOP (transaction wrapper)", async () => {
    // The dangerous path the DB reviewer flagged: run the .sql file through psql with its DEFAULT
    // ON_ERROR_STOP=off. Without the BEGIN/COMMIT wrapper, psql would print the guard error and
    // still execute the DROPs. With the wrapper, the raise aborts the transaction and COMMIT rolls
    // back — the partner tables must SURVIVE.
    try {
      execFileSync("psql", [ADMIN!, "-f", join(process.cwd(), "migrations", "rollback-0001-partner-foundation.sql")], {
        stdio: "pipe",
      });
    } catch {
      // psql exits non-zero because the guard raised — expected. What matters is the DB state below.
    }
    const res = await admin.query("SELECT to_regclass('public.partner_users') r");
    expect(res.rows[0].r).toBe("partner_users"); // table survived the refused rollback
  });

  it("comprehensive rollback removes migrations 0001–0006 fully and preserves MintVault data", async () => {
    await admin.query(rb("rollback-partner-network-phase1.sql"));

    const tables = await admin.query(
      "SELECT count(*)::int n FROM information_schema.tables WHERE table_name LIKE 'partner_%'"
    );
    expect(tables.rows[0].n).toBe(0);
    const fns = await admin.query(
      "SELECT count(*)::int n FROM information_schema.routines WHERE routine_name LIKE 'partner_%'"
    );
    expect(fns.rows[0].n).toBe(0);
    const definer = await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='partner_definer'");
    expect(definer.rows[0].n).toBe(0);
    const runtime = await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='partner_runtime'");
    expect(runtime.rows[0].n).toBe(0);
    const journal = await admin.query("SELECT count(*)::int n FROM schema_migrations WHERE filename LIKE '%partner%'");
    expect(journal.rows[0].n).toBe(0);

    // synthetic MintVault data survives
    const certs = await admin.query("SELECT secret FROM certificates ORDER BY id");
    expect(certs.rows.map((r) => r.secret)).toEqual(["KEEP-A", "KEEP-B"]);
  });

  it("migrations reapply cleanly after rollback", async () => {
    await applyAllRealistic();
    const tables = await admin.query(
      "SELECT count(*)::int n FROM information_schema.tables WHERE table_name LIKE 'partner_%'"
    );
    expect(tables.rows[0].n).toBeGreaterThanOrEqual(16);
    const owner = await admin.query(
      "SELECT pg_get_userbyid(proowner) o FROM pg_proc WHERE proname='partner_auth_lookup'"
    );
    expect(owner.rows[0].o).toBe("partner_definer");
  });
});
