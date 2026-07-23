/**
 * PKG-3 — estimate-credit consumption: owner binding + atomic decrement.
 *
 * Exercises the exported consumption surface (server/estimate-credit-consumption.ts)
 * end-to-end against a REAL, disposable PostgreSQL 17.10 cluster using the
 * production SQL (the same conditional UPDATEs the route runs). The executor is
 * injected purely so these tests can drive a local cluster (no SSL); production
 * callers pass nothing and use the real db + deductAiCredits. No runtime behaviour
 * is changed by the injection.
 *
 * The paid provider (Anthropic) is represented by a vi.fn() `provider` that is only
 * invoked when the consumption gate returns { ok: true } — exactly mirroring the
 * route, which calls Anthropic only after the database proves a credit was spent.
 * The provider is therefore never able to spend real tokens.
 *
 * Invariants proven here:
 *  A. authenticated owner binding — a caller-supplied email never spends another
 *     pool; a logged-in user with no owned credits fails without touching an
 *     email pool.
 *  B. legacy anonymous email consumption still works.
 *  C. checkout ownership is server-derived and cannot be overridden by the browser.
 *  D. zero rows affected → provider is not called.
 *  E. concurrency — one credit, two racers → exactly one spend, never negative.
 *  F. balance privacy — an authenticated caller sees only their own balance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

// storage/webhook modules transitively import email + pdf-token; stub so importing
// needs no signing secrets and never sends mail. The consumption surface uses neither.
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
let mod: typeof import("../server/estimate-credit-consumption");

/** The paid provider stand-in. Reset before each test. */
const provider = vi.fn(async () => ({ estimated_grade: 8 }));

/** Mirror the route gate: spend first, call the provider ONLY on { ok: true }. */
async function estimateWithGate(input: Parameters<typeof mod.consumeEstimateCredit>[0]) {
  const result = await mod.consumeEstimateCredit(input, { exec: testDb as any });
  if (result.ok) await provider();
  return result;
}

let userSeq = 0;
async function seedUser(aiCredits = 0): Promise<{ id: string; email: string }> {
  const email = `pkg3-user-${++userSeq}@example.test`;
  const r = await admin.query<{ id: string }>(
    `INSERT INTO users (email, ai_credits_user_balance) VALUES ($1, $2) RETURNING id`,
    [email, aiCredits]
  );
  return { id: r.rows[0].id, email };
}

/** Insert / upsert an email-keyed estimate_credits row, optionally owned by a user. */
async function seedEmailCredits(email: string, remaining: number, userId: string | null = null): Promise<void> {
  await admin.query(
    `INSERT INTO estimate_credits (email, credits_remaining, credits_purchased, credits_used, user_id)
       VALUES ($1, $2, $2, 0, $3)
     ON CONFLICT (email) DO UPDATE SET credits_remaining = EXCLUDED.credits_remaining, user_id = EXCLUDED.user_id`,
    [email.toLowerCase(), remaining, userId]
  );
}

async function emailRemaining(email: string): Promise<number | null> {
  const r = await pool.query(`SELECT credits_remaining FROM estimate_credits WHERE email=$1`, [email.toLowerCase()]);
  return r.rowCount === 0 ? null : r.rows[0].credits_remaining;
}
async function emailUsed(email: string): Promise<number | null> {
  const r = await pool.query(`SELECT credits_used FROM estimate_credits WHERE email=$1`, [email.toLowerCase()]);
  return r.rowCount === 0 ? null : r.rows[0].credits_used;
}
async function aiBalance(id: string): Promise<number | null> {
  const r = await pool.query(`SELECT ai_credits_user_balance FROM users WHERE id=$1`, [id]);
  return r.rowCount === 0 ? null : r.rows[0].ai_credits_user_balance;
}

