/** Pricing contract against a newly owned PostgreSQL cluster, never configured databases. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const provider = vi.hoisted(() => ({
  intents: [] as Array<{
    id: string;
    client_secret: string;
    status: string;
    amount: number;
    currency: string;
    metadata: Record<string, string>;
  }>,
  emails: [] as Array<{ total: number; submissionId: string }>,
}));
vi.mock("../server/stripeClient", () => ({
  getUncachableStripeClient: async () => ({
    paymentIntents: {
      create: async (input: { amount: number; currency: string; metadata: Record<string, string> }) => {
        const id = `pi_pricing_local_${provider.intents.length + 1}`;
        const intent = {
          ...structuredClone(input),
          id,
          client_secret: `${id}_secret_local`,
          status: "requires_payment_method",
        };
        provider.intents.push(intent);
        return intent;
      },
      retrieve: async (id: string) => {
        const intent = provider.intents.find((value) => value.id === id);
        if (!intent) throw new Error("Unknown synthetic PaymentIntent");
        return structuredClone(intent);
      },
    },
  }),
}));
vi.mock("../server/email", () => {
  const send = async (payload: { total: number; submissionId: string }) => {
    provider.emails.push(structuredClone(payload));
    return { id: `email_pricing_local_${provider.emails.length}` };
  };
  return { sendSubmissionConfirmation: send, sendSubmissionConfirmationV2: send };
});
// Optional analytics is not payment authority; no external publication in this fixture.
vi.mock("../server/commercial-attribution", () => ({ recordSubmissionAttribution: async () => {} }));
vi.mock("../server/growth-conversion-service", () => ({ recordGrowthConversionEvent: async () => {} }));
const PASSWORD = "synthetic-pricing-password-only";
const PIN = "735291";

let cluster: DisposablePostgres17;
let client: Client;
let server: Server;
let base: string;
let storage: typeof import("../server/storage").storage;
let closePool: (() => Promise<void>) | undefined;
beforeAll(async () => {
  cluster = await startPostgres17("pricing-contract");
  // This mandatory app alias is generated HERE, after env -i and owned cluster creation.
  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  process.env.TEST_DATABASE_URL = cluster.url;
  process.env.SESSION_SECRET = "synthetic-pricing-session-only";
  process.env.SIGNED_URL_SECRET = "synthetic-pricing-document-token-only";
  client = new Client({ connectionString: cluster.url });
  await client.connect();
  await client.query(`
    CREATE TABLE service_tiers (
      id serial PRIMARY KEY, service_type text NOT NULL, tier_id text NOT NULL, name text NOT NULL,
      price_per_card integer NOT NULL, turnaround_days integer NOT NULL, turnaround_label text,
      max_value_gbp integer NOT NULL, features text[] DEFAULT '{}', is_active boolean DEFAULT true,
      sort_order integer DEFAULT 0, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
    );
    CREATE TABLE tier_capacity (tier_id text, status text, paused_until timestamp, paused_message text,
      tier_slug text, max_active integer DEFAULT 99999, force_open boolean DEFAULT false);
    INSERT INTO service_tiers (service_type,tier_id,name,price_per_card,turnaround_days,turnaround_label,max_value_gbp,is_active,sort_order) VALUES
    ('grading','standard','Current grading',3729,17,'17 working days',4500,true,1),
    ('grading','inactive','Retired grading',1111,2,'2 working days',999,false,2),
    ('reholder','reholder','Other service',4567,9,'Special current label',2000,true,1);
    INSERT INTO tier_capacity (tier_id,status,paused_message,tier_slug) VALUES ('standard','paused','Test capacity pause','standard');
  `);
  // Bounded existing runtime-login and payment-retry fixture shapes. No full-schema push.
  await client.query(`
    CREATE TABLE users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text, email varchar UNIQUE, first_name varchar, last_name varchar,
      profile_image_url varchar, role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
      password_hash text, display_name text, email_verified boolean NOT NULL DEFAULT false,
      email_verified_at timestamp, last_login_at timestamp, last_login_ip text,
      failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp, last_failed_login_at timestamp,
      credential_version integer NOT NULL DEFAULT 1, admin_passphrase_hash text, pin_hash text,
      pin_set_at timestamp, pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp,
      public_name boolean NOT NULL DEFAULT false, can_grade boolean NOT NULL DEFAULT false,
      can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
      can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100,
      password_failed_count integer NOT NULL DEFAULT 0, password_locked_until timestamp,
      vault_club_tier text, vault_club_status text
    );
    CREATE TABLE audit_log (id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL,
      action text NOT NULL, admin_user text, details jsonb, created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE pin_attempts (id serial PRIMARY KEY, email text, success boolean, reason text, ip_hash text,
      attempted_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE submissions (
      id serial PRIMARY KEY, tracking_number text UNIQUE NOT NULL, user_id text,
      status text NOT NULL DEFAULT 'draft', card_count integer, total_price numeric(10,2), total_declared_value numeric,
      payment_intent_id text UNIQUE, payment_status text NOT NULL DEFAULT 'unpaid', payment_currency text,
      payment_amount numeric(10,2), payment_timestamp timestamptz, customer_email text, customer_first_name text,
      customer_last_name text, phone text, return_address_line1 text, return_address_line2 text, return_city text,
      return_county text, return_postcode text, service_type text, service_tier text, turnaround_days integer,
      shipping_cost integer, shipping_insurance_tier text, grading_cost integer, notes text,
      price_per_card_at_purchase integer, insurance_fee integer, insurance_surcharge_per_card integer,
      liability_accepted boolean, liability_accepted_at timestamptz, liability_accepted_ip text,
      high_value_flag boolean, requires_manual_approval boolean, terms_accepted boolean, terms_accepted_at timestamptz,
      terms_version text, crossover_company text, crossover_original_grade text, crossover_cert_number text,
      reholder_company text, reholder_reason text, reholder_condition text, auth_reason text, auth_concerns text,
      reveal_wrap boolean, marketing_feature_consent boolean, marketing_feature_consent_at timestamptz,
      estimated_completion_date timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL REFERENCES submissions(id),
      card_index integer NOT NULL DEFAULT 0, game text, card_set text, card_name text, card_number text, year text,
      declared_value integer DEFAULT 0, declared_new boolean DEFAULT false, notes text, created_at timestamp DEFAULT now());
    CREATE TABLE promotions (id serial PRIMARY KEY, name text, banner_text text, standard_pct integer,
      priority_pct integer, express_pct integer, stacking_mode text DEFAULT 'best_of', active boolean,
      expires_at timestamptz, deleted_at timestamptz);
    CREATE TABLE promo_codes (id serial PRIMARY KEY, code text UNIQUE NOT NULL, percent integer NOT NULL,
      active boolean DEFAULT true, uses_count integer NOT NULL DEFAULT 0, max_uses integer, expires_at timestamptz,
      deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE member_credits (id serial PRIMARY KEY, user_id text NOT NULL, credit_type text NOT NULL,
      expires_at timestamptz, used_at timestamptz, used_for_submission_id integer, reserved_at timestamptz,
      reserved_until timestamptz, reserved_for_tracking_number text);
  `);
  await client.query(
    readFileSync(new URL("../migrations/0117_grading_payment_fulfilment_outbox.sql", import.meta.url), "utf8")
  );
  await client.query(
    `INSERT INTO users (id,email,role,admin_passphrase_hash,pin_hash) VALUES ('pricing-admin','mintvaultuk@gmail.com','admin',$1,$2);
    `,
    [await bcrypt.hash(PASSWORD, 12), await bcrypt.hash(PIN, 12)]
  );
  await client.query(
    "INSERT INTO users (id,email,first_name,last_name) VALUES ('pricing-customer','pricing-customer@example.test','Pricing','Fixture')"
  );
  storage = (await import("../server/storage")).storage;
  const { pool } = await import("../server/db");
  closePool = () => pool.end();
  const { registerPublicRoutes } = await import("../server/routes/public");
  const { registerAuthRoutes } = await import("../server/routes/auth");
  const { registerAdminConfigRoutes } = await import("../server/routes/admin-config");
  const { registerSubmissionRoutes } = await import("../server/routes/submissions");
  const app = express();
  app.use(express.json());
  app.use(
    session({
      name: "mv.sid",
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: false, sameSite: "lax" },
    })
  );
  registerAuthRoutes(app);
  registerAdminConfigRoutes(app);
  registerPublicRoutes(app);
  registerSubmissionRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  await closePool?.();
  await client?.end();
  await cluster?.stop();
});

describe("Admin HTTP → current quote → provider-double charge → durable receipt", () => {
  async function json(path: string, method = "GET", body?: unknown, cookie?: string) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { response, body: await response.json() };
  }
  function cookieOf(response: Response) {
    const cookie = response.headers.get("set-cookie")?.match(/mv\.sid=[^;]+/)?.[0];
    expect(cookie).toBeTruthy();
    return cookie!;
  }
  const checkout = {
    type: "grading",
    tier: "standard",
    quantity: 1,
    declaredValue: 100,
    email: "pricing-customer@example.test",
    firstName: "Pricing",
    lastName: "Fixture",
    shippingAddress: { line1: "1 Synthetic Road", city: "Test City", postcode: "TE1 1ST" },
    termsAccepted: true,
    liabilityAccepted: true,
    // None of these client fields is authoritative.
    pricePerCard: 1,
    total: 1,
    amount: 1,
    discountPercent: 99,
    submissionId: "CLIENT-CHOICE",
  };

  it("propagates prices and promotions while retaining purchased amounts and turnaround promises", async () => {
    const login = await json("/api/admin/login", "POST", { password: PASSWORD });
    expect(login.body).toEqual({ step: "PIN_REQUIRED" });
    const pin = await json("/api/admin/pin", "POST", { pin: PIN }, cookieOf(login.response));
    expect(pin.body).toEqual({ success: true });
    const cookie = cookieOf(pin.response);
    await client.query("UPDATE tier_capacity SET status='open',paused_message=NULL");
    const tier = (await storage.getServiceTiers("grading"))[0];
    const update = async (values: Record<string, unknown>) => {
      const result = await json(`/api/admin/service-tiers/${tier.id}`, "PUT", values, cookie);
      expect(result.response.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject(values);
      return result.body;
    };
    const publicTier = async (price: number, days: number) => {
      const result = await json("/api/service-tiers");
      expect(result.response.headers.get("cache-control")).toContain("no-store");
      expect(result.body).toHaveLength(1);
      expect(result.body[0]).toMatchObject({
        id: "standard",
        pricePerCard: price,
        turnaroundDays: days,
        turnaround: `${days} working days`,
        capacityStatus: "open",
      });
    };
    const purchase = async (price: number, days: number, discount: number) => {
      const quote = await json("/api/grading/quote", "POST", checkout);
      expect(quote.response.status).toBe(200);
      expect(quote.body).toMatchObject({
        pricePerCard: price,
        subtotalPence: price,
        promoPercent: discount,
        effectiveDiscountAmount: Math.round((price * discount) / 100),
      });
      const count = provider.intents.length;
      const charge = await json("/api/create-payment-intent", "POST", checkout);
      expect(charge.response.status, JSON.stringify(charge.body)).toBe(200);
      expect(provider.intents).toHaveLength(count + 1);
      const intent = provider.intents.at(-1)!;
      expect(charge.body.total).toBe(quote.body.total);
      expect(intent).toMatchObject({
        amount: quote.body.total,
        currency: "gbp",
        metadata: {
          tier: "standard",
          quantity: "1",
          submissionId: charge.body.submissionId,
          promoPercent: String(discount),
        },
      });
      expect(charge.body.submissionId).not.toBe(checkout.submissionId);
      const row = (await client.query("SELECT * FROM submissions WHERE tracking_number=$1", [charge.body.submissionId]))
        .rows[0];
      expect(row).toMatchObject({
        payment_status: "unpaid",
        price_per_card_at_purchase: price,
        turnaround_days: days,
        total_price: (intent.amount / 100).toFixed(2),
        payment_intent_id: intent.id,
        grading_cost: quote.body.discountedSubtotal,
        shipping_cost: quote.body.shipping,
        insurance_fee: quote.body.totalInsuranceFee,
      });
      expect(
        (await client.query("SELECT count(*)::int n FROM submission_items WHERE submission_id=$1", [row.id])).rows[0].n
      ).toBe(1);
      return { intent, row, tracking: charge.body.submissionId as string };
    };
    const snapshot = async (id: number) =>
      (
        await client.query(
          `SELECT price_per_card_at_purchase,total_price,grading_cost,turnaround_days,shipping_cost,insurance_fee,
        service_tier,payment_intent_id,payment_amount,payment_status,payment_timestamp,estimated_completion_date
       FROM submissions WHERE id=$1`,
          [id]
        )
      ).rows[0];
    const confirm = async (order: Awaited<ReturnType<typeof purchase>>) => {
      order.intent.status = "succeeded";
      const result = await json("/api/confirm-payment", "POST", {
        submissionId: order.tracking,
        paymentIntentId: order.intent.id,
      });
      expect(result.body).toMatchObject({ success: true, status: "paid" });
      const receipts = (
        await client.query("SELECT * FROM grading_payment_fulfilments WHERE submission_id=$1", [order.row.id])
      ).rows;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ amount_pence: order.intent.amount, status: "COMPLETE", currency: "GBP" });
      expect(receipts[0].confirmation_payload.emailData.total).toBe(order.intent.amount);
      const success = await json(
        `/api/submissions/${order.tracking}/success?token=${encodeURIComponent(result.body.packingSlipToken)}`
      );
      expect(success.body).toMatchObject({
        status: "paid",
        totalPrice: order.row.total_price,
        serviceTier: "standard",
        cardCount: 1,
      });
      expect(success.response.headers.get("cache-control")).toContain("no-store");
      const paid = await snapshot(order.row.id);
      expect(paid).toMatchObject({ payment_status: "paid", payment_amount: order.row.total_price });
      const expected = new Date(receipts[0].paid_at);
      for (let days = 0; days < order.row.turnaround_days;) {
        expected.setUTCDate(expected.getUTCDate() + 1);
        if (![0, 6].includes(expected.getUTCDay())) days++;
      }
      expect(paid.estimated_completion_date).toEqual(expected);
      return { paid, receipt: receipts[0] };
    };

    await update({ pricePerCard: 4137, turnaroundDays: 23 });
    await publicTier(4137, 23);
    expect((await json("/api/promotions/active")).body).toEqual({ promo: null });
    const oldPaidOrder = await purchase(4137, 23, 0);
    const oldInflight = await purchase(4137, 23, 0);
    const oldPaid = await confirm(oldPaidOrder);
    const inflightSnapshot = await snapshot(oldInflight.row.id);
    await update({ pricePerCard: 5873, turnaroundDays: 31 });
    await publicTier(5873, 31);
    await client.query(
      "INSERT INTO promotions (name,banner_text,standard_pct,priority_pct,express_pct,active) VALUES ('Synthetic','Synthetic promo',17,0,0,true)"
    );
    const promo = await json("/api/promotions/active");
    expect(promo.response.headers.get("cache-control")).toContain("no-store");
    expect(promo.body.promo.tiers.standard).toEqual({ pct: 17, originalPrice: 5873, discountedPrice: 4875 });
    const current = await purchase(5873, 31, 17);
    await confirm(current);
    expect(await snapshot(oldPaidOrder.row.id)).toEqual(oldPaid.paid);
    expect(await snapshot(oldInflight.row.id)).toEqual(inflightSnapshot);
    // The earlier in-flight order settles after the edit using its purchased promise.
    await confirm(oldInflight);
    const emails = provider.emails.length;
    await confirm(oldPaidOrder);
    expect(provider.emails).toHaveLength(emails);
    expect(
      (await client.query("SELECT * FROM grading_payment_fulfilments WHERE submission_id=$1", [oldPaidOrder.row.id]))
        .rows[0]
    ).toEqual(oldPaid.receipt);
    await client.query("UPDATE promotions SET active=false");
    expect((await json("/api/promotions/active")).body).toEqual({ promo: null });
    expect((await json("/api/grading/quote", "POST", checkout)).body).toMatchObject({
      pricePerCard: 5873,
      promoApplied: false,
      promoPercent: 0,
    });
    await update({ isActive: false });
    expect((await json("/api/service-tiers")).body).toEqual([]);
    const creates = provider.intents.length;
    expect((await json("/api/grading/quote", "POST", checkout)).response.status).toBe(400);
    expect((await json("/api/create-payment-intent", "POST", checkout)).response.status).toBe(400);
    expect(provider.intents).toHaveLength(creates);
    expect((await client.query("SELECT count(*)::int n FROM submissions")).rows[0].n).toBe(creates);
    const audits = (
      await client.query(
        "SELECT admin_user,details FROM audit_log WHERE entity_type='service_tier' AND entity_id=$1 ORDER BY id",
        [String(tier.id)]
      )
    ).rows;
    expect(audits).toEqual([
      { admin_user: "mintvaultuk@gmail.com", details: { pricePerCard: 4137, turnaroundDays: 23 } },
      { admin_user: "mintvaultuk@gmail.com", details: { pricePerCard: 5873, turnaroundDays: 31 } },
      { admin_user: "mintvaultuk@gmail.com", details: { isActive: false } },
    ]);
  }, 60_000);

  it("snapshots numeric turnaround for an other-service tier with a custom display label", async () => {
    const result = await json("/api/create-payment-intent", "POST", {
      ...checkout,
      type: "reholder",
      tier: "reholder",
      reholderCompany: "MintVault",
      reholderReason: "Synthetic repair",
    });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    const row = (await client.query("SELECT * FROM submissions WHERE tracking_number=$1", [result.body.submissionId]))
      .rows[0];
    expect(row).toMatchObject({ turnaround_days: 9, price_per_card_at_purchase: 4567 });
    await client.query("UPDATE service_tiers SET turnaround_days=31 WHERE service_type='reholder'");
    const intent = provider.intents.at(-1)!;
    intent.status = "succeeded";
    const confirmation = await json("/api/confirm-payment", "POST", {
      submissionId: result.body.submissionId,
      paymentIntentId: intent.id,
    });
    expect(confirmation.body).toMatchObject({ success: true, status: "paid" });
    const receipt = (await client.query("SELECT * FROM grading_payment_fulfilments WHERE submission_id=$1", [row.id]))
      .rows[0];
    const expected = new Date(receipt.paid_at);
    for (let added = 0; added < 9;) {
      expected.setUTCDate(expected.getUTCDate() + 1);
      if (![0, 6].includes(expected.getUTCDay())) added++;
    }
    const paid = (await client.query("SELECT * FROM submissions WHERE id=$1", [row.id])).rows[0];
    expect(paid.estimated_completion_date).toEqual(expected);
    const { fulfilPaidSubmission } = await import("../server/routes/submissions");
    await fulfilPaidSubmission(
      await storage.getSubmissionBySubmissionId(result.body.submissionId),
      intent.metadata,
      intent.amount,
      {},
      { currency: intent.currency, paidAt: new Date(), paymentIntentId: intent.id }
    );
    expect((await client.query("SELECT * FROM submissions WHERE id=$1", [row.id])).rows[0]).toEqual(paid);
    expect(
      (await client.query("SELECT * FROM grading_payment_fulfilments WHERE submission_id=$1", [row.id])).rows[0]
    ).toEqual(receipt);
  });

  it("does not invent a legacy turnaround when a persisted purchase snapshot is invalid", async () => {
    await client.query(`INSERT INTO submissions (tracking_number,payment_intent_id,turnaround_days,service_tier,
      service_type,customer_email,price_per_card_at_purchase,total_price,card_count)
      VALUES ('MV-SUB-INVALID-DAYS','pi_pricing_invalid_days',0,'standard','grading','pricing-customer@example.test',2500,32.50,1)`);
    const { fulfilPaidSubmission } = await import("../server/routes/submissions");
    const submission = await storage.getSubmissionBySubmissionId("MV-SUB-INVALID-DAYS");
    const emails = provider.emails.length;
    await fulfilPaidSubmission(
      submission,
      {},
      3250,
      {},
      {
        currency: "gbp",
        paidAt: new Date(),
        paymentIntentId: "pi_pricing_invalid_days",
      }
    );
    const row = (
      await client.query(
        "SELECT payment_status,estimated_completion_date FROM submissions WHERE tracking_number='MV-SUB-INVALID-DAYS'"
      )
    ).rows[0];
    expect(row).toEqual({ payment_status: "paid", estimated_completion_date: null });
    expect(
      (
        await client.query(
          "SELECT status,estimate_completed_at FROM grading_payment_fulfilments WHERE submission_id=$1",
          [submission.id]
        )
      ).rows[0]
    ).toEqual({ status: "RECONCILIATION_REQUIRED", estimate_completed_at: null });
    expect(provider.emails).toHaveLength(emails);
  });
});
describe("Live pricing SQL and public wire contract", () => {
  beforeEach(async () => {
    await client.query(
      "UPDATE service_tiers SET price_per_card=4567,turnaround_days=9,turnaround_label='Special current label' WHERE tier_id='reholder'"
    );
    await client.query(
      "UPDATE service_tiers SET is_active=true,price_per_card=3729,turnaround_days=17,turnaround_label='17 working days' WHERE tier_id='standard'"
    );
    await client.query(
      "UPDATE tier_capacity SET status='paused',paused_message='Test capacity pause' WHERE tier_id='standard'"
    );
  });
  it("returns the same camel-case record after a real update and refreshes changed turnaround", async () => {
    const tier = (await storage.getServiceTiers("grading"))[0];
    const updated = await storage.updateServiceTier(tier.id, { pricePerCard: 4137, turnaroundDays: 23 });
    expect(updated).toMatchObject({ id: tier.id, pricePerCard: 4137, turnaroundDays: 23 });
    const persisted = await storage.getServiceTier("grading", "standard");
    const { serviceTierToPricingTier } = await import("../shared/schema");
    expect(serviceTierToPricingTier(persisted!)).toMatchObject({ pricePerCard: 4137, turnaround: "23 working days" });
    const other = (await storage.getServiceTiers("reholder"))[0];
    await storage.updateServiceTier(other.id, { pricePerCard: 4568, turnaroundDays: other.turnaroundDays });
    expect((await storage.getServiceTier("reholder", "reholder"))!.turnaroundLabel).toBe("Special current label");
  });
  it("defaults to active grading only and exposes capacity without stale caching", async () => {
    const response = await fetch(`${base}/api/service-tiers`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "standard",
      serviceType: "grading",
      capacityStatus: "paused",
      capacityMessage: "Test capacity pause",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    const other = await fetch(`${base}/api/service-tiers?serviceType=reholder`).then((r) => r.json());
    expect(other).toHaveLength(1);
    expect(other[0].serviceType).toBe("reholder");
  });
  it("rejects malformed or unknown service selection without broadening the catalogue", async () => {
    for (const query of ["serviceType=unknown", "serviceType=grading&serviceType=reholder", "serviceType="]) {
      expect((await fetch(`${base}/api/service-tiers?${query}`)).status).toBe(400);
    }
  });
});
