/**
 * Partner Network G6A — wallet/ledger SERVICE behaviour on a disposable Postgres, plus source-level
 * guarantees. The service uses the privileged admin pool (partnerAdminQuery → MINTVAULT_DATABASE_URL),
 * mirroring prod where that role is BYPASSRLS. Gated on PARTNER_WALLET_SERVICE_ADMIN (loopback superuser).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";

const ADMIN = process.env.PARTNER_WALLET_SERVICE_ADMIN;
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
let svc: typeof import("../server/partner/partner-wallet-service");
let orgA: string;
let orgB: string;
const actor = { actorUserId: null, actorEmail: "deploy-test@example.com" };

(isLocal ? describe : describe.skip)("Partner Network G6A — wallet/ledger service (disposable DB)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS users (id varchar primary key default gen_random_uuid(), email varchar unique)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial primary key, user_id varchar, tracking_number text unique)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
    );
    for (const t of ["users", "submissions", "submission_items"])
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
    await migrator.connect();
    try {
      await applyMigrations(migrator, listMigrationFiles());
    } finally {
      await migrator.end();
    }
    orgA = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Svc A','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    orgB = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Svc B','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    // the service reads process.env.MINTVAULT_DATABASE_URL through partnerAdminQuery
    process.env.MINTVAULT_DATABASE_URL = ADMIN;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    svc = await import("../server/partner/partner-wallet-service");
  }, 60_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
  });

  it("ensureWallet is idempotent and one-per-org; different orgs get different wallets", async () => {
    const w1 = await svc.ensureWallet(actor, orgA);
    const w2 = await svc.ensureWallet(actor, orgA);
    expect(w1.id).toBe(w2.id);
    const wb = await svc.ensureWallet(actor, orgB);
    expect(wb.id).not.toBe(w1.id);
    const n = await admin.query("SELECT count(*)::int c FROM partner_wallets WHERE tenant_id=$1", [orgA]);
    expect(n.rows[0].c).toBe(1);
  });

  it("concurrent ensureWallet cannot create duplicates", async () => {
    const org = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Svc C','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    const results = await Promise.all(Array.from({ length: 6 }, () => svc.ensureWallet(actor, org)));
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    const n = await admin.query("SELECT count(*)::int c FROM partner_wallets WHERE tenant_id=$1", [org]);
    expect(n.rows[0].c).toBe(1);
  });

  it("new wallet balance is zero; positive+negative entries sum correctly (ledger-derived)", async () => {
    await svc.ensureWallet(actor, orgA);
    expect((await svc.getBalance(orgA)).balance).toBe(0);
    await svc.appendLedgerEntry(actor, {
      tenantId: orgA,
      amount: 100,
      entryType: "purchase",
      source: "admin",
      reason: "buy",
      idempotencyKey: "A-buy-1",
      actorType: "admin",
    });
    await svc.appendLedgerEntry(actor, {
      tenantId: orgA,
      amount: -30,
      entryType: "consume",
      source: "system",
      reason: "spend",
      idempotencyKey: "A-spend-1",
      actorType: "system",
    });
    expect((await svc.getBalance(orgA)).balance).toBe(70);
  });

  it("rejects zero, non-integer, and out-of-range amounts", async () => {
    for (const bad of [0, 1.5, 2_000_000_000, Number.NaN]) {
      await expect(
        svc.appendLedgerEntry(actor, {
          tenantId: orgA,
          amount: bad as number,
          entryType: "admin_adjustment",
          source: "admin",
          reason: "x",
          idempotencyKey: `bad-${bad}`,
          actorType: "admin",
        })
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("append to an org without a wallet fails WALLET_NOT_FOUND", async () => {
    const org = (
      await admin.query<{ id: string }>(
        "INSERT INTO partner_organisations (legal_name,status) VALUES ('Svc NoWallet','ACTIVE') RETURNING id"
      )
    ).rows[0].id;
    await expect(
      svc.appendLedgerEntry(actor, {
        tenantId: org,
        amount: 5,
        entryType: "purchase",
        source: "admin",
        reason: "x",
        idempotencyKey: "nw-1",
        actorType: "admin",
      })
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  it("idempotency: same key + same payload returns the original, creates no duplicate", async () => {
    await svc.ensureWallet(actor, orgB);
    const first = await svc.appendLedgerEntry(actor, {
      tenantId: orgB,
      amount: 50,
      entryType: "purchase",
      source: "stripe",
      reason: "pkg",
      idempotencyKey: "B-idem-1",
      actorType: "system",
    });
    expect(first.alreadyApplied).toBe(false);
    const balAfter = (await svc.getBalance(orgB)).balance;
    const retry = await svc.appendLedgerEntry(actor, {
      tenantId: orgB,
      amount: 50,
      entryType: "purchase",
      source: "stripe",
      reason: "pkg",
      idempotencyKey: "B-idem-1",
      actorType: "system",
    });
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.entry.id).toBe(first.entry.id);
    expect((await svc.getBalance(orgB)).balance).toBe(balAfter);
  });

  it("idempotency: same key + conflicting amount OR conflicting wallet fails", async () => {
    await expect(
      svc.appendLedgerEntry(actor, {
        tenantId: orgB,
        amount: 51,
        entryType: "purchase",
        source: "stripe",
        reason: "pkg",
        idempotencyKey: "B-idem-1",
        actorType: "system",
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      svc.appendLedgerEntry(actor, {
        tenantId: orgA,
        amount: 50,
        entryType: "purchase",
        source: "stripe",
        reason: "pkg",
        idempotencyKey: "B-idem-1",
        actorType: "system",
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("concurrent duplicate append results in exactly one ledger entry", async () => {
    await svc.ensureWallet(actor, orgA);
    const key = "A-concurrent-1";
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        svc.appendLedgerEntry(actor, {
          tenantId: orgA,
          amount: 7,
          entryType: "purchase",
          source: "admin",
          reason: "race",
          idempotencyKey: key,
          actorType: "admin",
        })
      )
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    expect(ok.length).toBe(5); // all resolve (one new, rest alreadyApplied)
    const created = ok.filter(
      (s) => (s as PromiseFulfilledResult<{ alreadyApplied: boolean }>).value.alreadyApplied === false
    );
    expect(created.length).toBe(1);
    const n = await admin.query("SELECT count(*)::int c FROM partner_credit_ledger WHERE idempotency_key=$1", [key]);
    expect(n.rows[0].c).toBe(1);
  });

  it("listLedger returns newest-first with bounded pagination", async () => {
    const res = await svc.listLedger(orgA, 1, 2);
    expect(res.pageSize).toBe(2);
    expect(res.entries.length).toBeLessThanOrEqual(2);
    if (res.entries.length === 2) {
      expect(new Date(res.entries[0].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(res.entries[1].created_at).getTime()
      );
    }
    expect(res.total).toBeGreaterThan(0);
  });

  it("no mutable authoritative balance: partner_wallets has no balance column", async () => {
    const cols = (
      await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='partner_wallets'")
    ).rows.map((r) => r.column_name);
    expect(cols).not.toContain("balance");
    expect(cols).not.toContain("credit_balance");
  });

  // ---- source-level guarantees (no harness) ----
  const svcSrc = readFileSync(join(process.cwd(), "server/partner/partner-wallet-service.ts"), "utf8");
  const migSrc = readFileSync(join(process.cwd(), "migrations/0016_partner_wallet_ledger.sql"), "utf8");

  it("service exposes NO update/delete-ledger path and no balance-mutation", () => {
    expect(svcSrc).not.toMatch(/UPDATE\s+partner_credit_ledger/i);
    expect(svcSrc).not.toMatch(/DELETE\s+FROM\s+partner_credit_ledger/i);
    expect(svcSrc).not.toMatch(/UPDATE\s+partner_wallets\s+SET\s+balance/i);
    expect(svcSrc).not.toMatch(/export (async )?function (update|delete)Ledger/i);
  });

  it("migration touches no protected system and enables no flag", () => {
    // Scan executable SQL only (strip -- comments; the header prose names protected systems it AVOIDS).
    // NB: 'stripe' is an allowed forward-compat ledger SOURCE enum value (not Stripe integration) — the
    // guarantee here is that no protected-system OBJECT is referenced by the migration DDL.
    const exec = migSrc.replace(/--[^\n]*/g, "");
    expect(exec).not.toMatch(/certificates|cert_counter|certificate_number|\blabels\b|nfc_tag|vault_quest|\bvq_/i);
    expect(exec).not.toMatch(/partner_feature_flags|partner_portal_enabled|partner_connector_enabled/i);
    // 0016 makes NO grant/DDL against MintVault-internal tables (unlike 0010).
    expect(exec).not.toMatch(/GRANT[\s\S]*\bON\b[\s\S]*\b(users|submissions|submission_items)\b/i);
  });
});
