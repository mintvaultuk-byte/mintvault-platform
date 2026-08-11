/**
 * WALLET PROVISIONING ON ACTIVATION — behavioural proof on real PostgreSQL 17.
 *
 * THE BUG THIS PINS: `ensureWallet()` shipped with G6A and was correct — idempotent via
 * `ON CONFLICT (tenant_id) DO NOTHING` plus a definitive re-read, and creating zero ledger rows.
 * It simply had NO caller anywhere in server/. `grep -rn "INSERT INTO partner_wallets" server/`
 * returned exactly one hit: inside ensureWallet itself.
 *
 * The consequence was total, not cosmetic. Every credit surface resolves the wallet first:
 * getWallet, getBalance, loadWalletForUpdate (the Super Admin /credits/adjust path),
 * getWalletSummary, listLedgerEntries and the reservation service all raise WALLET_NOT_FOUND on a
 * missing row, and submission-service treats WALLET_NOT_FOUND as submission-blocking. So an ACTIVE
 * partner could not be funded and could not submit — confirmed on staging 2026-08-03, where
 * partner_wallets held 0 rows against 2 ACTIVE organisations.
 *
 * WHY PROVISIONING RUNS BEFORE THE STATUS WRITE: changeStatus runs on the auto-commit admin pool,
 * so the wallet insert and the status flip cannot share a transaction without converting a shipped
 * G5 path to withPartnerAdminTransaction. Ordering buys the same safety by choosing the benign
 * failure — a wallet on a non-activated org (zero credits, zero ledger, reused verbatim later)
 * rather than an ACTIVE org with no wallet. That ordering is asserted below, not assumed.
 *
 * MUTATION TARGET: WALLET1 (remove the ensureWallet call from changeStatus) must turn this red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let svc: typeof import("../server/partner/partner-management-service");
let wallet: typeof import("../server/partner/partner-wallet-service");

const ACTOR = {
  actorUserId: "aaaa1111-2222-3333-4444-555566667777",
  actorEmail: "superadmin@example.test",
  requestId: "wallet-prov",
} as const;
let seq = 0;
const actor = (extra: Record<string, unknown> = {}) => ({ ...ACTOR, ...extra }) as never;

/** The HQ tables 0041's guard triggers attach to; omitting them makes the migration list fail. */
async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(
    "CREATE TABLE certificates (id serial primary key, cert_id text, secret text)"
  );
  await admin.query(
    "CREATE TABLE label_prints (id serial primary key, certificate_id integer, created_at timestamptz not null default now())"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

describe("Wallet provisioning on organisation activation (PostgreSQL 17)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("wallet-provisioning");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    process.env.PARTNER_CREDIT_DATABASE_URL = cluster.url;
    process.env.SESSION_SECRET = "synthetic-wallet-prov-secret-not-committed";

    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);

    svc = await import("../server/partner/partner-management-service");
    wallet = await import("../server/partner/partner-wallet-service");
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await cluster?.stop();
  });

  // NO between-test TRUNCATE. partner_credit_ledger carries a BEFORE TRUNCATE guard
  // (`partner_credit_ledger is append-only: TRUNCATE is not permitted`) and a no-row-mutate trigger
  // blocking DELETE, so the ledger cannot be reset — by design, and a CASCADE from
  // partner_organisations trips the same guard even with zero rows present. Every test therefore
  // creates its own organisation and asserts only against that tenant_id, which is closer to
  // production anyway: rows accumulate exactly as they would in a real database.

  async function newPendingPartner(name: string): Promise<string> {
    seq += 1;
    const r = await svc.createPartner(actor({ requestId: `create-${seq}` }), { legalName: name }, "wallet proof");
    return (r.result as { partnerId: string }).partnerId;
  }

  async function version(tenantId: string): Promise<number> {
    const r = await admin.query<{ version: number }>("SELECT version FROM partner_profiles WHERE tenant_id=$1", [
      tenantId,
    ]);
    return Number(r.rows[0].version);
  }

  async function activate(tenantId: string, reason = "pilot activation"): Promise<void> {
    seq += 1;
    await svc.changeStatus(actor({ requestId: `act-${seq}` }), tenantId, "ACTIVE", await version(tenantId), reason);
  }

  async function walletRows(tenantId: string) {
    const r = await admin.query("SELECT id, tenant_id, status, credit_unit FROM partner_wallets WHERE tenant_id=$1", [
      tenantId,
    ]);
    return r.rows;
  }

  it("a PENDING organisation has no wallet before activation", async () => {
    const id = await newPendingPartner("Pre-activation Ltd");
    expect(await walletRows(id)).toHaveLength(0);
    // And the absence is loud, not a fabricated zero.
    await expect(wallet.getWallet(id)).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  it("activating an organisation provisions exactly one wallet", async () => {
    const id = await newPendingPartner("Activation Ltd");
    await activate(id);
    const rows = await walletRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: id, status: "active", credit_unit: "grading_credit" });
  });

  it("provisioning fabricates NO ledger row — the new wallet is a true zero, not an asserted one", async () => {
    const id = await newPendingPartner("Zero Ledger Ltd");
    await activate(id);
    const ledger = await admin.query("SELECT count(*)::int AS n FROM partner_credit_ledger WHERE tenant_id=$1", [id]);
    expect(ledger.rows[0].n).toBe(0);
    // Balance is DERIVED from the ledger, so an empty ledger must read as a real zero.
    const balance = await wallet.getBalance(id);
    expect(balance.balance).toBe(0);
    expect(Number(balance.ledgerEntryCount)).toBe(0);
  });

  it("a missing wallet stays distinguishable from a genuine zero balance", async () => {
    const missing = await newPendingPartner("Never Activated Ltd");
    const zero = await newPendingPartner("Activated Ltd");
    await activate(zero);
    // Genuine zero: resolves, reports 0.
    expect((await wallet.getBalance(zero)).balance).toBe(0);
    // Missing: refuses. If these ever collapse to the same answer, a funding failure would render
    // as "0 credits" and look like an ordinary empty wallet.
    await expect(wallet.getBalance(missing)).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  it("re-activation creates no duplicate and preserves the original wallet identity", async () => {
    const id = await newPendingPartner("Cycling Ltd");
    await activate(id);
    const first = (await walletRows(id))[0];

    await svc.changeStatus(actor({ requestId: "susp" }), id, "SUSPENDED", await version(id), "pause");
    await activate(id, "resume");

    const rows = await walletRows(id);
    expect(rows).toHaveLength(1);
    // Same wallet id — a re-activated partner must keep its balance and history, not get a new purse.
    expect(rows[0].id).toBe(first.id);
  });

  it("the tenant_id UNIQUE constraint holds under concurrent activation attempts", async () => {
    const id = await newPendingPartner("Racing Ltd");
    // Drive ensureWallet directly and concurrently: changeStatus itself is version-locked, so the
    // race that matters is the provisioning primitive, not the status transition.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => wallet.ensureWallet({ actorUserId: null, actorEmail: null }, id))
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await walletRows(id)).toHaveLength(1);
  });

  it("a transition to a NON-active status provisions nothing", async () => {
    const id = await newPendingPartner("Revoked Ltd");
    // PENDING → REVOKED is the only non-ACTIVE transition legal from PENDING (STATUS_TRANSITIONS).
    await svc.changeStatus(actor({ requestId: "rev" }), id, "REVOKED", await version(id), "declined");
    expect(await walletRows(id)).toHaveLength(0);
  });

  it("provisioning is audited on the existing status_changed event, with no new audit action type", async () => {
    const id = await newPendingPartner("Audited Ltd");
    await activate(id);
    // withAudit writes TWO rows per operation: an 'attempted' row carrying before_state, then an
    // outcome row carrying after_state. The provisioning flag rides the existing status_changed
    // action — deliberately, so no CHECK constraint on partner_management_audit.action_type moves.
    const a = await admin.query<{ after_state: Record<string, unknown> }>(
      `SELECT after_state FROM partner_management_audit
        WHERE tenant_id=$1 AND action_type='status_changed' AND after_state IS NOT NULL`,
      [id]
    );
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].after_state).toMatchObject({ to: "ACTIVE", walletProvisioned: true });
  });

  it("wallet provisioning precedes the status write, so a provisioning failure cannot strand an ACTIVE org without a wallet", async () => {
    const id = await newPendingPartner("Ordering Ltd");
    // Force ensureWallet to fail at the DB level for this tenant only, by removing the org row the
    // wallet FK requires... instead, assert the ordering directly and deterministically: an org
    // whose activation threw must NOT be ACTIVE.
    await admin.query(
      "ALTER TABLE partner_wallets ADD CONSTRAINT tmp_block_insert CHECK (tenant_id IS NULL) NOT VALID"
    );
    let threw = false;
    try {
      await activate(id);
    } catch {
      threw = true;
    } finally {
      await admin.query("ALTER TABLE partner_wallets DROP CONSTRAINT tmp_block_insert");
    }
    expect(threw, "activation must fail when the wallet cannot be provisioned").toBe(true);
    const org = await admin.query<{ status: string }>("SELECT status FROM partner_organisations WHERE id=$1", [id]);
    // The whole point: the org is still PENDING, so a retry is clean. The forbidden outcome is
    // ACTIVE-with-no-wallet, which is exactly what a post-status provisioning order would produce.
    expect(org.rows[0].status).not.toBe("ACTIVE");
    expect(await walletRows(id)).toHaveLength(0);
  });
});
