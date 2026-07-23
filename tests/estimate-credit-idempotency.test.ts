/**
 * PKG-2 — Stripe estimate-credit idempotency & fulfilment integrity.
 *
 * Exercises the exported fulfilment surface `fulfilEstimateCreditsPurchase`
 * (server/webhookHandlers.ts) end-to-end against a REAL, disposable PostgreSQL
 * 17.10 cluster using the production SQL and the production `stripe_webhook_events`
 * ledger. The function accepts an injected transaction-capable executor purely so
 * these tests can drive a local cluster (no SSL); production callers (the Stripe
 * webhook) pass nothing and use the real `db`. No runtime behaviour is changed by
 * the injection.
 *
 * Invariants proven here:
 *  - one paid purchase grants exactly the intended credits once;
 *  - a redelivered / replayed Stripe event id never double-grants;
 *  - two concurrent deliveries of the same event grant exactly once;
 *  - an unpaid session, or malformed metadata, grants nothing (fail closed);
 *  - a mid-grant failure rolls back atomically (claim released) so a later retry
 *    re-fulfils exactly once — no claim-then-crash credit loss;
 *  - the logged-in (user_id) path credits only that user's balance;
 *  - separate purchases (distinct event ids) each grant their own credits once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

// The webhook module transitively imports the email + pdf-token modules (via the
// grading fulfilment path). Stub them so importing needs no signing secrets and
// never sends mail. fulfilEstimateCreditsPurchase itself touches neither.
vi.mock("../server/email", () => ({
  sendSubmissionConfirmation: vi.fn(async () => {}),
  sendSubmissionConfirmationV2: vi.fn(async () => {}),
  sendVaultClubWelcomeEmail: vi.fn(async () => {}),
  sendVaultClubCancelledEmail: vi.fn(async () => {}),
  sendVaultClubPaymentFailedEmail: vi.fn(async () => {}),
}));
vi.mock("../server/lib/pdf-token", () => ({
  generatePdfToken: vi.fn(() => "test-token"),
  verifyPdfToken: vi.fn(() => true),
}));

let cluster: DisposablePostgres17;
let admin: pg.Client;
let pool: pg.Pool;
let testDb: ReturnType<typeof drizzle>;
let webhooks: typeof import("../server/webhookHandlers");

let evtSeq = 0;
function nextEventId(): string {
  evtSeq += 1;
  return `evt_test_${evtSeq}`;
}

/** Build a minimal Checkout Session as the webhook would see it. */
function session(opts: {
  email?: string;
  userId?: string;
  credits?: string | number;
  paymentStatus?: string;
  id?: string;
  type?: string;
}) {
  const metadata: Record<string, string> = { type: opts.type ?? "estimate_credits" };
  if (opts.email !== undefined) metadata.email = opts.email;
  if (opts.userId !== undefined) metadata.user_id = opts.userId;
  if (opts.credits !== undefined) metadata.credits = String(opts.credits);
  return {
    id: opts.id ?? "cs_test_1",
    payment_status: opts.paymentStatus ?? "paid",
    metadata,
  };
}

async function emailCredits(email: string): Promise<{ remaining: number; purchased: number; used: number } | null> {
  const r = await pool.query(
    `SELECT credits_remaining, credits_purchased, credits_used FROM estimate_credits WHERE email=$1`,
    [email.toLowerCase()]
  );
  if (r.rowCount === 0) return null;
  return {
    remaining: r.rows[0].credits_remaining,
    purchased: r.rows[0].credits_purchased,
    used: r.rows[0].credits_used,
  };
}

async function userBalance(id: string): Promise<number | null> {
  const r = await pool.query(`SELECT ai_credits_user_balance FROM users WHERE id=$1`, [id]);
  return r.rowCount === 0 ? null : r.rows[0].ai_credits_user_balance;
}

async function eventCount(eventId: string): Promise<number> {
  const r = await pool.query(`SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id=$1`, [eventId]);
  return r.rowCount ?? 0;
}

