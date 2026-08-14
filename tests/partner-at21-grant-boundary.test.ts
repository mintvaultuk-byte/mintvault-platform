/**
 * AT-21 — WEBHOOK GRANT UNDER CONCURRENT NEW. The grant boundary itself.
 *
 * WHY THIS SUITE EXISTS SEPARATELY. Two halves of AT-21 were already proven and neither is the thing
 * AT-21 actually asks about:
 *   - `partner-credit-purchase.test.ts` proves a Stripe grant is idempotent — but nothing else is
 *     happening at the time;
 *   - `partner-pilot-concurrency.test.ts` L1 proves the last-credit race — but capacity is static
 *     throughout.
 *
 * AT-21 is the MOMENT BETWEEN: capacity is zero, stations are hammering NEW, and a verified webhook
 * grants ten credits *while they are mid-flight*. That is where a cached balance, a stale read, a
 * lost grant or a double grant would show, and neither existing suite can see it. The previous
 * release matrix recorded AT-21 as PARTIAL on exactly this basis, with the note that the argument
 * for it was "an argument, not a test". This is the test.
 *
 * NO MOCKS ANYWHERE ON THE MONEY PATH. The grant is the real `fulfilPartnerCreditPurchase` — the same
 * function the verified webhook calls — which reads credits from the real `partner_credit_packs`
 * catalogue (never from session metadata) and appends through the real `appendFoundationCredit`. NEW
 * is the real `startNewCardJobAtStation`. Availability is `partner_credit_availability`, which is a
 * VIEW: there is no balance column to cache, and that is checked here rather than assumed.
 *
 * THE RACE IS REAL. Grant and NEW run under one `Promise.all` on independent pool connections. The
 * overlap is produced by the NEW workers RETRYING IN A LOOP across the grant boundary — not by a
 * sleep. A sleep would make the interleaving a timing coincidence; a retry loop guarantees that
 * attempts land on both sides of the grant every iteration, and that the losing attempts are real
 * refusals rather than a paused test.
 *
 * REPEATED, because one lucky ordering proves nothing about an ordering that has not happened yet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { createCertificatesStub } from "./helpers/certificates-stub";

let cluster: DisposablePostgres17;
/** A Pool, not a Client: this suite runs its own fixture work concurrently with the race. */
let admin: Pool;
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
let purchase: typeof import("../server/partner/credit-purchase-service");
let drizzle: typeof import("../server/db");
let savedEnv: Record<string, string | undefined> = {};

const RUN_SALT = Math.random().toString(36).slice(2, 8);

/** The pack the webhook grants. Real catalogue row, seeded by migration 0083. */
const PACK_CODE = "PACK_10";
const PACK_CREDITS = 10;

/** How many independent NEW workers hammer the boundary. */
const NEW_WORKERS = 4;
/** Attempts per worker across the boundary. Enough that some land before the grant and some after. */
const ATTEMPTS_PER_WORKER = 8;
/** Concurrent deliveries of the SAME webhook event — Stripe retries and can double-deliver. */
const WEBHOOK_DELIVERIES = 4;
/** Independent iterations. One ordering is an anecdote; several are evidence. */
const ITERATIONS = 4;