describe("PKG-3 estimate-credit consumption owner binding (PostgreSQL 17.10)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("pkg3-estimate-credit-consumption");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();

    // Production DDL: users + estimate_credits (with the user_id column added
    // idempotently in server/account-auth.ts) + estimate_free_uses + audit_log.
    await admin.query(`
      CREATE TABLE users (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar UNIQUE,
        ai_credits_user_balance INTEGER NOT NULL DEFAULT 0,
        updated_at timestamptz DEFAULT NOW()
      )`);
    await admin.query(`
      CREATE TABLE estimate_credits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        credits_remaining INTEGER NOT NULL DEFAULT 0,
        credits_purchased INTEGER NOT NULL DEFAULT 0,
        credits_used INTEGER NOT NULL DEFAULT 0,
        user_id TEXT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`);
    await admin.query(`
      CREATE TABLE estimate_free_uses (
        ip_hash TEXT PRIMARY KEY,
        last_used_at TIMESTAMP NOT NULL,
        count_today INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await admin.query(`
      CREATE TABLE audit_log (
        id SERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        admin_user TEXT,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);

    pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
    testDb = drizzle(pool);

    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    mod = await import("../server/estimate-credit-consumption");
  }, 90_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await admin.query(`TRUNCATE estimate_credits, estimate_free_uses, audit_log RESTART IDENTITY`);
    await admin.query(`DELETE FROM users`);
    provider.mockClear();
  });

  // 1 — Authenticated owner binding: attacker (User A) submits the victim's email;
  //     the victim's estimate credits are never spent and no estimate is produced.
  it("(1) authenticated attacker cannot spend a victim's email credits", async () => {
    const attacker = await seedUser(0); // logged in, zero personal AI credits
    const victim = await seedUser(0);
    await seedEmailCredits(victim.email, 5); // victim's pre-account pool
    await seedEmailCredits("stranger@example.test", 5); // an arbitrary email pool

    const res = await estimateWithGate({
      sessionUserId: attacker.id,
      sessionUserEmail: attacker.email,
      bodyEmail: victim.email, // caller-supplied — must grant NO authority
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(402);
    expect(await emailRemaining(victim.email)).toBe(5); // untouched
    expect(await emailRemaining("stranger@example.test")).toBe(5); // untouched
    expect(provider).not.toHaveBeenCalled();
  });

  // 2 — Authenticated own-credit success: exactly one credit deducted, one estimate.
  it("(2) authenticated owner consumes exactly one of their own AI credits", async () => {
    const user = await seedUser(2);
    const res = await estimateWithGate({ sessionUserId: user.id, sessionUserEmail: user.email });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("user_balance");
      expect(res.remaining).toBe(1);
    }
    expect(await aiBalance(user.id)).toBe(1); // exactly one deducted
    expect(provider).toHaveBeenCalledTimes(1);
  });

  // 3 — No authenticated email fallback: logged-in user with no owned credits and a
  //     supplied email that HAS credits still fails, without spending that email.
  it("(3) authenticated request never falls back to a supplied email pool", async () => {
    const user = await seedUser(0);
    await seedEmailCredits("someone-else@example.test", 9);

    const res = await estimateWithGate({
      sessionUserId: user.id,
      sessionUserEmail: user.email,
      bodyEmail: "someone-else@example.test",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(402);
    expect(await emailRemaining("someone-else@example.test")).toBe(9); // untouched
    expect(provider).not.toHaveBeenCalled();
  });

  // 3b — Authenticated owner CAN consume estimate credits they legitimately own
  //      (by user_id, or by their own session-verified email), never via the body.
  it("(3b) authenticated owner consumes their OWN estimate credits (owner-bound fallback)", async () => {
    const user = await seedUser(0); // no ai_credits
    await seedEmailCredits(user.email, 3, user.id); // owned by this user

    const res = await estimateWithGate({
      sessionUserId: user.id,
      sessionUserEmail: user.email,
      bodyEmail: "attacker-controlled@example.test",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("user_estimate");
      expect(res.remaining).toBe(2);
    }
    expect(await emailRemaining(user.email)).toBe(2);
    expect(await emailUsed(user.email)).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  // 4 — Anonymous legacy success: a logged-out caller with pre-account email credits
  //     consumes exactly one and gets an estimate.
  it("(4) anonymous caller consumes one pre-account email credit", async () => {
    await seedEmailCredits("guest@example.test", 2);
    const res = await estimateWithGate({ bodyEmail: "guest@example.test" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("anon_email");
      expect(res.remaining).toBe(1);
    }
    expect(await emailRemaining("guest@example.test")).toBe(1);
    expect(await emailUsed("guest@example.test")).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  // 5 — Atomic no-credit guard: zero rows affected → provider not called.
  it("(5) anonymous email with zero credits fails and never calls the provider", async () => {
    await seedEmailCredits("empty@example.test", 0);
    const res = await estimateWithGate({ bodyEmail: "empty@example.test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(402);
    expect(await emailRemaining("empty@example.test")).toBe(0); // never negative
    expect(provider).not.toHaveBeenCalled();
  });

  // 6a — Concurrency (anonymous email): two racers, one credit → exactly one spend.
  it("(6a) two concurrent anonymous requests for one email credit spend exactly one", async () => {
    await seedEmailCredits("race@example.test", 1);
    const [a, b] = await Promise.all([
      estimateWithGate({ bodyEmail: "race@example.test" }),
      estimateWithGate({ bodyEmail: "race@example.test" }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await emailRemaining("race@example.test")).toBe(0); // never negative
  });

  // 6b — Concurrency (authenticated owner-bound estimate row): FOR UPDATE SKIP LOCKED
  //      guarantees exactly one spend across two racers.
  it("(6b) two concurrent authenticated requests for one owned estimate credit spend exactly one", async () => {
    const user = await seedUser(0);
    await seedEmailCredits(user.email, 1, user.id);
    const [a, b] = await Promise.all([
      estimateWithGate({ sessionUserId: user.id, sessionUserEmail: user.email }),
      estimateWithGate({ sessionUserId: user.id, sessionUserEmail: user.email }),
    ]);
    expect([a, b].filter((r) => r.ok).length).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await emailRemaining(user.email)).toBe(0);
  });

  // 6c — Concurrency (authenticated AI balance): deductAiCredits atomicity holds.
  it("(6c) two concurrent authenticated requests for one AI credit spend exactly one", async () => {
    const user = await seedUser(1);
    const [a, b] = await Promise.all([
      estimateWithGate({ sessionUserId: user.id, sessionUserEmail: user.email }),
      estimateWithGate({ sessionUserId: user.id, sessionUserEmail: user.email }),
    ]);
    expect([a, b].filter((r) => r.ok).length).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await aiBalance(user.id)).toBe(0); // never negative
  });

  // 7 — Checkout ownership stamping: metadata.user_id is the server session id and a
  //     browser-supplied user_id cannot override it.
  it("(7) checkout metadata stamps the session user id; a browser user_id cannot override it", () => {
    const meta = mod.buildEstimateCheckoutMetadata({
      sessionUserId: "server-session-user",
      email: "buyer@example.test",
      credits: 15,
      // A hostile client field — the helper has no parameter for it and ignores it.
      user_id: "attacker-supplied",
    } as any);
    expect(meta.user_id).toBe("server-session-user");
    expect(meta.type).toBe("estimate_credits");
    expect(meta.credits).toBe("15");

    // Anonymous checkout stamps no ownership.
    const anon = mod.buildEstimateCheckoutMetadata({ sessionUserId: null, email: "buyer@example.test", credits: 5 });
    expect(anon.user_id).toBeUndefined();
  });

  // 8 — Balance privacy: an authenticated caller sees ONLY their own balance and
  //     cannot enumerate another customer's balance via ?email=.
  it("(8) authenticated balance lookup ignores a conflicting email and returns own balance", async () => {
    const user = await seedUser(3);
    await seedEmailCredits("victim-balance@example.test", 99);

    const res = await mod.getEstimateCreditBalance(
      { sessionUserId: user.id, sessionUserEmail: user.email, queryEmail: "victim-balance@example.test" },
      { exec: testDb as any }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.scope).toBe("user");
      expect(res.credits).toBe(3); // own ai balance, NOT the victim's 99
    }
  });

  // 8b — Authenticated balance includes owned estimate credits (by user_id / email).
  it("(8b) authenticated balance sums ai credits and owned estimate credits", async () => {
    const user = await seedUser(2);
    await seedEmailCredits(user.email, 4, user.id);
    const res = await mod.getEstimateCreditBalance(
      { sessionUserId: user.id, sessionUserEmail: user.email },
      { exec: testDb as any }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.credits).toBe(6);
  });

  // 8c — Anonymous balance retains the legacy per-email lookup.
  it("(8c) anonymous balance lookup returns the email pool balance", async () => {
    await seedEmailCredits("anon-balance@example.test", 7);
    const res = await mod.getEstimateCreditBalance(
      { queryEmail: "anon-balance@example.test" },
      { exec: testDb as any }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.scope).toBe("anon");
      expect(res.credits).toBe(7);
    }
  });
});
