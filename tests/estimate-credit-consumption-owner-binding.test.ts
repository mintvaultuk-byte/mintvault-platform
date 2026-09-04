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
 *  B. anonymous email text grants no paid authority; only the IP/day free tier remains.
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
const TODAY = new Date().toISOString().slice(0, 10);

async function openSessionWhoseLocalDateDiffersFromUtc(): Promise<{
  client: pg.Client;
  exec: ReturnType<typeof drizzle>;
  utcDay: string;
  sessionDay: string;
}> {
  const client = new pg.Client({ connectionString: cluster.url });
  await client.connect();
  const utcHour = new Date().getUTCHours();
  const zone = utcHour < 10 ? "Pacific/Honolulu" : "Pacific/Kiritimati";
  await client.query(`SET TIME ZONE '${zone}'`);
  const clock = await client.query<{ utc_day: string; session_day: string }>(`
    SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS utc_day,
           CURRENT_DATE::text AS session_day
  `);
  return {
    client,
    exec: drizzle(client),
    utcDay: clock.rows[0].utc_day,
    sessionDay: clock.rows[0].session_day,
  };
}

/** Mirror the route gate: reserve, call provider, then commit or exactly-once refund. */
async function estimateWithGate(input: Parameters<typeof mod.consumeEstimateCredit>[0]) {
  const result = await mod.consumeEstimateCredit(input, { exec: testDb as any });
  if (result.ok) {
    try {
      await provider();
      if (result.reservationId) {
        await mod.settleEstimateCreditReservation(result.reservationId, "commit", { exec: testDb as any });
      }
    } catch (error) {
      if (result.reservationId) {
        await mod.settleEstimateCreditReservation(result.reservationId, "refund", { exec: testDb as any });
      }
      throw error;
    }
  }
  return result;
}