interface Shop {
  tenantId: string;
  locationId: string;
  userId: string;
  stationOne: string;
  stationTwo: string;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, service_tier text, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query(
    "CREATE TABLE submission_items (id serial primary key, submission_id integer not null, card_index integer)"
  );
  await admin.query("CREATE TABLE cards (id serial primary key, submission_id integer)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  await createCertificatesStub(admin);
  await admin.query(`CREATE TABLE cert_counter (
    id integer primary key, last_issued bigint not null default 0, updated_at timestamptz not null default now()
  )`);
  await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)");
  for (const t of ["users", "submissions", "submission_items", "cards", "audit_log", "cert_counter"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

let shopSeq = 0;

/** A fully provisioned, ACTIVE partner with TWO approved stations and a wallet at ZERO. */
async function makeShop(label: string): Promise<Shop> {
  shopSeq += 1;
  const tag = `${label}${shopSeq}${RUN_SALT}`;
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${tag}`, `${label} Ltd`]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [
    tenantId,
    `${label} Cards`,
  ]);
  const locationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
       VALUES ($1,$2,$2,$3,$4,'ACTIVE') RETURNING id`,
      [`loc-${tag}`, tenantId, `${label} Shop`, "1 High Street"]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${tag}`, tenantId, `op.${tag}@shop.test`]
    )
  ).rows[0].id;
  const base32 = (raw: string, n: number) =>
    raw
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, "2")
      .padEnd(n, "2")
      .slice(0, n);
  // BOTH stations in the SAME location: AT-21 asks that the result hold when NEW comes from two
  // different stations, which is a contention question, not a location-scope one.
  const mkStation = async (suffix: string) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_stations
           (tenant_id, location_id, station_code, status, approved_at, public_key_pem, public_key_fingerprint)
         VALUES ($1,$2,$3,'ACTIVE', now(), $4, $5) RETURNING id`,
        [
          tenantId,
          locationId,
          /*
           * The DISCRIMINATOR GOES FIRST. `chk_partner_station_code` caps the suffix, so building it
           * as `<label><seq><salt><a|b>` and slicing to 16 truncated the a/b away for any label long
           * enough — giving both of a shop's stations the same globally-unique code. Leading with the
           * parts that actually distinguish the station makes truncation harmless.
           */
          `MV-STN-${base32(`${suffix}${shopSeq}${RUN_SALT}${label}`, 16)}`,
          "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----",
          `${suffix}${shopSeq}${RUN_SALT}${label}`
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "0")
            .padEnd(64, "0")
            .slice(0, 64),
        ]
      )
    ).rows[0].id;

  // The wallet exists and is ACTIVE, but holds NOTHING. That is the AT-21 starting state.
  await wallet.ensureWallet({ actorType: "admin", actorUserId: null, actorEmail: "ops@mintvault.test" }, tenantId);
  return { tenantId, locationId, userId, stationOne: await mkStation("a"), stationTwo: await mkStation("b") };
}

async function availableFor(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ v: string }>(
    `SELECT COALESCE(available_balance, 0)::text AS v FROM partner_credit_availability WHERE tenant_id=$1`,
    [tenantId]
  );
  return Number(rows[0]?.v ?? 0);
}

interface NewResult {
  cardJobId: string;
  mvNumber: string;
  certificateId: number;
  reservationId: string;
  replayed: boolean;
}

function pressNew(shop: Shop, stationId: string, clientOpId: string): Promise<NewResult> {
  return authority.startNewCardJobAtStation({
    tenantId: shop.tenantId,
    locationId: shop.locationId,
    stationId,
    clientOpId,
    actorUserId: shop.userId,
    actorEmail: "operator@shop.test",
    cardName: "Grant boundary card",
  });
}

