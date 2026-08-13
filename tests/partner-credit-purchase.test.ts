/**
 * P5 — BUY MORE GRADING CREDITS, proven against real PostgreSQL.
 *
 * The rule under test: the verified Stripe WEBHOOK is the only thing that grants a Grading Credit,
 * and it grants EXACTLY ONCE however many times it is delivered.
 *
 * The replay and concurrency cases run against a real database on purpose. Exactly-once here is not
 * application logic — it is `uq_partner_credit_ledger_idem (source, idempotency_key)`, a unique index.
 * A mocked database would assert that the code calls the grant once, which is a far weaker and much
 * less interesting claim than the database refusing the second row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let purchase: typeof import("../server/partner/credit-purchase-service");
/** Ambient DB env captured in beforeAll and restored in afterAll — see the note there. */
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorUserId: null, actorEmail: "ops@mintvault.test" };

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function makeTenant(label: string): Promise<string> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}`, `${label} Ltd`]
    )
  ).rows[0].id;
  await wallet.ensureWallet(adminActor, tenantId);
  return tenantId;
}

async function availableFor(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ available: string }>(
    `SELECT available_balance::text AS available FROM partner_credit_availability WHERE tenant_id=$1`,
    [tenantId]
  );
  return Number(rows[0]?.available ?? 0);
}

function session(tenantId: string, packCode: string, id = "cs_test_1", paid = true) {
  return {
    id,
    payment_status: paid ? "paid" : "unpaid",
    metadata: {
      partner_tenant_id: tenantId,
      partner_pack_code: packCode,
      partner_initiating_user_id: "11111111-1111-1111-1111-111111111111",
    },
  };
}

describe("P5 Buy More Grading Credits (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-credit-purchase");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);
    // Restore the ambient environment in afterAll: vitest may share a process across FILES, and
    // leaving these pointing at a stopped cluster makes every later partner suite fail closed.
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    wallet = await import("../server/partner/partner-wallet-service");
    purchase = await import("../server/partner/credit-purchase-service");
  }, 180_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("catalogues the five pilot packs, none purchasable until pricing is configured", async () => {
    const packs = await purchase.listCreditPacks();
    expect(packs.map((p) => p.credits)).toEqual([5, 10, 25, 50, 100]);
    // This is the pilot state and it is deliberate: the flow is complete, the money is owner-gated.
    expect(packs.every((p) => p.purchasable === false)).toBe(true);
    await expect(purchase.resolvePackForCheckout("PACK_25")).rejects.toMatchObject({
      code: "PACK_NOT_PURCHASABLE",
    });
  });

  it("becomes purchasable the moment a Stripe Price id is configured — data, not a deploy", async () => {
    await admin.query(`UPDATE partner_credit_packs SET stripe_price_id='price_test_25' WHERE code='PACK_25'`);
    const pack = await purchase.resolvePackForCheckout("PACK_25");
    expect(pack.credits).toBe(25);
    expect(pack.purchasable).toBe(true);
    await admin.query(`UPDATE partner_credit_packs SET stripe_price_id=NULL WHERE code='PACK_25'`);
  });

  it("grants exactly the pack's credits on a paid webhook", async () => {
    const tenantId = await makeTenant("grant");
    expect(await availableFor(tenantId)).toBe(0);

    const out = await purchase.fulfilPartnerCreditPurchase(session(tenantId, "PACK_10"), "evt_grant_1");
    expect(out).toMatchObject({ granted: true, credits: 10 });
    expect(await availableFor(tenantId)).toBe(10);

    // The ledger row is a real purchase from Stripe, not an admin adjustment.
    const entry = await admin.query<{ entry_type: string; source: string; amount: string }>(
      `SELECT entry_type, source, amount::text FROM partner_credit_ledger WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(entry.rows[0]).toMatchObject({ entry_type: "purchase", source: "stripe", amount: "10" });
  });

  it("REPLAY: the same event delivered five times grants once", async () => {
    const tenantId = await makeTenant("replay");
    for (let i = 0; i < 5; i++) {
      await purchase.fulfilPartnerCreditPurchase(session(tenantId, "PACK_50"), "evt_replay_1");
    }
    expect(await availableFor(tenantId)).toBe(50); // not 250
    const n = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM partner_credit_ledger WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(n.rows[0].n).toBe("1");
  });

  it("CONCURRENT DELIVERY of one event grants once", async () => {
    const tenantId = await makeTenant("concurrent");
    // Stripe can deliver the same event to both Fly Machines at once. The ledger unique index is
    // what makes that safe, so fire them genuinely in parallel rather than in sequence.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        purchase.fulfilPartnerCreditPurchase(session(tenantId, "PACK_100"), "evt_concurrent_1")
      )
    );
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await availableFor(tenantId)).toBe(100); // exactly one grant, never 600
    const n = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM partner_credit_ledger WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(n.rows[0].n).toBe("1");
  });

  it("DISTINCT events grant separately — replay safety is not accidental deduplication", async () => {
    const tenantId = await makeTenant("distinct");
    await purchase.fulfilPartnerCreditPurchase(session(tenantId, "PACK_5", "cs_a"), "evt_distinct_a");
    await purchase.fulfilPartnerCreditPurchase(session(tenantId, "PACK_5", "cs_b"), "evt_distinct_b");
    expect(await availableFor(tenantId)).toBe(10); // two genuine purchases
  });

  it("an UNPAID or expired session grants nothing", async () => {
    const tenantId = await makeTenant("unpaid");
    const out = await purchase.fulfilPartnerCreditPurchase(
      session(tenantId, "PACK_100", "cs_unpaid", false),
      "evt_unpaid_1"
    );
    expect(out).toMatchObject({ granted: false, reason: "session_not_paid" });
    expect(await availableFor(tenantId)).toBe(0);
  });

  it("credits come from the SERVER catalogue, never from session metadata", async () => {
    const tenantId = await makeTenant("tamper");
    // A tampered session claiming 9999 credits must still grant only what PACK_5 is worth.
    const tampered = {
      ...session(tenantId, "PACK_5", "cs_tamper"),
      metadata: {
        partner_tenant_id: tenantId,
        partner_pack_code: "PACK_5",
        credits: "9999",
        amount_total: "999999",
      },
    };
    const out = await purchase.fulfilPartnerCreditPurchase(tampered, "evt_tamper_1");
    expect(out.credits).toBe(5);
    expect(await availableFor(tenantId)).toBe(5);
  });

  it("an unknown pack code grants nothing", async () => {
    const tenantId = await makeTenant("unknown");
    const out = await purchase.fulfilPartnerCreditPurchase(
      session(tenantId, "PACK_DOES_NOT_EXIST", "cs_unknown"),
      "evt_unknown_1"
    );
    expect(out).toMatchObject({ granted: false, reason: "pack_not_found" });
    expect(await availableFor(tenantId)).toBe(0);
  });

  it("a non-partner checkout is ignored without error", async () => {
    // Another product's webhook must not raise — Stripe would retry it forever.
    const out = await purchase.fulfilPartnerCreditPurchase(
      { id: "cs_other", payment_status: "paid", metadata: { some_other_product: "yes" } },
      "evt_other_1"
    );
    expect(out).toMatchObject({ granted: false, reason: "not_a_partner_credit_purchase" });
  });

  it("purchase permission: OWNER yes, MANAGER only when granted, GRADER never", () => {
    const none = new Set<string>();
    const granted = new Set(["partner.credits.purchase"]);

    expect(purchase.canPurchaseCredits("OWNER", none)).toBe(true);
    expect(purchase.canPurchaseCredits("PARTNER_OWNER", none)).toBe(true);

    // Billing authority is granted, never assumed.
    expect(purchase.canPurchaseCredits("MANAGER", none)).toBe(false);
    expect(purchase.canPurchaseCredits("MANAGER", granted)).toBe(true);

    // A grading role never buys — even if someone grants the permission by mistake.
    expect(purchase.canPurchaseCredits("GRADER", none)).toBe(false);
    expect(purchase.canPurchaseCredits("GRADER", granted)).toBe(false);
    expect(purchase.canPurchaseCredits("PARTNER_GRADER", granted)).toBe(false);
  });

  it("a refund is recorded as an audited exception and does NOT reduce capacity", async () => {
    const tenantId = await makeTenant("refund");
    await purchase.fulfilPartnerCreditPurchase(session(tenantId, "PACK_25", "cs_refund"), "evt_refund_grant");
    expect(await availableFor(tenantId)).toBe(25);

    await purchase.recordPurchaseException("evt_refund_1", {
      tenantId,
      sessionId: "cs_refund",
      kind: "refund",
    });

    // Capacity is deliberately untouched: it may already be reserved against cards mid-grade, and a
    // silent debit would strand them. A human resolves it with an audited adjustment.
    expect(await availableFor(tenantId)).toBe(25);
    const ex = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM partner_credit_accounting_exceptions WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(ex.rows[0].n).toBe("1");

    // Recording the same exception twice is a no-op, so a retried refund webhook cannot pile up rows.
    await purchase.recordPurchaseException("evt_refund_1", {
      tenantId,
      sessionId: "cs_refund",
      kind: "refund",
    });
    const ex2 = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM partner_credit_accounting_exceptions WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(ex2.rows[0].n).toBe("1");
  });
});

