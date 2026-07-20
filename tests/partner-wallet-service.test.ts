/** Partner Network G6A service behavior on a self-owned PostgreSQL 17.10 cluster. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { migratorUrlFrom, provisionRealisticRoles } from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let service: typeof import("../server/partner/partner-wallet-service");
let tenantA: string;
let tenantB: string;

const actor = { actorUserId: null, actorEmail: "g6a-test@example.com" };

describe("Partner Network G6A wallet service on PostgreSQL 17.10", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("wallet-service");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
    await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
    await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
    for (const table of ["users", "submissions", "submission_items"]) {
      await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
    }
    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      await applyMigrations(migrator, listMigrationFiles());
    } finally {
      await migrator.end();
    }
    tenantA = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Service A','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    tenantB = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Service B','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    service = await import("../server/partner/partner-wallet-service");
  }, 90_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("ensures exactly one zero-balance wallet per organisation under concurrency", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => service.ensureWallet(actor, tenantA)));
    expect(new Set(wallets.map((wallet) => wallet.id)).size).toBe(1);
    expect((await service.getBalance(tenantA)).balance).toBe(0);
    expect(
      (await admin.query("SELECT count(*)::int n FROM partner_wallets WHERE tenant_id=$1", [tenantA])).rows[0].n
    ).toBe(1);
    await service.ensureWallet(actor, tenantB);
  });

  it("appends positive foundation credits and derives the balance from the ledger", async () => {
    const result = await service.appendFoundationCredit(actor, {
      tenantId: tenantA,
      amount: 100,
      entryType: "purchase",
      source: "admin",
      reason: "foundation credit",
      idempotencyKey: "credit-a-1",
      actorType: "admin",
      metadata: { package: "starter" },
    });
    expect(result.alreadyApplied).toBe(false);
    expect(result.entry.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await service.getBalance(tenantA)).balance).toBe(100);
  });

  it("rejects zero, negative, non-integer, and out-of-range service amounts", async () => {
    for (const amount of [0, -1, 1.5, 2_000_000_000, Number.NaN]) {
      await expect(
        service.appendFoundationCredit(actor, {
          tenantId: tenantA,
          amount,
          entryType: "admin_adjustment",
          source: "admin",
          reason: "invalid amount",
          idempotencyKey: `bad-${String(amount)}`,
          actorType: "admin",
        })
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("returns the original row for the same canonical request, including reordered metadata", async () => {
    const input = {
      tenantId: tenantB,
      amount: 50,
      entryType: "purchase" as const,
      source: "stripe" as const,
      reason: "package credit",
      idempotencyKey: "canonical-retry",
      actorType: "system" as const,
      correlationId: "correlation-1",
      externalRef: "external-1",
      metadata: { beta: { z: 2, a: 1 }, alpha: [3, 2, 1] },
    };
    const first = await service.appendFoundationCredit(actor, input);
    const retry = await service.appendFoundationCredit(actor, {
      ...input,
      metadata: { alpha: [3, 2, 1], beta: { a: 1, z: 2 } },
    });
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.entry.id).toBe(first.entry.id);
    expect(retry.entry.request_fingerprint).toBe(first.entry.request_fingerprint);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM partner_credit_ledger WHERE source='stripe' AND idempotency_key='canonical-retry'"
        )
      ).rows[0].n
    ).toBe(1);
  });

  it.each([
    ["amount", { amount: 51 }],
    ["reason", { reason: "different reason" }],
    ["correlation", { correlationId: "correlation-2" }],
    ["external reference", { externalRef: "external-2" }],
    ["actor type", { actorType: "service" as const }],
    ["metadata", { metadata: { alpha: [3, 2, 1], beta: { a: 999, z: 2 } } }],
  ])("rejects same-source/key reuse with a different %s", async (_field, change) => {
    await expect(
      service.appendFoundationCredit(actor, {
        tenantId: tenantB,
        amount: 50,
        entryType: "purchase",
        source: "stripe",
        reason: "package credit",
        idempotencyKey: "canonical-retry",
        actorType: "system",
        correlationId: "correlation-1",
        externalRef: "external-1",
        metadata: { alpha: [3, 2, 1], beta: { a: 1, z: 2 } },
        ...change,
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects same-source/key reuse for a different tenant", async () => {
    await expect(
      service.appendFoundationCredit(actor, {
        tenantId: tenantA,
        amount: 50,
        entryType: "purchase",
        source: "stripe",
        reason: "package credit",
        idempotencyKey: "canonical-retry",
        actorType: "system",
        correlationId: "correlation-1",
        externalRef: "external-1",
        metadata: { alpha: [3, 2, 1], beta: { a: 1, z: 2 } },
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("includes actor identity in the fingerprint without leaking it in conflicts", async () => {
    const firstActor = { actorUserId: tenantA, actorEmail: "first@example.com" };
    const input = {
      tenantId: tenantA,
      amount: 3,
      entryType: "admin_adjustment" as const,
      source: "admin" as const,
      reason: "actor-bound",
      idempotencyKey: "actor-bound",
      actorType: "admin" as const,
    };
    await service.appendFoundationCredit(firstActor, input);
    await expect(
      service.appendFoundationCredit({ actorUserId: tenantB, actorEmail: "second@example.com" }, input)
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      message: "idempotencyKey was already used by this source for a different request.",
    });
  });

  it("allows the same idempotency key from a different source", async () => {
    const common = {
      tenantId: tenantA,
      amount: 2,
      entryType: "purchase" as const,
      reason: "producer scoped",
      idempotencyKey: "producer-key",
      actorType: "system" as const,
    };
    const system = await service.appendFoundationCredit(actor, { ...common, source: "system" });
    const connector = await service.appendFoundationCredit(actor, { ...common, source: "connector" });
    expect(system.entry.id).not.toBe(connector.entry.id);
  });

  it("concurrent exact retries create one row and all resolve to it", async () => {
    const input = {
      tenantId: tenantA,
      amount: 7,
      entryType: "purchase" as const,
      source: "admin" as const,
      reason: "exact race",
      idempotencyKey: "exact-race",
      actorType: "admin" as const,
      metadata: { run: 1 },
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => service.appendFoundationCredit(actor, input)));
    expect(new Set(results.map((result) => result.entry.id)).size).toBe(1);
    expect(results.filter((result) => !result.alreadyApplied)).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM partner_credit_ledger WHERE source='admin' AND idempotency_key='exact-race'"
        )
      ).rows[0].n
    ).toBe(1);
  });

  it("concurrent conflicting retries create one row and deterministically reject every loser", async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        service.appendFoundationCredit(actor, {
          tenantId: tenantB,
          amount: 9,
          entryType: "purchase",
          source: "system",
          reason: `conflicting race ${index}`,
          idempotencyKey: "conflicting-race",
          actorType: "system",
        })
      )
    );
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    }
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM partner_credit_ledger WHERE source='system' AND idempotency_key='conflicting-race'"
        )
      ).rows[0].n
    ).toBe(1);
  });

  it("returns bounded newest-first ledger history", async () => {
    const result = await service.listLedger(tenantA, 1, 2);
    expect(result.pageSize).toBe(2);
    expect(result.entries.length).toBeLessThanOrEqual(2);
    expect(result.total).toBeGreaterThan(0);
    if (result.entries.length === 2) {
      expect(new Date(result.entries[0].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(result.entries[1].created_at).getTime()
      );
    }
  });

  it("contains no generic debit export, G6B vocabulary, HTTP mutation route, or mutable balance", async () => {
    const serviceSource = readFileSync(join(process.cwd(), "server/partner/partner-wallet-service.ts"), "utf8");
    const migrationSource = readFileSync(join(process.cwd(), "migrations/0016_partner_wallet_ledger.sql"), "utf8");
    const routeSources = ["server/routes.ts", "server/partner/routes.ts"]
      .map((path) => {
        try {
          return readFileSync(join(process.cwd(), path), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    expect(serviceSource).not.toMatch(/export (async )?function appendLedgerEntry/);
    expect(serviceSource).not.toMatch(/UPDATE\s+partner_credit_ledger|DELETE\s+FROM\s+partner_credit_ledger/i);
    expect(migrationSource).not.toMatch(/'reserve'|'release'|'consume'/);
    expect(routeSources).not.toMatch(/appendFoundationCredit|partner_credit_ledger/);
    const columns = (
      await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='partner_wallets'")
    ).rows.map((row) => row.column_name);
    expect(columns).not.toContain("balance");
  });
});