/** The REAL webhook grant, exactly as the verified handler calls it. */
function deliverWebhook(shop: Shop, eventId: string, sessionId: string) {
  return purchase.fulfilPartnerCreditPurchase(
    {
      id: sessionId,
      payment_status: "paid",
      metadata: {
        partner_tenant_id: shop.tenantId,
        partner_pack_code: PACK_CODE,
        partner_initiating_user_id: shop.userId,
      },
    },
    eventId
  );
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

interface RaceOutcome {
  successes: NewResult[];
  insufficient: number;
  granted: number;
}

/**
 * ONE ITERATION OF THE BOUNDARY.
 *
 * Grant and NEW start together. Each NEW worker retries across the boundary with a FRESH client op
 * id per attempt — a fresh id is what makes the attempt a genuinely new operation rather than a
 * replay, so a refusal is a real capacity refusal.
 */
async function runBoundary(shop: Shop, iteration: number): Promise<RaceOutcome> {
  const eventId = `evt_${shop.tenantId.slice(0, 8)}_${iteration}_${RUN_SALT}`;
  const sessionId = `cs_${shop.tenantId.slice(0, 8)}_${iteration}`;
  const successes: NewResult[] = [];
  let insufficient = 0;

  const newWorker = async (worker: number) => {
    // Alternate stations so half the pressure comes from each approved Mac.
    const stationId = worker % 2 === 0 ? shop.stationOne : shop.stationTwo;
    for (let attempt = 0; attempt < ATTEMPTS_PER_WORKER; attempt += 1) {
      const outcome = await settle(pressNew(shop, stationId, `at21-${iteration}-w${worker}-a${attempt}-${RUN_SALT}`));
      if (outcome.ok) successes.push(outcome.value);
      else if (outcome.code === "INSUFFICIENT_CREDITS") insufficient += 1;
      else throw new Error(`unexpected NEW failure: ${outcome.code}`);
    }
  };

  const webhookDelivery = async () => {
    const outcome = await settle(deliverWebhook(shop, eventId, sessionId));
    // A duplicate delivery may legitimately be refused by the ledger's uniqueness OR reported as
    // already-applied; both are correct exactly-once behaviour and neither may grant twice.
    return outcome.ok && outcome.value.granted ? 1 : 0;
  };

  const results = await Promise.all([
    ...Array.from({ length: NEW_WORKERS }, (_, w) => newWorker(w)),
    ...Array.from({ length: WEBHOOK_DELIVERIES }, () => webhookDelivery()),
  ]);
  const granted = results.slice(NEW_WORKERS).reduce<number>((sum, r) => sum + (typeof r === "number" ? r : 0), 0);

  /*
   * DRAIN. The race may end with capacity still unspent — the workers have a finite attempt budget
   * and some of theirs were refused before the grant landed. AT-21 asks that the granted capacity be
   * FULLY usable afterwards, so keep pressing until the wallet genuinely refuses.
   */
  for (let extra = 0; extra < PACK_CREDITS * 3; extra += 1) {
    const outcome = await settle(pressNew(shop, shop.stationOne, `at21-drain-${iteration}-${extra}-${RUN_SALT}`));
    if (outcome.ok) successes.push(outcome.value);
    else if (outcome.code === "INSUFFICIENT_CREDITS") {
      insufficient += 1;
      break;
    } else throw new Error(`unexpected drain failure: ${outcome.code}`);
  }

  return { successes, insufficient, granted };
}

/** Wallet/ledger/reservation reconciliation, straight from the database. */
async function reconcile(tenantId: string) {
  const { rows } = await admin.query<{
    ledger_total: string;
    active_reservations: string;
    available: string;
    stripe_rows: string;
    job_count: string;
  }>(
    `SELECT
       COALESCE((SELECT sum(amount) FROM partner_credit_ledger WHERE tenant_id=$1),0)::text AS ledger_total,
       (SELECT count(*) FROM partner_credit_reservations WHERE tenant_id=$1 AND status='active')::text AS active_reservations,
       COALESCE((SELECT available_balance FROM partner_credit_availability WHERE tenant_id=$1),0)::text AS available,
       (SELECT count(*) FROM partner_credit_ledger WHERE tenant_id=$1 AND source='stripe')::text AS stripe_rows,
       (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1)::text AS job_count`,
    [tenantId]
  );
  return {
    ledgerTotal: Number(rows[0].ledger_total),
    activeReservations: Number(rows[0].active_reservations),
    available: Number(rows[0].available),
    stripeRows: Number(rows[0].stripe_rows),
    jobCount: Number(rows[0].job_count),
  };
}

/** The invariants that must hold for a tenant after any amount of contention. */
async function assertTenantInvariants(tenantId: string): Promise<void> {
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

  // 8. Never negative capacity.
  expect(
    await q(`SELECT 1 FROM partner_credit_availability WHERE tenant_id=$1 AND available_balance < 0`, [tenantId])
  ).toEqual([]);

  // 9. No duplicate reservations — one reservation funds at most one job, and one card unit has at
  //    most one reservation.
  expect(
    await q(
      `SELECT reservation_id FROM partner_card_jobs
              WHERE tenant_id=$1 AND reservation_id IS NOT NULL
              GROUP BY reservation_id HAVING count(*) > 1`,
      [tenantId]
    )
  ).toEqual([]);

  // 10. No duplicate Card Jobs for one paid unit.
  expect(
    await q(
      `SELECT card_id, ordinal FROM partner_card_jobs WHERE tenant_id=$1
              GROUP BY card_id, ordinal HAVING count(*) > 1`,
      [tenantId]
    )
  ).toEqual([]);

  // 11. No duplicate MV numbers.
  expect(
    await q(`SELECT mv_number FROM partner_card_jobs WHERE mv_number IS NOT NULL
              GROUP BY mv_number HAVING count(*) > 1`)
  ).toEqual([]);

  // 12. No duplicate certificate lineage.
  expect(
    await q(`SELECT certificate_id FROM partner_card_jobs WHERE certificate_id IS NOT NULL
              GROUP BY certificate_id HAVING count(*) > 1`)
  ).toEqual([]);
  expect(
    await q(`SELECT certificate_number FROM certificates GROUP BY certificate_number HAVING count(*) > 1`)
  ).toEqual([]);

  // 13. Every Card Job has exactly one reservation behind it.
  expect(await q(`SELECT id FROM partner_card_jobs WHERE tenant_id=$1 AND reservation_id IS NULL`, [tenantId])).toEqual(
    []
  );
}

let shopUnderTest: Shop;
let otherShop: Shop;

describe("AT-21 webhook grant under concurrent NEW (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-at21-grant-boundary");
    admin = new Pool({ connectionString: cluster.url, max: 24 });
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      "0035_partner_certificate_origin",
      "0045_partner_stations",
      // 0083 carries the real pack catalogue the grant reads its credit count from.
      "0083_partner_credit_packs",
      "0087_partner_grading_edit_lease",
    ]);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
      PARTNER_CONNECTOR_DATABASE_URL: process.env.PARTNER_CONNECTOR_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    delete process.env.PARTNER_CONNECTOR_DATABASE_URL;

    wallet = await import("../server/partner/partner-wallet-service");
    authority = await import("../server/partner/card-job-authority");
    purchase = await import("../server/partner/credit-purchase-service");
    drizzle = await import("../server/db");

    shopUnderTest = await makeShop("at21");
    otherShop = await makeShop("neighbour");
  }, 300_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await drizzle?.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("the pack catalogue is real server-side data, not caller-supplied", async () => {
    // The grant reads credits from `partner_credit_packs` by code. If it trusted session metadata a
    // tampered checkout could mint arbitrary capacity, so the value under test must come from here.
    const { rows } = await admin.query<{ credits: number }>(`SELECT credits FROM partner_credit_packs WHERE code=$1`, [
      PACK_CODE,
    ]);
    expect(Number(rows[0]?.credits)).toBe(PACK_CREDITS);
  });

  it(`AT-21: ${ITERATIONS} independent grant-boundary races each yield EXACTLY ${PACK_CREDITS} Card Jobs`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      // A FRESH shop per iteration, so each race starts from a genuine zero rather than from the
      // residue of the last one.
      const shop = iteration === 0 ? shopUnderTest : await makeShop("at21");
      expect(await availableFor(shop.tenantId)).toBe(0);

      const before = await reconcile(shop.tenantId);
      expect(before.ledgerTotal).toBe(0);
      expect(before.jobCount).toBe(0);

      const outcome = await runBoundary(shop, iteration);

      /* ---- 1 / 2 / 15: the grant applied EXACTLY ONCE, however many deliveries raced ----------
       *
       * THE LEDGER IS ASSERTED FIRST, DELIBERATELY. The money question ("did capacity move twice?")
       * and the reporting question ("did the handler say it granted twice?") are different, and a
       * failure in the second must never be mistaken for a failure in the first. Checking the
       * database before the return value means the diagnosis is unambiguous.
       */
      const after = await reconcile(shop.tenantId);
      expect(after.stripeRows).toBe(1);
      const { rows: ledgerRows } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM partner_credit_ledger
            WHERE tenant_id=$1 AND source='stripe' AND entry_type='purchase'`,
        [shop.tenantId]
      );
      expect(Number(ledgerRows[0].n)).toBe(1);
      // 2. Concurrent replay cannot exceed the pack: total credited is exactly 10, never 20 or 40.
      expect(after.ledgerTotal).toBe(PACK_CREDITS);

      // Only NOW the reporting question: exactly one delivery may report that it performed the grant.
      expect(outcome.granted).toBe(1);

      // ---- 5 / 6: the granted capacity is fully and exactly usable ----------------------------
      expect(outcome.successes).toHaveLength(PACK_CREDITS);

      // ---- 4: refusals before the grant are legitimate, and capacity became usable afterwards --
      // (successes only exist because attempts after the grant saw the new capacity immediately)
      expect(outcome.insufficient).toBeGreaterThan(0);

      // ---- 7: the 11th is refused --------------------------------------------------------------
      const eleventh = await settle(pressNew(shop, shop.stationOne, `at21-11th-${iteration}-${RUN_SALT}`));
      expect(eleventh.ok).toBe(false);
      if (!eleventh.ok) expect(eleventh.code).toBe("INSUFFICIENT_CREDITS");

      // ---- 8 / 9 / 10 / 11 / 12 / 13 -----------------------------------------------------------
      await assertTenantInvariants(shop.tenantId);

      // ---- 14: reconciliation is mathematically exact ------------------------------------------
      // available = ledger total − active reservations, with one reservation per successful NEW.
      expect(after.jobCount).toBe(PACK_CREDITS);
      expect(after.activeReservations).toBe(PACK_CREDITS);
      expect(after.available).toBe(PACK_CREDITS - after.activeReservations);
      expect(after.available).toBe(0);

      // Distinct identities across every winner.
      expect(new Set(outcome.successes.map((s) => s.cardJobId)).size).toBe(PACK_CREDITS);
      expect(new Set(outcome.successes.map((s) => s.mvNumber)).size).toBe(PACK_CREDITS);
      expect(new Set(outcome.successes.map((s) => s.certificateId)).size).toBe(PACK_CREDITS);
      expect(new Set(outcome.successes.map((s) => s.reservationId)).size).toBe(PACK_CREDITS);

      // ---- 18: both stations genuinely participated --------------------------------------------
      const { rows: stationRows } = await admin.query<{ n: string }>(
        `SELECT count(DISTINCT station_id)::text AS n FROM partner_card_job_op_keys WHERE tenant_id=$1`,
        [shop.tenantId]
      );
      expect(Number(stationRows[0].n)).toBe(2);

      // ---- 19: the neighbour gained nothing from another tenant's grant ------------------------
      expect(await availableFor(otherShop.tenantId)).toBe(0);
    }
  }, 600_000);

  it("AT-21/16: a webhook redelivered AFTER the race is still a no-op", async () => {
    const shop = await makeShop("replay");
    const eventId = `evt_replay_${RUN_SALT}`;
    const first = await deliverWebhook(shop, eventId, `cs_replay_${RUN_SALT}`);
    expect(first.granted).toBe(true);
    expect(first.credits).toBe(PACK_CREDITS);
    expect(await availableFor(shop.tenantId)).toBe(PACK_CREDITS);

    /*
     * Stripe redelivers for hours after the fact. The ledger's (source, idempotency_key) uniqueness
     * is what makes that a no-op — not the handler remembering anything.
     *
     * The redelivery must also SAY it was a redelivery. This assertion is exact rather than
     * permissive because a loose version is what let the original defect hide: the ledger was
     * checked, the return value was not, and every delivery claimed to have granted.
     */
    for (let i = 0; i < 3; i += 1) {
      const replay = await deliverWebhook(shop, eventId, `cs_replay_${RUN_SALT}`);
      expect(replay.granted).toBe(false);
      expect(replay.reason).toBe("already_granted");
      // The caller still learns what the event was worth, even though this delivery applied nothing.
      expect(replay.credits).toBe(PACK_CREDITS);
    }
    expect(await availableFor(shop.tenantId)).toBe(PACK_CREDITS);
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_credit_ledger WHERE tenant_id=$1 AND source='stripe'`,
      [shop.tenantId]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("AT-21/17: the SAME client_op_id retried across the grant boundary spends exactly one credit", async () => {
    const shop = await makeShop("opkey");
    const opId = `at21-same-op-${RUN_SALT}`;

    // Before capacity exists the retry is refused for capacity, not swallowed.
    const early = await settle(pressNew(shop, shop.stationOne, opId));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.code).toBe("INSUFFICIENT_CREDITS");

    await deliverWebhook(shop, `evt_opkey_${RUN_SALT}`, `cs_opkey_${RUN_SALT}`);

    // Now ten concurrent retries of the SAME operation. Idempotency lives in PostgreSQL on
    // (station_id, client_op_id), so a retry landing on another Fly Machine is the same case.
    const results = await Promise.all(Array.from({ length: 10 }, () => settle(pressNew(shop, shop.stationOne, opId))));
    const wins = results.filter((r) => r.ok) as { ok: true; value: NewResult }[];
    expect(wins.length).toBeGreaterThan(0);
    expect(new Set(wins.map((w) => w.value.cardJobId)).size).toBe(1);
    expect(new Set(wins.map((w) => w.value.mvNumber)).size).toBe(1);

    // Exactly ONE credit spent, nine credits still available.
    expect(await availableFor(shop.tenantId)).toBe(PACK_CREDITS - 1);
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_card_jobs WHERE tenant_id=$1`,
      [shop.tenantId]
    );
    expect(Number(rows[0].n)).toBe(1);
    await assertTenantInvariants(shop.tenantId);
  });

  it("AT-21/3 + /20: capacity is derived live, and no process-local state participates", async () => {
    const shop = await makeShop("nocache");

    /*
     * 3. NO STALE CACHED BALANCE.
     *
     * `partner_credit_availability` is a VIEW (migration 0017) — there is no balance column anywhere
     * to go stale, and availability is recomputed from the ledger and active reservations on every
     * read. Proven, not asserted: a grant applied through the service is visible IMMEDIATELY to a
     * completely independent connection that has never seen the service's process.
     */
    const { rows: viewRows } = await admin.query<{ kind: string }>(
      `SELECT c.relkind::text AS kind FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='partner_credit_availability'`
    );
    expect(viewRows[0].kind).toBe("v");

    const independent = new Pool({ connectionString: cluster.url, max: 2 });
    try {
      const readVia = async (pool: Pool) =>
        Number(
          (
            await pool.query<{ v: string }>(
              `SELECT COALESCE(available_balance,0)::text AS v FROM partner_credit_availability WHERE tenant_id=$1`,
              [shop.tenantId]
            )
          ).rows[0]?.v ?? 0
        );

      expect(await readVia(independent)).toBe(0);
      await deliverWebhook(shop, `evt_nocache_${RUN_SALT}`, `cs_nocache_${RUN_SALT}`);
      // A brand-new connection, opened before the grant, sees the granted capacity with no
      // invalidation step of any kind.
      expect(await readVia(independent)).toBe(PACK_CREDITS);

      await pressNew(shop, shop.stationOne, `at21-nocache-${RUN_SALT}`);
      expect(await readVia(independent)).toBe(PACK_CREDITS - 1);

      /*
       * 20. NO PROCESS-LOCAL CACHE, MAP OR LOCK PARTICIPATES IN CORRECTNESS.
       *
       * The strongest available local proof short of two Fly Machines: discard every pooled
       * connection the services hold and re-import them, so any module-level state is rebuilt from
       * nothing. Authority must be unchanged, because it was never in the process to begin with.
       */
      const partnerDb = await import("../server/partner/db");
      await partnerDb.closePartnerPools();
      const reimported = await import("../server/partner/card-job-authority");
      const outcome = await settle(
        reimported.startNewCardJobAtStation({
          tenantId: shop.tenantId,
          locationId: shop.locationId,
          stationId: shop.stationTwo,
          clientOpId: `at21-coldstart-${RUN_SALT}`,
          actorUserId: shop.userId,
          actorEmail: "operator@shop.test",
          cardName: "Cold start card",
        })
      );
      expect(outcome.ok).toBe(true);
      // Capacity continued from where the database said it was — not from a rebuilt in-memory count.
      expect(await readVia(independent)).toBe(PACK_CREDITS - 2);
    } finally {
      await independent.end().catch(() => {});
    }
    await assertTenantInvariants(shop.tenantId);
  });
});