/**
 * The INTEGRATION surfaces wired on top of the proven grant core: the webhook branch and the
 * checkout route. These are source-level contract assertions — the behavioural guarantees are proven
 * against real PostgreSQL above. What they protect is the wiring itself: a future edit that removes
 * the metadata contract, pre-claims the partner event, or lets the browser grant would still pass
 * every behavioural test while breaking the money path.
 */
describe("P5 integration surfaces", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const webhook = read("server/webhookHandlers.ts");
  const routes = read("server/partner/routes.ts");

  it("routes the partner branch through the proven grant, and NEVER pre-claims it", () => {
    expect(webhook).toContain("fulfilPartnerCreditPurchase");
    expect(webhook).toContain("meta.partner_tenant_id && meta.partner_pack_code");

    /*
     * The partner branch must NOT call claimStripeEvent. Its claim would be written through the
     * main `db` while the grant goes through the partner ADMIN pool, so they cannot share a
     * transaction: a claim that succeeded before a transient grant failure would mark the event
     * processed, Stripe's retry would skip it, and the partner would pay and never receive the
     * credits. Exactly-once is carried by the ledger unique index, which lives in the same database
     * as the grant.
     */
    const branch = webhook.slice(
      webhook.indexOf("meta.partner_tenant_id && meta.partner_pack_code"),
      webhook.indexOf("charge.refunded")
    );
    expect(branch).not.toContain("claimStripeEvent");
  });

  it("routes refunds and disputes to audited exception handling, never to a wallet debit", () => {
    expect(webhook).toContain('event.type === "charge.refunded"');
    expect(webhook).toContain('event.type === "charge.dispute.created"');
    expect(webhook).toContain("recordPurchaseException");
    // No negative ledger write anywhere on the refund path.
    const refundBranch = webhook.slice(webhook.indexOf('event.type === "charge.refunded"'));
    expect(refundBranch).not.toMatch(/appendFoundationCredit/);
  });

  it("checkout creates a session and grants nothing itself", () => {
    expect(routes).toContain('r.post(\n    "/credits/checkout"');
    expect(routes).toContain('requirePartnerCapability("partner.credits.purchase")');
    // Spending money is a sensitive mutation: view-only and emergency-frozen principals are refused.
    expect(routes).toContain("requireNotViewOnly");
    expect(routes).toContain("requireNotSensitiveFrozen");
    // The route may never grant — only the webhook may.
    const checkout = routes.slice(routes.indexOf('"/credits/checkout"'));
    expect(checkout).not.toMatch(/appendFoundationCredit|fulfilPartnerCreditPurchase/);
  });

  it("carries only attribution in metadata — never the credit quantity", () => {
    const checkout = routes.slice(routes.indexOf('"/credits/checkout"'));
    expect(checkout).toContain("partner_tenant_id");
    expect(checkout).toContain("partner_pack_code");
    // Quantity is resolved server-side from the pack code at grant time. Putting it in metadata
    // would make a tampered session able to mint capacity.
    expect(checkout).not.toMatch(/metadata:\s*\{[^}]*credits/s);
  });

  it("hard-blocks a grading role even if the purchase permission was granted", () => {
    const checkout = routes.slice(routes.indexOf('"/credits/checkout"'));
    expect(checkout).toContain("canPurchaseCredits");
    expect(checkout).toContain("Your role cannot buy Grading Credits.");
  });

  it("exposes the pack catalogue so the dashboard can gate on `purchasable`", () => {
    expect(routes).toContain('"/credits/packs"');
    expect(routes).toContain("listCreditPacks");
  });
});