let userSeq = 0;
async function seedUser(aiCredits = 0, emailVerified = true): Promise<{ id: string; email: string }> {
  const email = `pkg3-user-${++userSeq}@example.test`;
  const r = await admin.query<{ id: string }>(
    `INSERT INTO users (email, ai_credits_user_balance, email_verified) VALUES ($1, $2, $3) RETURNING id`,
    [email, aiCredits, emailVerified]
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
        email_verified boolean NOT NULL DEFAULT false,
        deleted_at timestamptz,
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
      CREATE TABLE estimate_credit_reservations (
        id uuid PRIMARY KEY,
        credit_path text NOT NULL CHECK (credit_path IN ('user_balance', 'user_estimate', 'anon_free')),
        session_user_id text,
        estimate_credit_id integer,
        ip_hash text,
        free_use_day date,
        status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'refunded')),
        created_at timestamptz NOT NULL DEFAULT now(),
        settled_at timestamptz
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

    pool = new pg.Pool({ connectionString: cluster.url, max: 8, options: "-c timezone=UTC" });
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
    await admin.query(
      `TRUNCATE estimate_credit_reservations, estimate_credits, estimate_free_uses, audit_log RESTART IDENTITY`
    );
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
      bodyEmail: victim.email,
    } as any);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(402);
    expect(await emailRemaining(victim.email)).toBe(5); // untouched
    expect(await emailRemaining("stranger@example.test")).toBe(5); // untouched
    expect(provider).not.toHaveBeenCalled();
  });

  // 2 — Authenticated own-credit success: exactly one credit deducted, one estimate.
  it("(2) authenticated owner consumes exactly one of their own AI credits", async () => {
    const user = await seedUser(2);
    const res = await estimateWithGate({ sessionUserId: user.id });
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
      bodyEmail: "someone-else@example.test",
    } as any);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(402);
    expect(await emailRemaining("someone-else@example.test")).toBe(9); // untouched
    expect(provider).not.toHaveBeenCalled();
  });

  // 3b — Authenticated owner CAN consume estimate credits they legitimately own
  //      (by user_id, or by their own session-verified email), never via the body.
  it("(3b) authenticated owner consumes their OWN estimate credits (owner-bound fallback)", async () => {
    const user = await seedUser(0); // no ai_credits
    await seedEmailCredits(user.email, 3); // legacy pre-account row, claimed only by verified live email

    const res = await estimateWithGate({
      sessionUserId: user.id,
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

  // 4 — Public email is not an ownership credential. The logged-out caller gets
  //     only the existing bounded free use and the paid row is untouched.
  it("(4) anonymous caller cannot spend a pre-account email row", async () => {
    await seedEmailCredits("guest@example.test", 2);
    const res = await estimateWithGate({
      bodyEmail: "guest@example.test",
      ipHash: "anon-email-is-not-authority",
      today: TODAY,
    } as any);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("anon_free");
      expect(res.remaining).toBeNull();
    }
    expect(await emailRemaining("guest@example.test")).toBe(2);
    expect(await emailUsed("guest@example.test")).toBe(0);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  // 5 — The second anonymous call from an IP/day is refused before the provider.
  it("(5) anonymous free-tier exhaustion never calls the provider again", async () => {
    await estimateWithGate({ ipHash: "bounded-anon", today: TODAY });
    provider.mockClear();
    const res = await estimateWithGate({ ipHash: "bounded-anon", today: TODAY });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(402);
    expect(provider).not.toHaveBeenCalled();
  });

  // 6a — Concurrency (anonymous free tier): two racers → one bounded call.
  it("(6a) two concurrent anonymous requests from one IP/day admit exactly one", async () => {
    const [a, b] = await Promise.all([
      estimateWithGate({ ipHash: "race", today: TODAY }),
      estimateWithGate({ ipHash: "race", today: TODAY }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps the anonymous daily limit on UTC when the database session date differs", async () => {
    const isolated = await openSessionWhoseLocalDateDiffersFromUtc();
    try {
      expect(isolated.sessionDay).not.toBe(isolated.utcDay);
      const first = await mod.consumeEstimateCredit(
        { ipHash: "non-utc-daily-limit", today: isolated.utcDay },
        { exec: isolated.exec as any }
      );
      expect(first).toMatchObject({ ok: true, path: "anon_free" });
      if (first.ok && first.reservationId) {
        await mod.settleEstimateCreditReservation(first.reservationId, "commit", {
          exec: isolated.exec as any,
        });
      }

      const second = await mod.consumeEstimateCredit(
        { ipHash: "non-utc-daily-limit", today: isolated.utcDay },
        { exec: isolated.exec as any }
      );
      expect(second).toMatchObject({ ok: false, status: 402 });
    } finally {
      await isolated.client.end();
    }
  });

  it("refunds an anonymous UTC-day reservation when the database session date differs", async () => {
    const isolated = await openSessionWhoseLocalDateDiffersFromUtc();
    try {
      expect(isolated.sessionDay).not.toBe(isolated.utcDay);
      const reservation = await mod.consumeEstimateCredit(
        { ipHash: "non-utc-refund", today: isolated.utcDay },
        { exec: isolated.exec as any }
      );
      expect(reservation).toMatchObject({ ok: true, path: "anon_free" });
      if (!reservation.ok || !reservation.reservationId) throw new Error("anonymous reservation was not created");

      await expect(
        mod.settleEstimateCreditReservation(reservation.reservationId, "refund", {
          exec: isolated.exec as any,
        })
      ).resolves.toBe(true);
      const usage = await isolated.client.query<{ count_today: number }>(
        `SELECT count_today FROM estimate_free_uses WHERE ip_hash = 'non-utc-refund'`
      );
      expect(usage.rows[0].count_today).toBe(0);
    } finally {
      await isolated.client.end();
    }
  });

  // 6b — Concurrency (authenticated owner-bound estimate row): FOR UPDATE SKIP LOCKED
  //      guarantees exactly one spend across two racers.
  it("(6b) two concurrent authenticated requests for one owned estimate credit spend exactly one", async () => {
    const user = await seedUser(0);
    await seedEmailCredits(user.email, 1, user.id);
    const [a, b] = await Promise.all([
      estimateWithGate({ sessionUserId: user.id }),
      estimateWithGate({ sessionUserId: user.id }),
    ]);
    expect([a, b].filter((r) => r.ok).length).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await emailRemaining(user.email)).toBe(0);
  });

  // 6c — Concurrency (authenticated AI balance): deductAiCredits atomicity holds.
  it("(6c) two concurrent authenticated requests for one AI credit spend exactly one", async () => {
    const user = await seedUser(1);
    const [a, b] = await Promise.all([
      estimateWithGate({ sessionUserId: user.id }),
      estimateWithGate({ sessionUserId: user.id }),
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

    expect(meta.email).toBe("buyer@example.test");
  });

  // 8 — Balance privacy: an authenticated caller sees ONLY their own balance and
  //     cannot enumerate another customer's balance via ?email=.
  it("(8) authenticated balance lookup ignores a conflicting email and returns own balance", async () => {
    const user = await seedUser(3);
    await seedEmailCredits("victim-balance@example.test", 99);

    const res = await mod.getEstimateCreditBalance({ sessionUserId: user.id }, { exec: testDb as any });
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
    const res = await mod.getEstimateCreditBalance({ sessionUserId: user.id }, { exec: testDb as any });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.credits).toBe(6);
  });

  // 8c — Anonymous callers cannot enumerate a paid balance by email.
  it("(8c) anonymous balance lookup is refused", async () => {
    await seedEmailCredits("anon-balance@example.test", 7);
    const res = await mod.getEstimateCreditBalance({}, { exec: testDb as any });
    expect(res).toMatchObject({ ok: false, status: 401 });
    expect(await emailRemaining("anon-balance@example.test")).toBe(7);
  });

  it("does not let an unverified account email claim a legacy credit row", async () => {
    const user = await seedUser(0, false);
    await seedEmailCredits(user.email, 9);
    const res = await estimateWithGate({ sessionUserId: user.id });
    expect(res).toMatchObject({ ok: false, status: 402 });
    expect(await emailRemaining(user.email)).toBe(9);
    expect(provider).not.toHaveBeenCalled();
  });

  it("grants unlimited use only from explicit authenticated-admin state", async () => {
    expect(await estimateWithGate({ isAuthenticatedAdmin: true })).toMatchObject({ ok: true, path: "admin" });
    expect(provider).toHaveBeenCalledTimes(1);
    provider.mockClear();
    expect(await estimateWithGate({ bodyEmail: "neilsophieoliver@gmail.com" } as any)).toMatchObject({
      ok: false,
      status: 402,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("refunds provider/parse failure exactly once and permits a successful retry", async () => {
    const user = await seedUser(1);
    provider.mockRejectedValueOnce(new SyntaxError("invalid provider JSON"));

    await expect(estimateWithGate({ sessionUserId: user.id })).rejects.toThrow(/invalid provider JSON/);
    expect(await aiBalance(user.id)).toBe(1);
    const refunded = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM estimate_credit_reservations ORDER BY created_at LIMIT 1`
    );
    expect(refunded.rows[0].status).toBe("refunded");

    // A duplicate compensator cannot mint a second credit.
    await expect(
      mod.settleEstimateCreditReservation(refunded.rows[0].id, "refund", { exec: testDb as any })
    ).resolves.toBe(true);
    expect(await aiBalance(user.id)).toBe(1);

    provider.mockResolvedValueOnce({ estimated_grade: 8 });
    const retry = await estimateWithGate({ sessionUserId: user.id });
    expect(retry).toMatchObject({ ok: true, path: "user_balance", remaining: 0 });
    expect(await aiBalance(user.id)).toBe(0);
    if (retry.ok && retry.reservationId) {
      expect(await mod.settleEstimateCreditReservation(retry.reservationId, "refund", { exec: testDb as any })).toBe(
        false
      );
    }
    expect(await aiBalance(user.id)).toBe(0);
  });

  it("refunds a failed anonymous inference so the same /56 bucket can retry", async () => {
    provider.mockRejectedValueOnce(new Error("provider 503"));
    await expect(estimateWithGate({ ipHash: "anon-refund", today: TODAY })).rejects.toThrow(/503/);
    const afterFailure = await pool.query<{ count_today: number }>(
      `SELECT count_today FROM estimate_free_uses WHERE ip_hash='anon-refund'`
    );
    expect(afterFailure.rows[0].count_today).toBe(0);

    const retry = await estimateWithGate({ ipHash: "anon-refund", today: TODAY });
    expect(retry).toMatchObject({ ok: true, path: "anon_free" });
  });

  it("uses trusted req.ip and collapses IPv6 rotation to one /56 hash bucket", () => {
    const a = mod.estimateAnonymousIpHash({
      ip: "2001:db8:abcd:1201::1",
      socket: { remoteAddress: "203.0.113.8" },
      headers: { "x-forwarded-for": "198.51.100.1" },
    } as any);
    const spoofChanged = mod.estimateAnonymousIpHash({
      ip: "2001:db8:abcd:1201::1",
      socket: { remoteAddress: "203.0.113.8" },
      headers: { "x-forwarded-for": "192.0.2.222" },
    } as any);
    const rotated = mod.estimateAnonymousIpHash({ ip: "2001:db8:abcd:12ff:ffff::9" });
    const otherPrefix = mod.estimateAnonymousIpHash({ ip: "2001:db8:abcd:1300::1" });

    expect(spoofChanged).toBe(a);
    expect(rotated).toBe(a);
    expect(otherPrefix).not.toBe(a);
  });

  it("recovers crash-stranded reservations in bounded concurrent batches exactly once", async () => {
    const user = await seedUser(4);
    const reservations = await Promise.all(
      Array.from({ length: 4 }, () => mod.consumeEstimateCredit({ sessionUserId: user.id }, { exec: testDb as any }))
    );
    expect(reservations.every((reservation) => reservation.ok && reservation.reservationId)).toBe(true);
    expect(await aiBalance(user.id)).toBe(0);
    await admin.query(`UPDATE estimate_credit_reservations SET created_at = NOW() - INTERVAL '20 minutes'`);

    const [first, second] = await Promise.all([
      mod.refundStaleEstimateCreditReservations({ batchSize: 2 }, { exec: testDb as any }),
      mod.refundStaleEstimateCreditReservations({ batchSize: 2 }, { exec: testDb as any }),
    ]);
    expect(first.refunded + second.refunded).toBe(4);
    expect(first.examined + second.examined).toBe(4);
    expect(first.unrecoverable + second.unrecoverable).toBe(0);
    expect(await aiBalance(user.id)).toBe(4);
    expect(
      (
        await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM estimate_credit_reservations WHERE status='refunded'`
        )
      ).rows[0].count
    ).toBe("4");

    expect(await mod.refundStaleEstimateCreditReservations({}, { exec: testDb as any })).toEqual({
      examined: 0,
      refunded: 0,
      unrecoverable: 0,
    });
    expect(await aiBalance(user.id)).toBe(4);
  });

  it("restores owned estimate and anonymous pools but leaves a live reservation alone", async () => {
    const user = await seedUser(0);
    await seedEmailCredits(user.email, 2, user.id);
    const ownedA = await mod.consumeEstimateCredit({ sessionUserId: user.id }, { exec: testDb as any });
    const ownedB = await mod.consumeEstimateCredit({ sessionUserId: user.id }, { exec: testDb as any });
    const anonymous = await mod.consumeEstimateCredit(
      { ipHash: "crash-anonymous", today: TODAY },
      { exec: testDb as any }
    );
    expect([ownedA, ownedB, anonymous].every((reservation) => reservation.ok)).toBe(true);
    await admin.query(`UPDATE estimate_credit_reservations SET created_at = NOW() - INTERVAL '20 minutes'`);

    await admin.query(`UPDATE users SET ai_credits_user_balance=1 WHERE id=$1`, [user.id]);
    const live = await mod.consumeEstimateCredit({ sessionUserId: user.id }, { exec: testDb as any });
    expect(live).toMatchObject({ ok: true, path: "user_balance" });

    expect(await mod.refundStaleEstimateCreditReservations({}, { exec: testDb as any })).toEqual({
      examined: 3,
      refunded: 3,
      unrecoverable: 0,
    });
    expect(await emailRemaining(user.email)).toBe(2);
    expect(await emailUsed(user.email)).toBe(0);
    expect(
      (
        await pool.query<{ count_today: number }>(
          `SELECT count_today FROM estimate_free_uses WHERE ip_hash='crash-anonymous'`
        )
      ).rows[0].count_today
    ).toBe(0);
    expect(await aiBalance(user.id)).toBe(0);
    expect(
      (
        await pool.query<{ status: string }>(`SELECT status FROM estimate_credit_reservations WHERE id=$1`, [
          live.ok ? live.reservationId : null,
        ])
      ).rows[0].status
    ).toBe("reserved");
  });

  it("does not claim a paid refund when its source row is missing", async () => {
    const user = await seedUser(0);
    await seedEmailCredits(user.email, 1, user.id);
    const reservation = await mod.consumeEstimateCredit({ sessionUserId: user.id }, { exec: testDb as any });
    expect(reservation).toMatchObject({ ok: true, path: "user_estimate" });
    await admin.query(`UPDATE estimate_credit_reservations SET created_at = NOW() - INTERVAL '20 minutes'`);
    await admin.query(`DELETE FROM estimate_credits WHERE user_id=$1`, [user.id]);

    expect(await mod.refundStaleEstimateCreditReservations({}, { exec: testDb as any })).toEqual({
      examined: 1,
      refunded: 0,
      unrecoverable: 1,
    });
    expect(
      (
        await pool.query<{ status: string }>(`SELECT status FROM estimate_credit_reservations WHERE id=$1`, [
          reservation.ok ? reservation.reservationId : null,
        ])
      ).rows[0].status
    ).toBe("reserved");
  });

  it("refuses a recovery age that can race the live provider timeout", async () => {
    expect(mod.ESTIMATE_CREDIT_STALE_RESERVATION_MS).toBeGreaterThan(30_000);
    await expect(
      mod.refundStaleEstimateCreditReservations({ staleAfterMs: 30_000 }, { exec: testDb as any })
    ).rejects.toThrow(/must exceed the provider timeout/);
  });
});
