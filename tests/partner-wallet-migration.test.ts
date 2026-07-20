/**
 * Partner Network G6A — migration 0016 (partner_wallets + partner_credit_ledger) proof on a disposable
 * Postgres with the realistic non-superuser role model (pn_migrator owner; partner_runtime NOBYPASSRLS;
 * partner_definer BYPASSRLS).
 *
 * Proves: clean journaled apply of the FULL chain 0001→0016; 0016 journaled; schema/objects/constraints/
 * indexes/trigger/view/grants; wallet uniqueness (one per org); GLOBAL idempotency unique; ledger
 * immutability (UPDATE/DELETE/TRUNCATE blocked for EVERY role incl. superuser); FORCE RLS two-tenant
 * isolation; runtime role has SELECT only (no DML); balance view derivation; rollback.
 *
 * Runs ONLY when PARTNER_WALLET_MIGRATION_ADMIN is a superuser URL to a DISPOSABLE loopback Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";

const ADMIN = process.env.PARTNER_WALLET_MIGRATION_ADMIN;
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

function roleUrl(role: string): string {
  const u = new URL(ADMIN!);
  u.username = role;
  u.password = "synthetic";
  return u.toString();
}

let admin: Client;
let A: string; // tenant A org id
let B: string; // tenant B org id
let walletA: string;

async function seedMintVaultTables(): Promise<void> {
  await admin.query(
    "CREATE TABLE IF NOT EXISTS users (id varchar primary key default gen_random_uuid(), email varchar unique)"
  );
  await admin.query(
    "CREATE TABLE IF NOT EXISTS submissions (id serial primary key, user_id varchar, tracking_number text unique)"
  );
  await admin.query(
    "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
  );
  await admin.query("ALTER TABLE users OWNER TO pn_migrator");
  await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
  await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
}

(isLocal ? describe : describe.skip)(
  "Partner Network G6A — migration 0016 wallet + credit ledger (disposable DB)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await provisionRealisticRoles(admin);
      await seedMintVaultTables();
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        await applyMigrations(migrator, listMigrationFiles());
      } finally {
        await migrator.end();
      }
      // a login role that is a member of partner_runtime (for RLS proofs via SET ROLE)
      await admin.query("DROP ROLE IF EXISTS wallet_rt_test").catch(() => {});
      await admin.query("CREATE ROLE wallet_rt_test LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_runtime TO wallet_rt_test");
      // two synthetic tenants, each a wallet + one ledger entry (as superuser admin — bypasses RLS)
      A = (
        await admin.query<{ id: string }>(
          "INSERT INTO partner_organisations (legal_name, status) VALUES ('Tenant A Ltd','ACTIVE') RETURNING id"
        )
      ).rows[0].id;
      B = (
        await admin.query<{ id: string }>(
          "INSERT INTO partner_organisations (legal_name, status) VALUES ('Tenant B Ltd','ACTIVE') RETURNING id"
        )
      ).rows[0].id;
      walletA = (
        await admin.query<{ id: string }>("INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id", [A])
      ).rows[0].id;
      const walletB = (
        await admin.query<{ id: string }>("INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id", [B])
      ).rows[0].id;
      await admin.query(
        "INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type) VALUES ($1,$2,10,'opening_balance','A-seed','admin','seed','admin')",
        [walletA, A]
      );
      await admin.query(
        "INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type) VALUES ($1,$2,5,'opening_balance','B-seed','admin','seed','admin')",
        [walletB, B]
      );
    }, 60_000);

    afterAll(async () => {
      await admin?.query("DROP ROLE IF EXISTS wallet_rt_test").catch(() => {});
      await admin?.end().catch(() => {});
    });

    it("full chain applies and 0016 is journaled once", async () => {
      const { rows } = await admin.query(
        "SELECT status FROM schema_migrations WHERE filename='0016_partner_wallet_ledger.sql'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
      const all = await admin.query("SELECT count(*)::int n FROM schema_migrations");
      expect(all.rows[0].n).toBe(16);
    });

    it("reapplying the full set is a clean no-op", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const plan = await planMigrations(migrator, listMigrationFiles());
        expect(plan.pending).toHaveLength(0);
        expect(plan.checksumMismatches).toHaveLength(0);
      } finally {
        await migrator.end();
      }
    });

    it("expected tables, view, trigger, indexes and FORCE RLS exist", async () => {
      const tabs = (
        await admin.query(
          "SELECT tablename FROM pg_tables WHERE tablename IN ('partner_wallets','partner_credit_ledger') ORDER BY 1"
        )
      ).rows.map((r) => r.tablename);
      expect(tabs).toEqual(["partner_credit_ledger", "partner_wallets"]);
      const view = await admin.query("SELECT 1 FROM pg_views WHERE viewname='partner_wallet_balances'");
      expect(view.rowCount).toBe(1);
      const rls = await admin.query(
        "SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('partner_wallets','partner_credit_ledger') ORDER BY relname"
      );
      expect(rls.rows.every((r) => r.relforcerowsecurity === true)).toBe(true);
      const trg = (
        await admin.query(
          "SELECT tgname FROM pg_trigger WHERE tgrelid='partner_credit_ledger'::regclass AND NOT tgisinternal ORDER BY tgname"
        )
      ).rows.map((r) => r.tgname);
      expect(trg).toContain("trg_partner_credit_ledger_no_row_mutate");
      expect(trg).toContain("trg_partner_credit_ledger_no_truncate");
      const idem = await admin.query("SELECT indexdef FROM pg_indexes WHERE indexname='uq_partner_credit_ledger_idem'");
      expect(idem.rows[0].indexdef).toMatch(/UNIQUE/);
      expect(idem.rows[0].indexdef).toMatch(/\(idempotency_key\)/); // GLOBAL uniqueness
    });

    it("grants: partner_runtime has SELECT only on wallet+ledger; no DML; no PUBLIC", async () => {
      for (const t of ["partner_wallets", "partner_credit_ledger"]) {
        const g = (
          await admin.query(
            "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='partner_runtime' ORDER BY 1",
            [t]
          )
        ).rows.map((r) => r.privilege_type);
        expect(g).toEqual(["SELECT"]);
        const pub = await admin.query(
          "SELECT count(*)::int n FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='PUBLIC'",
          [t]
        );
        expect(pub.rows[0].n).toBe(0);
      }
    });

    it("one wallet per organisation (tenant_id UNIQUE blocks a second)", async () => {
      await expect(admin.query("INSERT INTO partner_wallets (tenant_id) VALUES ($1)", [A])).rejects.toMatchObject({
        code: "23505",
      });
    });

    it("global idempotency: a duplicate idempotency_key is blocked", async () => {
      await expect(
        admin.query(
          "INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type) VALUES ($1,$2,1,'purchase','A-seed','admin','dup','admin')",
          [walletA, A]
        )
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("amount CHECK blocks zero and out-of-range", async () => {
      await expect(
        admin.query(
          "INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type) VALUES ($1,$2,0,'purchase','z1','admin','x','admin')",
          [walletA, A]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        admin.query(
          "INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type) VALUES ($1,$2,2000000000,'purchase','z2','admin','x','admin')",
          [walletA, A]
        )
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("ledger is append-only: UPDATE / DELETE / TRUNCATE are blocked even for the superuser owner", async () => {
      await expect(
        admin.query("UPDATE partner_credit_ledger SET amount=999 WHERE tenant_id=$1", [A])
      ).rejects.toMatchObject({ code: "23001" });
      await expect(admin.query("DELETE FROM partner_credit_ledger WHERE tenant_id=$1", [A])).rejects.toMatchObject({
        code: "23001",
      });
      await expect(admin.query("TRUNCATE partner_credit_ledger")).rejects.toMatchObject({ code: "23001" });
    });

    it("FORCE RLS two-tenant isolation for the runtime role", async () => {
      const rt = new Client({ connectionString: roleUrl("wallet_rt_test") });
      await rt.connect();
      try {
        await rt.query("SET ROLE partner_runtime");
        // no tenant context → sees nothing
        expect((await rt.query("SELECT count(*)::int n FROM partner_wallets")).rows[0].n).toBe(0);
        expect((await rt.query("SELECT count(*)::int n FROM partner_credit_ledger")).rows[0].n).toBe(0);
        // tenant A context → sees only A
        await rt.query("SELECT set_config('app.tenant_id',$1,false)", [A]);
        expect((await rt.query("SELECT count(*)::int n FROM partner_wallets")).rows[0].n).toBe(1);
        const aRows = await rt.query("SELECT tenant_id FROM partner_credit_ledger");
        expect(aRows.rows.every((r) => r.tenant_id === A)).toBe(true);
        // tenant B context → cannot see A
        await rt.query("SELECT set_config('app.tenant_id',$1,false)", [B]);
        const bRows = await rt.query("SELECT tenant_id FROM partner_credit_ledger");
        expect(bRows.rows.every((r) => r.tenant_id === B)).toBe(true);
        expect(bRows.rows.some((r) => r.tenant_id === A)).toBe(false);
        // runtime has no INSERT grant → cannot write (permission denied)
        await expect(rt.query("INSERT INTO partner_wallets (tenant_id) VALUES ($1)", [A])).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          rt.query(
            "INSERT INTO partner_credit_ledger (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type) VALUES ($1,$2,1,'purchase','rt1','portal','x','partner_user')",
            [walletA, A]
          )
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await rt.query("RESET ROLE").catch(() => {});
        await rt.end();
      }
    });

    it("balance view derives SUM(amount) per wallet", async () => {
      const bal = await admin.query<{ balance: string; ledger_entry_count: string }>(
        "SELECT balance, ledger_entry_count FROM partner_wallet_balances WHERE tenant_id=$1",
        [A]
      );
      expect(bal.rows[0].balance).toBe("10");
      expect(bal.rows[0].ledger_entry_count).toBe("1");
    });

    it("organisation with a wallet/ledger cannot be casually deleted (FK RESTRICT)", async () => {
      await expect(admin.query("DELETE FROM partner_organisations WHERE id=$1", [A])).rejects.toMatchObject({
        code: "23503",
      });
    });

    it("rollback drops the G6A objects + de-journals + reapplies cleanly", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        await migrator.query(rb("rollback-partner-wallet-ledger.sql"));
        expect((await admin.query("SELECT to_regclass('public.partner_wallets') t")).rows[0].t).toBeNull();
        expect((await admin.query("SELECT to_regclass('public.partner_credit_ledger') t")).rows[0].t).toBeNull();
        const j = await admin.query("SELECT 1 FROM schema_migrations WHERE filename='0016_partner_wallet_ledger.sql'");
        expect(j.rows).toHaveLength(0);
        // G5 survives
        expect((await admin.query("SELECT to_regclass('public.partner_management_audit') t")).rows[0].t).not.toBeNull();
        const { applied } = await applyMigrations(migrator, listMigrationFiles());
        expect(applied).toContain("0016_partner_wallet_ledger.sql");
      } finally {
        await migrator.end();
      }
    });
  }
);
