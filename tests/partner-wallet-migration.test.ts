/** Partner Network G6A database invariants on a self-owned PostgreSQL 17.10 cluster. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles, planMigrations } from "../scripts/db/migrate";
import { migratorUrlFrom, provisionRealisticRoles } from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const rollbackSql = readFileSync(join(process.cwd(), "migrations", "rollback-partner-wallet-ledger.sql"), "utf8");
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

let cluster: DisposablePostgres17;
let adminUrl: string;
let admin: Client;
let tenantA: string;
let tenantB: string;
let walletA: string;
let walletB: string;

function roleUrl(role: string): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = "synthetic";
  return url.toString();
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  for (const table of ["users", "submissions", "submission_items"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function migrate(): Promise<void> {
  const migrator = new Client({ connectionString: migratorUrlFrom(adminUrl) });
  await migrator.connect();
  try {
    await applyMigrations(
      migrator,
      listMigrationFiles().filter((file) => Number(file.number) <= 16)
    );
  } finally {
    await migrator.end();
  }
}

async function attemptRollback(): Promise<unknown> {
  const migrator = new Client({ connectionString: migratorUrlFrom(adminUrl) });
  await migrator.connect();
  try {
    return await migrator.query(rollbackSql);
  } catch (error) {
    await migrator.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await migrator.end();
  }
}

async function assertG6AObjectsPresent(): Promise<void> {
  const objects = await admin.query(
    "SELECT to_regclass('public.partner_wallets') wallets, to_regclass('public.partner_credit_ledger') ledger, to_regclass('public.partner_wallet_balances') balances"
  );
  expect(objects.rows[0]).toEqual({
    wallets: "partner_wallets",
    ledger: "partner_credit_ledger",
    balances: "partner_wallet_balances",
  });
}

describe("Partner Network G6A migration on PostgreSQL 17.10", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("wallet-migration");
    adminUrl = cluster.url;
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await migrate();
    await admin.query("CREATE ROLE wallet_rt_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO wallet_rt_test");
  }, 90_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("applies the full chain once with the expected constraints, triggers, RLS, and grants", async () => {
    expect((await admin.query("SHOW server_version")).rows[0].server_version).toMatch(/^17\.10(?:\s|$)/);
    expect((await admin.query("SELECT count(*)::int n FROM schema_migrations WHERE status='applied'")).rows[0].n).toBe(
      16
    );
    await assertG6AObjectsPresent();
    const constraints = (
      await admin.query(
        "SELECT conname FROM pg_constraint WHERE conrelid IN ('partner_wallets'::regclass,'partner_credit_ledger'::regclass)"
      )
    ).rows.map((row) => row.conname);
    expect(constraints).toContain("uq_partner_wallets_identity");
    expect(constraints).toContain("fk_partner_credit_ledger_wallet_identity");
    const triggers = (
      await admin.query(
        "SELECT tgname FROM pg_trigger WHERE tgrelid IN ('partner_wallets'::regclass,'partner_credit_ledger'::regclass) AND NOT tgisinternal"
      )
    ).rows.map((row) => row.tgname);
    expect(triggers).toContain("trg_partner_wallet_identity_no_mutate");
    expect(triggers).toContain("trg_partner_credit_ledger_no_row_mutate");
    expect(triggers).toContain("trg_partner_credit_ledger_no_truncate");
    const idem = await admin.query("SELECT indexdef FROM pg_indexes WHERE indexname='uq_partner_credit_ledger_idem'");
    expect(idem.rows[0].indexdef).toMatch(/UNIQUE.*\(source, idempotency_key\)/);
    const rls = await admin.query(
      "SELECT bool_and(relrowsecurity AND relforcerowsecurity) ok FROM pg_class WHERE relname IN ('partner_wallets','partner_credit_ledger')"
    );
    expect(rls.rows[0].ok).toBe(true);
    for (const table of ["partner_wallets", "partner_credit_ledger"]) {
      const grants = (
        await admin.query(
          "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='partner_runtime' ORDER BY 1",
          [table]
        )
      ).rows.map((row) => row.privilege_type);
      expect(grants).toEqual(["SELECT"]);
    }
    const owners = await admin.query(
      "SELECT tablename, tableowner FROM pg_tables WHERE tablename IN ('partner_wallets','partner_credit_ledger') ORDER BY tablename"
    );
    expect(owners.rows).toEqual([
      { tablename: "partner_credit_ledger", tableowner: "pn_migrator" },
      { tablename: "partner_wallets", tableowner: "pn_migrator" },
    ]);
  });

  it("reapplication plans as a clean no-op", async () => {
    const migrator = new Client({ connectionString: migratorUrlFrom(adminUrl) });
    await migrator.connect();
    try {
      const plan = await planMigrations(
        migrator,
        listMigrationFiles().filter((file) => Number(file.number) <= 16)
      );
      expect(plan.pending).toHaveLength(0);
      expect(plan.checksumMismatches).toHaveLength(0);
    } finally {
      await migrator.end();
    }
  });

  it("serializes realistic role provisioning across concurrent database connections", async () => {
    const clients = Array.from({ length: 6 }, () => new Client({ connectionString: adminUrl }));
    await Promise.all(clients.map((client) => client.connect()));
    try {
      await Promise.all(clients.map((client) => provisionRealisticRoles(client)));
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
    expect((await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='pn_migrator'")).rows[0].n).toBe(1);
    expect((await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='partner_definer'")).rows[0].n).toBe(
      1
    );
  });

  it("allows a transactional rollback only while G6A is empty, then reapplies cleanly", async () => {
    await attemptRollback();
    expect((await admin.query("SELECT to_regclass('public.partner_wallets') value")).rows[0].value).toBeNull();
    expect((await admin.query("SELECT to_regclass('public.partner_credit_ledger') value")).rows[0].value).toBeNull();
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM schema_migrations WHERE filename='0016_partner_wallet_ledger.sql'"
        )
      ).rows[0].n
    ).toBe(0);
    await migrate();
    await assertG6AObjectsPresent();
  });

  it("refuses rollback when wallets exist without ledger rows and preserves the empty wallets", async () => {
    tenantA = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Tenant A','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    tenantB = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Tenant B','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    walletA = (
      await admin.query<{ id: string }>("INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id", [tenantA])
    ).rows[0].id;
    walletB = (
      await admin.query<{ id: string }>("INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id", [tenantB])
    ).rows[0].id;
    await expect(attemptRollback()).rejects.toThrow(/partner_wallets contains wallet data/);
    await assertG6AObjectsPresent();
    expect((await admin.query("SELECT count(*)::int n FROM partner_wallets")).rows[0].n).toBe(2);
    expect((await admin.query("SELECT count(*)::int n FROM partner_credit_ledger")).rows[0].n).toBe(0);
  });

  it("accepts matching wallet/tenant rows and rejects a wallet A + tenant B row", async () => {
    await admin.query(
      "INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint) VALUES ($1,$2,10,'opening_balance','seed-a','migration','seed','system',$3)",
      [walletA, tenantA, fingerprintA]
    );
    await expect(
      admin.query(
        "INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint) VALUES ($1,$2,9,'opening_balance','mismatch','migration','attack','system',$3)",
        [walletA, tenantB, fingerprintB]
      )
    ).rejects.toMatchObject({ code: "23503", constraint: "fk_partner_credit_ledger_wallet_identity" });
    expect(
      (await admin.query("SELECT balance FROM partner_wallet_balances WHERE wallet_id=$1", [walletA])).rows[0].balance
    ).toBe("10");
  });

  it("makes wallet identity immutable while deliberately allowing status lifecycle updates", async () => {
    const original = (await admin.query("SELECT created_at, credit_unit FROM partner_wallets WHERE id=$1", [walletA]))
      .rows[0];
    const attacks: Array<[string, unknown[]]> = [
      ["UPDATE partner_wallets SET tenant_id=$2 WHERE id=$1", [walletA, tenantB]],
      ["UPDATE partner_wallets SET id=gen_random_uuid() WHERE id=$1", [walletA]],
      ["UPDATE partner_wallets SET created_at=created_at - interval '1 day' WHERE id=$1", [walletA]],
      ["UPDATE partner_wallets SET credit_unit='rewritten_credit' WHERE id=$1", [walletA]],
    ];
    for (const [sql, params] of attacks) {
      await expect(admin.query(sql, params)).rejects.toMatchObject({ code: "23001" });
    }
    const status = await admin.query(
      "UPDATE partner_wallets SET status='suspended', suspended_at=now(), updated_at=now() WHERE id=$1 RETURNING status",
      [walletA]
    );
    expect(status.rows[0].status).toBe("suspended");
    await admin.query("UPDATE partner_wallets SET status='active', suspended_at=NULL, updated_at=now() WHERE id=$1", [
      walletA,
    ]);
    expect(
      (await admin.query("SELECT created_at, credit_unit FROM partner_wallets WHERE id=$1", [walletA])).rows[0]
    ).toEqual(original);
  });

  it("blocks every ledger mutation, including fingerprint/key/source changes and conflict updates", async () => {
    const changes = [
      "amount=11",
      "reason='rewritten'",
      "metadata='{\"changed\":true}'::jsonb",
      `request_fingerprint='${fingerprintB}'`,
      "source='admin'",
      "idempotency_key='rewritten'",
    ];
    for (const change of changes) {
      await expect(
        admin.query(`UPDATE partner_credit_ledger SET ${change} WHERE wallet_id=$1`, [walletA])
      ).rejects.toMatchObject({
        code: "23001",
      });
    }
    await expect(admin.query("DELETE FROM partner_credit_ledger WHERE wallet_id=$1", [walletA])).rejects.toMatchObject({
      code: "23001",
    });
    await expect(admin.query("TRUNCATE partner_credit_ledger")).rejects.toMatchObject({ code: "23001" });
    await expect(
      admin.query(
        "INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint) VALUES ($1,$2,10,'opening_balance','seed-a','migration','changed','system',$3) ON CONFLICT (source,idempotency_key) DO UPDATE SET reason=excluded.reason",
        [walletA, tenantA, fingerprintA]
      )
    ).rejects.toMatchObject({ code: "23001" });
  });

  it("scopes idempotency by source and rejects invalid fingerprints and G6B types", async () => {
    await admin.query(
      "INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint) VALUES ($1,$2,1,'purchase','seed-a','admin','independent producer','admin',$3)",
      [walletA, tenantA, fingerprintB]
    );
    expect(
      (await admin.query("SELECT count(*)::int n FROM partner_credit_ledger WHERE idempotency_key='seed-a'")).rows[0].n
    ).toBe(2);
    await expect(
      admin.query(
        "INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint) VALUES ($1,$2,1,'purchase','bad-fp','admin','bad','admin','short')",
        [walletA, tenantA]
      )
    ).rejects.toMatchObject({ code: "23514" });
    for (const type of ["reserve", "release", "consume"]) {
      await expect(
        admin.query(
          "INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint) VALUES ($1,$2,-1,$3,$4,'system','forbidden','system',$5)",
          [walletA, tenantA, type, `forbidden-${type}`, fingerprintB]
        )
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("keeps admin and runtime balances consistent and prevents known-ID cross-tenant discovery", async () => {
    const runtime = new Client({ connectionString: roleUrl("wallet_rt_test") });
    await runtime.connect();
    try {
      await runtime.query("SET ROLE partner_runtime");
      expect((await runtime.query("SELECT count(*)::int n FROM partner_wallets")).rows[0].n).toBe(0);
      await runtime.query("SELECT set_config('app.tenant_id','not-a-uuid',false)");
      expect((await runtime.query("SELECT count(*)::int n FROM partner_credit_ledger")).rows[0].n).toBe(0);
      await runtime.query("SELECT set_config('app.tenant_id',$1,false)", [tenantA]);
      expect(
        (await runtime.query("SELECT balance FROM partner_wallet_balances WHERE wallet_id=$1", [walletA])).rows[0]
          .balance
      ).toBe("11");
      expect(
        (await runtime.query("SELECT count(*)::int n FROM partner_wallets WHERE id=$1", [walletB])).rows[0].n
      ).toBe(0);
      expect(
        (await runtime.query("SELECT count(*)::int n FROM partner_credit_ledger WHERE wallet_id=$1", [walletB])).rows[0]
          .n
      ).toBe(0);
      await runtime.query("SELECT set_config('app.tenant_id',$1,false)", [tenantB]);
      expect(
        (await runtime.query("SELECT count(*)::int n FROM partner_credit_ledger WHERE wallet_id=$1", [walletA])).rows[0]
          .n
      ).toBe(0);
      await expect(
        runtime.query("INSERT INTO partner_wallets (tenant_id) VALUES ($1)", [tenantB])
      ).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.query(
          "INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint) VALUES ($1,$2,1,'purchase','runtime-write','portal','forbidden','partner_user',$3)",
          [walletB, tenantB, fingerprintB]
        )
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtime.query("RESET ROLE").catch(() => {});
      await runtime.end();
    }
    expect(
      (await admin.query("SELECT balance FROM partner_wallet_balances WHERE wallet_id=$1", [walletA])).rows[0].balance
    ).toBe("11");
  });

  it("refuses rollback with ledger data and leaves every row and object intact", async () => {
    const before = (await admin.query("SELECT count(*)::int n FROM partner_credit_ledger")).rows[0].n;
    await expect(attemptRollback()).rejects.toThrow(/partner_credit_ledger contains financial history/);
    await assertG6AObjectsPresent();
    expect((await admin.query("SELECT count(*)::int n FROM partner_credit_ledger")).rows[0].n).toBe(before);
  });

  it("refuses rollback with a later migration marker before dropping anything", async () => {
    await admin.query(
      "INSERT INTO schema_migrations (filename,checksum,status,completed_at) VALUES ('0017_test_dependency.sql','synthetic','applied',now())"
    );
    try {
      await expect(attemptRollback()).rejects.toThrow(/later migration/);
      await assertG6AObjectsPresent();
    } finally {
      await admin.query("DELETE FROM schema_migrations WHERE filename='0017_test_dependency.sql'");
    }
  });

  it("wallet and ledger foreign keys restrict organisation deletion", async () => {
    await expect(admin.query("DELETE FROM partner_organisations WHERE id=$1", [tenantA])).rejects.toMatchObject({
      code: "23503",
    });
  });
});
