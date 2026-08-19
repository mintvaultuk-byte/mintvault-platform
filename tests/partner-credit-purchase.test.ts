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
  const credits = Number(packCode.replace("PACK_", ""));
  const amountPence = credits * 1_000;
  return {
    id,
    payment_status: paid ? "paid" : "unpaid",
    verifiedCheckout: true as const,
    livemode: false,
    currency: "gbp",
    amountTotal: amountPence,
    lineItems: [
      {
        priceId: `price_test_${packCode.toLowerCase()}`,
        currency: "gbp",
        unitAmount: amountPence,
        taxBehavior: "inclusive",
      },
    ],
    metadata: {
      partner_tenant_id: tenantId,
      partner_pack_code: packCode,
      partner_initiating_user_id: "11111111-1111-1111-1111-111111111111",
    },
  };
}

async function configureCanonicalPack(packCode: string, currency = "gbp"): Promise<void> {
  await admin.query(
    `UPDATE partner_credit_packs
        SET stripe_price_id=$1, stripe_currency=$2
      WHERE code=$3`,
    [`price_test_${packCode.toLowerCase()}`, currency, packCode]
  );
}

async function recordCheckoutIntent(tenantId: string, packCode: string, sessionId: string): Promise<void> {
  const pack = await purchase.resolvePackForCheckout(packCode);
  await purchase.recordPartnerCreditCheckoutIntent({
    stripeSessionId: sessionId,
    tenantId,
    packCode,
    initiatingUserId: "11111111-1111-1111-1111-111111111111",
    stripePriceId: pack.stripePriceId!,
    stripeCurrency: pack.stripeCurrency!,
    stripeEnvironment: "test",
  });
}

async function verifiedSession(tenantId: string, packCode: string, id: string, paid = true) {
  await recordCheckoutIntent(tenantId, packCode, id);
  return session(tenantId, packCode, id, paid);
}