describe("PKG-2 estimate-credit idempotency (PostgreSQL 17.10)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("pkg2-estimate-credit-idempotency");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();

    // Production DDL (mirrors seedEstimateCreditsTable + migratePaymentIdempotencySchema).
    await admin.query(`
      CREATE TABLE estimate_credits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        credits_remaining INTEGER NOT NULL DEFAULT 0,
        credits_purchased INTEGER NOT NULL DEFAULT 0,
        credits_used INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`);
    await admin.query(`
      CREATE TABLE stripe_webhook_events (
        stripe_event_id TEXT PRIMARY KEY,
        event_type TEXT,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await admin.query(`
      CREATE TABLE users (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar UNIQUE,
        ai_credits_user_balance INTEGER NOT NULL DEFAULT 0
      )`);

    pool = new pg.Pool({ connectionString: cluster.url, max: 6 });
    testDb = drizzle(pool);

    // The module reads MINTVAULT_DATABASE_URL at import; point it at the cluster so
    // the (unused, injected-over) default db pool constructs without throwing.
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    webhooks = await import("../server/webhookHandlers");
  }, 90_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await admin.query(`TRUNCATE estimate_credits, stripe_webhook_events, users RESTART IDENTITY CASCADE`);
  });

  const fulfil = (eventId: string, s: ReturnType<typeof session>) =>
    webhooks.fulfilEstimateCreditsPurchase(eventId, "checkout.session.completed", s, { exec: testDb as any });

  // 1 — successful purchase grants exactly the intended credits once.
  it("grants exactly the purchased credits once for a paid session", async () => {
    const evt = nextEventId();
    const res = await fulfil(evt, session({ email: "buyer@example.com", credits: 15 }));
    expect(res.granted).toBe(true);
    expect(await emailCredits("buyer@example.com")).toEqual({ remaining: 15, purchased: 15, used: 0 });
    expect(await eventCount(evt)).toBe(1);
  });

  // 2 — webhook replay: the SAME event delivered twice grants only once.
  it("does not double-grant when the same event id is redelivered", async () => {
    const evt = nextEventId();
    const s = session({ email: "buyer@example.com", credits: 15 });
    const first = await fulfil(evt, s);
    const second = await fulfil(evt, s);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
    expect(second.reason).toBe("duplicate_event");
    expect((await emailCredits("buyer@example.com"))!.remaining).toBe(15); // not 30
  });

  // 3 — concurrent fulfilment: two simultaneous deliveries of the same event
  //     (e.g. dual webhook endpoints during a DNS cutover) grant exactly once.
  it("grants exactly once under two concurrent deliveries of the same event", async () => {
    const evt = nextEventId();
    const s = session({ email: "buyer@example.com", credits: 100 });
    const [a, b] = await Promise.all([fulfil(evt, s), fulfil(evt, s)]);
    const granted = [a, b].filter((r) => r.granted).length;
    expect(granted).toBe(1);
    expect((await emailCredits("buyer@example.com"))!.remaining).toBe(100); // never 200
    expect(await eventCount(evt)).toBe(1);
  });

  // 6 — logged-in purchase credits ONLY the bound user; a different account is
  //     never touched. Owner comes from server-set metadata, not the credited email.
  it("credits only the bound user_id on the logged-in path (no cross-account grant)", async () => {
    const a = (await pool.query(`INSERT INTO users (email) VALUES ('a@x.com') RETURNING id`)).rows[0].id as string;
    const b = (await pool.query(`INSERT INTO users (email) VALUES ('b@x.com') RETURNING id`)).rows[0].id as string;
    const res = await fulfil(nextEventId(), session({ email: "a@x.com", userId: a, credits: 5 }));
    expect(res.granted).toBe(true);
    expect(await userBalance(a)).toBe(5);
    expect(await userBalance(b)).toBe(0);
    expect(await emailCredits("a@x.com")).toBeNull(); // user path does not write the email table
  });

  // 9 — unpaid session grants nothing (fail closed on payment_status).
  it("grants nothing for a session that is not paid", async () => {
    const evt = nextEventId();
    const res = await fulfil(evt, session({ email: "buyer@example.com", credits: 15, paymentStatus: "unpaid" }));
    expect(res.granted).toBe(false);
    expect(res.reason).toBe("not_paid");
    expect(await emailCredits("buyer@example.com")).toBeNull();
    expect(await eventCount(evt)).toBe(0); // no event burned for an unpaid session
  });

  // 8 & 10 — malformed / incomplete metadata grants nothing (safe rejection).
  it.each([
    { label: "missing credits", opts: { email: "b@x.com" } },
    { label: "zero credits", opts: { email: "b@x.com", credits: 0 } },
    { label: "negative credits", opts: { email: "b@x.com", credits: -5 } },
    { label: "non-numeric credits", opts: { email: "b@x.com", credits: "abc" } },
    { label: "no owner (no email, no user_id)", opts: { credits: 5 } },
  ])("grants nothing for malformed metadata: $label", async ({ opts }) => {
    const evt = nextEventId();
    const res = await fulfil(evt, session(opts as any));
    expect(res.granted).toBe(false);
    expect(res.reason).toBe("malformed_metadata");
    expect(await eventCount(evt)).toBe(0);
  });

  // 11 — partial failure rolls back atomically: a mid-grant error must release the
  //      event claim, so no credit is granted AND the event is not recorded.
  it("rolls back the event claim when the grant fails (no claim-then-crash loss)", async () => {
    const evt = nextEventId();
    // Executor whose transaction runs on the REAL cluster but throws on the 2nd
    // statement (the grant) after the 1st (the claim) has run inside the tx.
    const failingRunner = {
      transaction: (cb: any) =>
        testDb.transaction(async (tx) => {
          let calls = 0;
          const proxy = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop === "execute") {
                return (...args: any[]) => {
                  calls += 1;
                  if (calls >= 2) throw new Error("simulated grant failure");
                  return (target as any).execute(...args);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return cb(proxy);
        }),
    };
    await expect(
      webhooks.fulfilEstimateCreditsPurchase(
        evt,
        "checkout.session.completed",
        session({ email: "buyer@example.com", credits: 15 }),
        { exec: failingRunner as any }
      )
    ).rejects.toThrow(/simulated grant failure/);

    // Rolled back: no credit, and the event id was NOT recorded.
    expect(await emailCredits("buyer@example.com")).toBeNull();
    expect(await eventCount(evt)).toBe(0);

    // 12 — retry after the partial failure re-fulfils exactly once.
    const retry = await fulfil(evt, session({ email: "buyer@example.com", credits: 15 }));
    expect(retry.granted).toBe(true);
    expect((await emailCredits("buyer@example.com"))!.remaining).toBe(15);
    expect(await eventCount(evt)).toBe(1);
  });

  // 15 — separate purchases (distinct event ids) each grant their own credits once.
  it("keeps separate purchases independent (distinct event ids each grant once)", async () => {
    const r1 = await fulfil(nextEventId(), session({ email: "one@x.com", credits: 5, id: "cs_1" }));
    const r2 = await fulfil(nextEventId(), session({ email: "two@x.com", credits: 15, id: "cs_2" }));
    // Same buyer, second genuine purchase = a different event id → accumulates.
    const r3 = await fulfil(nextEventId(), session({ email: "one@x.com", credits: 100, id: "cs_3" }));
    expect([r1.granted, r2.granted, r3.granted]).toEqual([true, true, true]);
    expect((await emailCredits("one@x.com"))!.remaining).toBe(105);
    expect((await emailCredits("two@x.com"))!.remaining).toBe(15);
  });

  // 4, 5, 13 documented: estimate fulfilment is webhook-ONLY (no manual-confirm
  // endpoint → no manual/webhook race), a single checkout emits one
  // checkout.session.completed keyed by its unique event id (the sibling
  // payment_intent.succeeded event finds no submission and never reaches estimate
  // credit code), and NO refund/restoration logic exists for estimate credits
  // (charge.refunded is unhandled) — so a refund-replay double-reverse is not
  // reachable. These invariants are structural (verified by review), not
  // exercised here because there is no code surface to drive.
});