function expectCreditPurchaseError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected CreditPurchaseError ${code}`);
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
      STRIPE_ENV: process.env.STRIPE_ENV,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    process.env.STRIPE_ENV = "test";
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
    expect(packs.map((p) => p.pricePence)).toEqual([5000, 10000, 25000, 50000, 100000]);
    expect(packs.map((p) => p.displayPrice)).toEqual(["£50", "£100", "£250", "£500", "£1,000"]);
    expect(packs.every((p) => p.vatIncluded === true)).toBe(true);
    // This is the pilot state and it is deliberate: the flow is complete, the money is owner-gated.
    expect(packs.every((p) => p.purchasable === false)).toBe(true);
    await expect(purchase.resolvePackForCheckout("PACK_25")).rejects.toMatchObject({
      code: "PACK_NOT_PURCHASABLE",
    });
  });

  it("becomes purchasable the moment a Stripe Price id is configured — data, not a deploy", async () => {
    await admin.query(
      `UPDATE partner_credit_packs SET stripe_price_id='price_test_25', stripe_currency='gbp' WHERE code='PACK_25'`
    );
    const pack = await purchase.resolvePackForCheckout("PACK_25");
    expect(pack.credits).toBe(25);
    expect(pack.purchasable).toBe(true);
    await admin.query(
      `UPDATE partner_credit_packs SET stripe_price_id=NULL, stripe_currency=NULL WHERE code='PACK_25'`
    );
  });

  it("ignores noncanonical active packs — only the five owner-approved packs can sell or grant", async () => {
    await admin.query(
      `INSERT INTO partner_credit_packs (code, credits, stripe_price_id, stripe_currency, active, sort_order)
       VALUES ('PACK_250', 250, 'price_test_pack_250', 'gbp', true, 250)`
    );
    const packs = await purchase.listCreditPacks();
    expect(packs.map((p) => p.code)).toEqual(["PACK_5", "PACK_10", "PACK_25", "PACK_50", "PACK_100"]);
    await expect(purchase.resolvePackForCheckout("PACK_250")).rejects.toMatchObject({ code: "PACK_NOT_FOUND" });

    const tenantId = await makeTenant("noncanonical-pack");
    const outcome = await purchase.fulfilPartnerCreditPurchase(
      session(tenantId, "PACK_250", "cs_noncanonical"),
      "evt_noncanonical_1"
    );
    expect(outcome).toMatchObject({ granted: false, credits: 0, reason: "pack_not_found" });
    expect(await availableFor(tenantId)).toBe(0);
  });

  it("validates the Stripe Price before Checkout creation can take payment", async () => {
    await configureCanonicalPack("PACK_25", "gbp");
    const pack = await purchase.resolvePackForCheckout("PACK_25");

    expect(() =>
      purchase.validateStripePriceForCheckout(pack, {
        id: "price_test_pack_25",
        currency: "gbp",
        unitAmount: 25000,
        taxBehavior: "inclusive",
        livemode: false,
        active: true,
      })
    ).not.toThrow();
    expectCreditPurchaseError(
      () =>
        purchase.validateStripePriceForCheckout(pack, {
          id: "price_test_other",
          currency: "gbp",
          unitAmount: 25000,
          taxBehavior: "inclusive",
          livemode: false,
          active: true,
        }),
      "STRIPE_PRICE_MISMATCH"
    );
    expectCreditPurchaseError(
      () =>
        purchase.validateStripePriceForCheckout(pack, {
          id: "price_test_pack_25",
          currency: "usd",
          unitAmount: 25000,
          taxBehavior: "inclusive",
          livemode: false,
          active: true,
        }),
      "STRIPE_CURRENCY_MISMATCH"
    );
    expectCreditPurchaseError(
      () =>
        purchase.validateStripePriceForCheckout(pack, {
          id: "price_test_pack_25",
          currency: "gbp",
          unitAmount: 25000,
          taxBehavior: "inclusive",
          livemode: true,
          active: true,
        }),
      "STRIPE_ENV_MISMATCH"
    );
    expectCreditPurchaseError(
      () =>
        purchase.validateStripePriceForCheckout(pack, {
          id: "price_test_pack_25",
          currency: "gbp",
          unitAmount: 25000,
          taxBehavior: "inclusive",
          livemode: false,
          active: false,
        }),
      "STRIPE_PRICE_INACTIVE"
    );
    expectCreditPurchaseError(
      () =>
        purchase.validateStripePriceForCheckout(pack, {
          id: "price_test_pack_25",
          currency: "gbp",
          unitAmount: 20000,
          taxBehavior: "inclusive",
          livemode: false,
          active: true,
        }),
      "STRIPE_AMOUNT_MISMATCH"
    );
    expectCreditPurchaseError(
      () =>
        purchase.validateStripePriceForCheckout(pack, {
          id: "price_test_pack_25",
          currency: "gbp",
          unitAmount: 25000,
          taxBehavior: "exclusive",
          livemode: false,
          active: true,
        }),
      "STRIPE_TAX_BEHAVIOR_MISMATCH"
    );
  });

  it("refuses checkout creation when Stripe mode is undeclared", async () => {
    await configureCanonicalPack("PACK_5", "gbp");
    const prior = process.env.STRIPE_ENV;
    delete process.env.STRIPE_ENV;
    try {
      const packs = await purchase.listCreditPacks();
      const pack = packs.find((p) => p.code === "PACK_5");
      expect(pack?.purchasable).toBe(false);
      expect(pack?.unavailableReason).toBe("stripe_environment_undeclared");
      await expect(purchase.resolvePackForCheckout("PACK_5")).rejects.toMatchObject({
        code: "STRIPE_ENV_UNDECLARED",
      });
    } finally {
      if (prior === undefined) delete process.env.STRIPE_ENV;
      else process.env.STRIPE_ENV = prior;
    }
  });

  it("keeps priced packs unpurchasable until the deployment declares TEST/LIVE Stripe mode", async () => {
    await configureCanonicalPack("PACK_5");
    const prior = process.env.STRIPE_ENV;
    delete process.env.STRIPE_ENV;
    try {
      const pack = (await purchase.listCreditPacks()).find((p) => p.code === "PACK_5");
      expect(pack).toMatchObject({
        purchasable: false,
        unavailableReason: "stripe_environment_undeclared",
      });
      await expect(purchase.resolvePackForCheckout("PACK_5")).rejects.toMatchObject({
        code: "STRIPE_ENV_UNDECLARED",
      });
    } finally {
      if (prior === undefined) delete process.env.STRIPE_ENV;
      else process.env.STRIPE_ENV = prior;
      await admin.query(
        `UPDATE partner_credit_packs SET stripe_price_id=NULL, stripe_currency=NULL WHERE code='PACK_5'`
      );
    }
  });

  it("keeps staging fail-closed if it is declared as live Stripe mode", async () => {
    await configureCanonicalPack("PACK_10");
    const prior = {
      STRIPE_ENV: process.env.STRIPE_ENV,
      APP_URL: process.env.APP_URL,
      FLY_APP_NAME: process.env.FLY_APP_NAME,
    };
    process.env.STRIPE_ENV = "live";
    process.env.APP_URL = "https://mintvault-v2.fly.dev";
    process.env.FLY_APP_NAME = "mintvault-v2";
    try {
      expect(purchase.checkoutStripeEnvironmentStatus()).toMatchObject({
        ok: false,
        code: "STRIPE_ENV_MISMATCH",
        reason: "stripe_environment_mismatch",
      });
      const pack = (await purchase.listCreditPacks()).find((p) => p.code === "PACK_10");
      expect(pack).toMatchObject({
        purchasable: false,
        unavailableReason: "stripe_environment_mismatch",
      });
      await expect(purchase.resolvePackForCheckout("PACK_10")).rejects.toMatchObject({
        code: "STRIPE_ENV_MISMATCH",
      });
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await admin.query(
        `UPDATE partner_credit_packs SET stripe_price_id=NULL, stripe_currency=NULL WHERE code='PACK_10'`
      );
    }
  });

  it("grants exactly the pack's credits on a paid webhook", async () => {
    const tenantId = await makeTenant("grant");
    await configureCanonicalPack("PACK_10");
    expect(await availableFor(tenantId)).toBe(0);

    const out = await purchase.fulfilPartnerCreditPurchase(
      await verifiedSession(tenantId, "PACK_10", "cs_grant_1"),
      "evt_grant_1"
    );
    expect(out).toMatchObject({ granted: true, credits: 10 });
    expect(await availableFor(tenantId)).toBe(10);

    // The ledger row is a real purchase from Stripe, not an admin adjustment.
    const entry = await admin.query<{ entry_type: string; source: string; amount: string }>(
      `SELECT entry_type, source, amount::text FROM partner_credit_ledger WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(entry.rows[0]).toMatchObject({ entry_type: "purchase", source: "stripe", amount: "10" });
  });

  it("REPLAY: the same event delivered five times grants once, and SAYS so", async () => {
    const tenantId = await makeTenant("replay");
    await configureCanonicalPack("PACK_50");
    const checkout = await verifiedSession(tenantId, "PACK_50", "cs_replay_1");
    for (let i = 0; i < 5; i++) {
      const outcome = await purchase.fulfilPartnerCreditPurchase(checkout, "evt_replay_1");
      /*
       * THE RETURN VALUE IS PART OF THE CONTRACT, not decoration — added after AT-21 found this.
       *
       * The ledger assertions below were always correct and always passed, which is exactly why the
       * defect hid here: `alreadyApplied` was discarded and EVERY delivery reported `granted: true`.
       * The webhook handler logs that value, so an ordinary Stripe redelivery storm wrote repeated
       * "granted" lines for one purchase — poisoning the single signal an operator would use to spot
       * a real double-grant.
       */
      expect(outcome.granted).toBe(i === 0);
      if (i > 0) expect(outcome.reason).toBe("already_granted");
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
    await configureCanonicalPack("PACK_100");
    const checkout = await verifiedSession(tenantId, "PACK_100", "cs_concurrent_1");
    // Stripe can deliver the same event to both Fly Machines at once. The ledger unique index is
    // what makes that safe, so fire them genuinely in parallel rather than in sequence.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => purchase.fulfilPartnerCreditPurchase(checkout, "evt_concurrent_1"))
    );
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    // EXACTLY ONE delivery may claim the grant, however many raced. See the replay test above.
    const claimed = results.filter((r) => r.status === "fulfilled" && (r.value as { granted: boolean }).granted);
    expect(claimed).toHaveLength(1);
    expect(await availableFor(tenantId)).toBe(100); // exactly one grant, never 600
    const n = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM partner_credit_ledger WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(n.rows[0].n).toBe("1");
  });

  it("SAME CHECKOUT SESSION with distinct event ids still grants once", async () => {
    const tenantId = await makeTenant("same-session");
    await configureCanonicalPack("PACK_25");
    const checkout = await verifiedSession(tenantId, "PACK_25", "cs_same_session_distinct_events");

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => purchase.fulfilPartnerCreditPurchase(checkout, `evt_same_session_${i}`))
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled") as Array<
      PromiseFulfilledResult<{ granted: boolean; reason?: string }>
    >;
    expect(fulfilled).toHaveLength(6);
    expect(fulfilled.filter((r) => r.value.granted)).toHaveLength(1);
    expect(fulfilled.filter((r) => r.value.reason === "already_granted")).toHaveLength(5);
    expect(await availableFor(tenantId)).toBe(25);
    const state = await admin.query<{ ledger: string; intents: string; status: string }>(
      `SELECT (SELECT count(*) FROM partner_credit_ledger WHERE tenant_id=$1)::text AS ledger,
              (SELECT count(*) FROM partner_credit_checkout_sessions WHERE tenant_id=$1)::text AS intents,
              (SELECT status FROM partner_credit_checkout_sessions WHERE stripe_session_id='cs_same_session_distinct_events') AS status`,
      [tenantId]
    );
    expect(state.rows[0]).toEqual({ ledger: "1", intents: "1", status: "granted" });
  });

  it("DISTINCT events grant separately — replay safety is not accidental deduplication", async () => {
    const tenantId = await makeTenant("distinct");
    await configureCanonicalPack("PACK_5");
    await purchase.fulfilPartnerCreditPurchase(
      await verifiedSession(tenantId, "PACK_5", "cs_distinct_a"),
      "evt_distinct_a"
    );
    await purchase.fulfilPartnerCreditPurchase(
      await verifiedSession(tenantId, "PACK_5", "cs_distinct_b"),
      "evt_distinct_b"
    );
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
    await configureCanonicalPack("PACK_5");
    await recordCheckoutIntent(tenantId, "PACK_5", "cs_tamper");
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

  it("a disabled pack grants nothing even for a previously created Checkout Session", async () => {
    const tenantId = await makeTenant("disabled-pack");
    await configureCanonicalPack("PACK_10");
    const checkout = await verifiedSession(tenantId, "PACK_10", "cs_disabled_pack");
    await admin.query(`UPDATE partner_credit_packs SET active=false WHERE code='PACK_10'`);
    try {
      const out = await purchase.fulfilPartnerCreditPurchase(checkout, "evt_disabled_pack_1");
      expect(out).toMatchObject({ granted: false, reason: "pack_disabled" });
      expect(await availableFor(tenantId)).toBe(0);
    } finally {
      await admin.query(`UPDATE partner_credit_packs SET active=true WHERE code='PACK_10'`);
    }
  });

  it("a verified Session without local Checkout provenance grants nothing", async () => {
    const tenantId = await makeTenant("no-intent");
    await configureCanonicalPack("PACK_10");
    const out = await purchase.fulfilPartnerCreditPurchase(
      session(tenantId, "PACK_10", "cs_no_local_intent"),
      "evt_no_local_intent_1"
    );
    expect(out).toMatchObject({ granted: false, reason: "checkout_intent_not_found" });
    expect(await availableFor(tenantId)).toBe(0);
  });

  it("wrong Partner binding in verified metadata grants zero", async () => {
    const rightfulTenant = await makeTenant("rightful-session-owner");
    const metadataTenant = await makeTenant("metadata-attacker");
    await configureCanonicalPack("PACK_10");
    await recordCheckoutIntent(rightfulTenant, "PACK_10", "cs_wrong_partner");

    const out = await purchase.fulfilPartnerCreditPurchase(
      session(metadataTenant, "PACK_10", "cs_wrong_partner"),
      "evt_wrong_partner_1"
    );
    expect(out).toMatchObject({ granted: false, reason: "checkout_partner_mismatch" });
    expect(await availableFor(rightfulTenant)).toBe(0);
    expect(await availableFor(metadataTenant)).toBe(0);
  });

  it("a non-partner checkout is ignored without error", async () => {
    // Another product's webhook must not raise — Stripe would retry it forever.
    const out = await purchase.fulfilPartnerCreditPurchase(
      { id: "cs_other", payment_status: "paid", metadata: { some_other_product: "yes" } },
      "evt_other_1"
    );
    expect(out).toMatchObject({ granted: false, reason: "not_a_partner_credit_purchase" });
  });

  it("refuses a browser/raw-event shaped partner checkout that was not re-read from Stripe", async () => {
    const tenantId = await makeTenant("unverified");
    await configureCanonicalPack("PACK_10");
    const unverified = { ...session(tenantId, "PACK_10"), verifiedCheckout: undefined };
    const out = await purchase.fulfilPartnerCreditPurchase(unverified, "evt_unverified_1");
    expect(out).toMatchObject({ granted: false, reason: "checkout_not_verified" });
    expect(await availableFor(tenantId)).toBe(0);
  });

  it("refuses a verified checkout with the wrong canonical Stripe Price or currency", async () => {
    const priceTenant = await makeTenant("wrong-price");
    const currencyTenant = await makeTenant("wrong-currency");
    await configureCanonicalPack("PACK_25", "gbp");
    await recordCheckoutIntent(priceTenant, "PACK_25", "cs_wrong_price");
    await recordCheckoutIntent(currencyTenant, "PACK_25", "cs_wrong_currency");

    const wrongPrice = {
      ...session(priceTenant, "PACK_25", "cs_wrong_price"),
      lineItems: [
        { priceId: "price_test_some_other_pack", currency: "gbp", unitAmount: 25000, taxBehavior: "inclusive" },
      ],
    };
    const priceOutcome = await purchase.fulfilPartnerCreditPurchase(wrongPrice, "evt_wrong_price_1");
    expect(priceOutcome).toMatchObject({ granted: false, reason: "checkout_price_mismatch" });
    expect(await availableFor(priceTenant)).toBe(0);

    const wrongCurrency = {
      ...session(currencyTenant, "PACK_25", "cs_wrong_currency"),
      currency: "usd",
      lineItems: [{ priceId: "price_test_pack_25", currency: "usd", unitAmount: 25000, taxBehavior: "inclusive" }],
    };
    const currencyOutcome = await purchase.fulfilPartnerCreditPurchase(wrongCurrency, "evt_wrong_currency_1");
    expect(currencyOutcome).toMatchObject({ granted: false, reason: "checkout_currency_mismatch" });
    expect(await availableFor(currencyTenant)).toBe(0);
  });

  it("refuses a verified checkout with the wrong charged total or exclusive tax behaviour", async () => {
    const amountTenant = await makeTenant("wrong-amount");
    const taxTenant = await makeTenant("wrong-tax");
    await configureCanonicalPack("PACK_25", "gbp");
    await recordCheckoutIntent(amountTenant, "PACK_25", "cs_wrong_amount");
    await recordCheckoutIntent(taxTenant, "PACK_25", "cs_wrong_tax");

    const amountOutcome = await purchase.fulfilPartnerCreditPurchase(
      { ...session(amountTenant, "PACK_25", "cs_wrong_amount"), amountTotal: 20000 },
      "evt_wrong_amount_1"
    );
    expect(amountOutcome).toMatchObject({ granted: false, reason: "checkout_amount_mismatch" });
    expect(await availableFor(amountTenant)).toBe(0);

    const taxOutcome = await purchase.fulfilPartnerCreditPurchase(
      {
        ...session(taxTenant, "PACK_25", "cs_wrong_tax"),
        lineItems: [{ priceId: "price_test_pack_25", currency: "gbp", unitAmount: 25000, taxBehavior: "exclusive" }],
      },
      "evt_wrong_tax_1"
    );
    expect(taxOutcome).toMatchObject({ granted: false, reason: "checkout_tax_behavior_mismatch" });
    expect(await availableFor(taxTenant)).toBe(0);
  });

  it("a failed grant transaction leaves Checkout provenance retryable", async () => {
    const tenantId = await makeTenant("retryable-transaction");
    await configureCanonicalPack("PACK_5");
    const checkout = await verifiedSession(tenantId, "PACK_5", "cs_retryable_transaction");

    await admin.query(`UPDATE partner_wallets SET status='suspended' WHERE tenant_id=$1`, [tenantId]);
    await expect(purchase.fulfilPartnerCreditPurchase(checkout, "evt_retryable_transaction")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await availableFor(tenantId)).toBe(0);
    const blocked = await admin.query<{ status: string; granted_event_id: string | null; ledger: string }>(
      `SELECT s.status, s.granted_event_id,
              (SELECT count(*) FROM partner_credit_ledger WHERE tenant_id=$2)::text AS ledger
         FROM partner_credit_checkout_sessions s
        WHERE s.stripe_session_id=$1`,
      ["cs_retryable_transaction", tenantId]
    );
    expect(blocked.rows[0]).toEqual({ status: "created", granted_event_id: null, ledger: "0" });

    await admin.query(`UPDATE partner_wallets SET status='active' WHERE tenant_id=$1`, [tenantId]);
    const retry = await purchase.fulfilPartnerCreditPurchase(checkout, "evt_retryable_transaction");
    expect(retry).toMatchObject({ granted: true, credits: 5 });
    expect(await availableFor(tenantId)).toBe(5);
  });

  it("refuses a verified Checkout Session from the wrong Stripe environment", async () => {
    const tenantId = await makeTenant("wrong-environment");
    await configureCanonicalPack("PACK_50");
    const out = await purchase.fulfilPartnerCreditPurchase(
      { ...session(tenantId, "PACK_50", "cs_live_in_test"), livemode: true },
      "evt_wrong_environment_1"
    );
    expect(out).toMatchObject({ granted: false, reason: "checkout_environment_mismatch" });
    expect(await availableFor(tenantId)).toBe(0);
  });

  it("fails closed when this deployment has not declared its Stripe mode", async () => {
    const tenantId = await makeTenant("undeclared-environment");
    await configureCanonicalPack("PACK_100");
    const prior = process.env.STRIPE_ENV;
    delete process.env.STRIPE_ENV;
    try {
      const out = await purchase.fulfilPartnerCreditPurchase(
        session(tenantId, "PACK_100", "cs_undeclared_environment"),
        "evt_undeclared_environment_1"
      );
      expect(out).toMatchObject({ granted: false, reason: "stripe_environment_undeclared" });
      expect(await availableFor(tenantId)).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.STRIPE_ENV;
      else process.env.STRIPE_ENV = prior;
    }
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
    expect(purchase.canPurchaseCredits("MVGS_ASSESSMENT_TECHNICIAN", granted)).toBe(false);
  });

  it("a refund is recorded as an audited exception and does NOT reduce capacity", async () => {
    const tenantId = await makeTenant("refund");
    await configureCanonicalPack("PACK_25");
    await purchase.fulfilPartnerCreditPurchase(
      await verifiedSession(tenantId, "PACK_25", "cs_refund"),
      "evt_refund_grant"
    );
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

  it("re-reads Stripe's Checkout Session before the proven grant, and NEVER pre-claims it", () => {
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
    expect(branch).toContain("stripe.checkout.sessions.retrieve");
    expect(branch).toContain('expand: ["line_items.data.price"]');
    expect(branch).toContain("verifiedCheckout: true");
    expect(branch).toContain("livemode: verifiedSession.livemode");
    expect(branch).toContain("currency: verifiedSession.currency");
    expect(branch).toContain("amountTotal: verifiedSession.amount_total");
    expect(branch).toContain("unitAmount: price?.unit_amount");
    expect(branch).toContain("taxBehavior: price?.tax_behavior");
    expect(routes).toContain("stripe.prices.retrieve");
    expect(routes).toContain("validateStripePriceForCheckout");
    expect(routes).toContain("unitAmount:");
    expect(routes).toContain("taxBehavior:");
    expect(routes).toContain("recordPartnerCreditCheckoutIntent");
    const service = read("server/partner/credit-purchase-service.ts");
    expect(service).toContain("loadPartnerCreditCheckoutIntent");
    expect(service).toContain("withPartnerAdminTransaction");
    expect(service).toContain("FOR UPDATE");
    expect(service).toContain("appendFoundationCreditWithClient");
    expect(service).toContain("STRIPE_AMOUNT_MISMATCH");
    expect(service).toContain("STRIPE_TAX_BEHAVIOR_MISMATCH");
    expect(service).toContain("checkout_amount_mismatch");
    expect(service).toContain("checkout_tax_behavior_mismatch");
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

  it("checkout refuses missing or mismatched Stripe environment before returning a session", () => {
    expect(routes).toContain('code === "STRIPE_ENV_UNDECLARED" || code === "STRIPE_ENV_MISMATCH"');
    const service = read("server/partner/credit-purchase-service.ts");
    expect(service).toContain("checkoutStripeEnvironmentStatus");
    expect(service).toContain("stripe_environment_undeclared");
    expect(service).toContain("stripe_environment_mismatch");
    expect(service).toContain('appName === "mintvault-v2"');
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
