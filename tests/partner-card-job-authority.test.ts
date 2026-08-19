/**
 * P4 — GRADING CREDIT AUTHORITY, proven against real PostgreSQL.
 *
 * The rule under test: ONE usable Grading Credit authorises EXACTLY ONE new Card Job.
 *
 * Every assertion here runs against a disposable PostgreSQL 17 cluster with the realistic role model
 * (non-superuser migrator, NOBYPASSRLS runtime), never a mock. A mocked database cannot prove the two
 * properties that matter most — that a wallet row lock actually serialises two concurrent starts, and
 * that RLS actually refuses a cross-tenant read.
 *
 * The concurrency cases deliberately use SEPARATE POOL CONNECTIONS running genuinely in parallel via
 * Promise.all. Two sequential calls would pass even if the locking were completely broken, so a
 * sequential "concurrency test" would be worse than none: it would report green while proving nothing.
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
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
/** Ambient DB env captured in beforeAll and restored in afterAll — see the note there. */
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };

interface Fixture {
  tenantId: string;
  locationId: string;
  userId: string;
  stationId: string;
  submissionId: string;
  cardId: string;
}

/**
 * Migration 0010 GRANTS on these MintVault-internal tables, and every migration runs as the
 * non-superuser `pn_migrator` under the realistic role model — so the tables must be OWNED by that
 * role or the grant fails with "permission denied for table users". Same shape and same ownership
 * transfer as the sibling credit-lifecycle suite.
 */
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

async function makeTenant(label: string): Promise<Fixture> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}`, `${label} Ltd`]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`loc-${label}`, tenantId, `${label} Shop`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}`, tenantId, `${label}@shop.test`]
    )
  ).rows[0].id;
  const submissionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
       VALUES ($1,$2,$3,1,'draft') RETURNING id`,
      [tenantId, locationId, userId]
    )
  ).rows[0].id;
  const cardId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name,quantity)
       VALUES ($1,$2,1,'Charizard',4) RETURNING id`,
      [tenantId, submissionId]
    )
  ).rows[0].id;
  // partner_stations may be absent from this migration list; the authority guards for that. Use a
  // synthetic station id so the (station_id, client_op_id) contract is still exercised end to end.
  const stationId = (await admin.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  return { tenantId, locationId, userId, stationId, submissionId, cardId };
}

async function addCredits(tenantId: string, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, tenantId);
  if (amount > 0) {
    await wallet.appendFoundationCredit(adminActor, {
      tenantId,
      amount,
      entryType: "purchase",
      source: "admin",
      reason: "P4 authority test credits",
      idempotencyKey: key,
      actorType: "admin",
    });
  }
}

async function availableFor(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ available: string }>(
    `SELECT available_balance::text AS available FROM partner_credit_availability WHERE tenant_id=$1`,
    [tenantId]
  );
  return Number(rows[0]?.available ?? 0);
}

function start(f: Fixture, opts: { clientOpId: string; ordinal?: number; stationId?: string }) {
  return authority.startNewCardJob({
    tenantId: f.tenantId,
    locationId: f.locationId,
    stationId: opts.stationId ?? f.stationId,
    clientOpId: opts.clientOpId,
    submissionId: f.submissionId,
    cardId: f.cardId,
    ordinal: opts.ordinal ?? 1,
    actorUserId: f.userId,
    actorEmail: "operator@shop.test",
  });
}

/** Settled outcome of a race participant, reduced to what the assertions care about. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

describe("P4 Grading Credit authority (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-card-job-authority");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);
    /*
     * Capture the ambient DB environment before pointing it at this disposable cluster, and restore
     * it in afterAll. Vitest may share a process across test FILES, so leaving these variables
     * pointing at a cluster that has since been stopped makes every later partner suite 503 — the
     * partner surface fails closed when its runtime DB is unreachable, which is correct behaviour
     * reported as someone else's failure. Observed exactly that: this file sorts before
     * partner-lockout-recovery, which went from 7 failures to 16 purely from the leak.
     */
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    wallet = await import("../server/partner/partner-wallet-service");
    authority = await import("../server/partner/card-job-authority");
    await admin.query(
      `INSERT INTO partner_feature_flags (flag,tenant_id,location_id,enabled)
       VALUES ('partner_emergency_stop',NULL,NULL,false)`
    );
  }, 180_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    // Restore the ambient environment so no later test file inherits a pointer to a stopped cluster.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("spends exactly one Grading Credit and creates exactly one Card Job", async () => {
    const f = await makeTenant("one");
    await addCredits(f.tenantId, 3, "one-seed");
    expect(await availableFor(f.tenantId)).toBe(3);

    const r = await start(f, { clientOpId: "op-one-0000001" });
    expect(r.replayed).toBe(false);
    // A NEW job legitimately has no identity yet — the connector allocates it later.
    expect(r.mvNumber).toBeNull();
    expect(r.certificateId).toBeNull();
    expect(r.status).toBe("CREDIT_RESERVED");

    expect(await availableFor(f.tenantId)).toBe(2); // exactly one unit of capacity removed
    const jobs = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM partner_card_jobs WHERE tenant_id=$1`, [
      f.tenantId,
    ]);
    expect(jobs.rows[0].n).toBe("1");
  });

  it("REPLAY: the same (station, client_op_id) returns the same job and spends nothing further", async () => {
    const f = await makeTenant("replay");
    await addCredits(f.tenantId, 2, "replay-seed");

    const first = await start(f, { clientOpId: "op-replay-00001" });
    const afterFirst = await availableFor(f.tenantId);

    // Five retries, exactly as a station would on a dropped ack / double-click / restart.
    for (let i = 0; i < 5; i++) {
      const again = await start(f, { clientOpId: "op-replay-00001" });
      expect(again.replayed).toBe(true);
      expect(again.cardJobId).toBe(first.cardJobId); // same Card Job
      expect(again.reservationId).toBe(first.reservationId); // same reservation lineage
    }

    expect(await availableFor(f.tenantId)).toBe(afterFirst); // no second credit spent
    const counts = await admin.query<{ jobs: string; reservations: string; ops: string }>(
      `SELECT (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1)::text AS jobs,
              (SELECT count(*) FROM partner_credit_reservations WHERE tenant_id=$1)::text AS reservations,
              (SELECT count(*) FROM partner_card_job_op_keys WHERE tenant_id=$1)::text AS ops`,
      [f.tenantId]
    );
    expect(counts.rows[0]).toEqual({ jobs: "1", reservations: "1", ops: "1" });
  });

  it("refuses a reused client_op_id carrying DIFFERENT parameters", async () => {
    const f = await makeTenant("conflict");
    await addCredits(f.tenantId, 3, "conflict-seed");
    await start(f, { clientOpId: "op-conflict-001", ordinal: 1 });
    // Same op id, different unit — a client bug or an attack, never a retry.
    await expect(start(f, { clientOpId: "op-conflict-001", ordinal: 2 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("LAST CREDIT RACE: two simultaneous starts on 1 credit yield exactly one winner", async () => {
    const f = await makeTenant("race");
    await addCredits(f.tenantId, 1, "race-seed");
    expect(await availableFor(f.tenantId)).toBe(1);

    // Genuinely parallel, on separate pool connections and separate card units, so the ONLY thing
    // that can serialise them is the wallet row lock inside the credit engine.
    const [a, b] = await Promise.all([
      settle(start(f, { clientOpId: "op-race-a-0001", ordinal: 1 })),
      settle(start(f, { clientOpId: "op-race-b-0001", ordinal: 2 })),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok) as Array<{ ok: false; code: string }>;
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].code).toBe("INSUFFICIENT_CREDITS");

    // Capacity must land at exactly zero and never below it.
    expect(await availableFor(f.tenantId)).toBe(0);
    const counts = await admin.query<{ jobs: string; active: string }>(
      `SELECT (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1)::text AS jobs,
              (SELECT count(*) FROM partner_credit_reservations
                WHERE tenant_id=$1 AND status='active')::text AS active`,
      [f.tenantId]
    );
    expect(counts.rows[0]).toEqual({ jobs: "1", active: "1" });
  });

  it("LAST CREDIT RACE across TWO STATIONS and TWO USERS still yields exactly one winner", async () => {
    const f = await makeTenant("race2");
    await addCredits(f.tenantId, 1, "race2-seed");
    const stationB = (await admin.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;

    const [a, b] = await Promise.all([
      settle(start(f, { clientOpId: "op-r2-station-a", ordinal: 1 })),
      settle(start(f, { clientOpId: "op-r2-station-b", ordinal: 2, stationId: stationB })),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok)).toHaveLength(1);
    expect(await availableFor(f.tenantId)).toBe(0);
  });

  it("CONCURRENT RETRY of the SAME operation creates one job, not two", async () => {
    const f = await makeTenant("dbl");
    await addCredits(f.tenantId, 5, "dbl-seed");
    const before = await availableFor(f.tenantId);

    // A genuine double-click: the same client_op_id dispatched twice, simultaneously.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => settle(start(f, { clientOpId: "op-double-click1" })))
    );
    const ok = results.filter((r) => r.ok) as Array<{ ok: true; value: { cardJobId: string } }>;
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Whatever interleaving occurred, every success names the SAME Card Job...
    const distinctJobs = new Set(ok.map((r) => r.value.cardJobId));
    expect(distinctJobs.size).toBe(1);
    // ...and exactly one credit was spent in total.
    expect(await availableFor(f.tenantId)).toBe(before - 1);
    const counts = await admin.query<{ jobs: string; ops: string }>(
      `SELECT (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1)::text AS jobs,
              (SELECT count(*) FROM partner_card_job_op_keys WHERE tenant_id=$1)::text AS ops`,
      [f.tenantId]
    );
    expect(counts.rows[0]).toEqual({ jobs: "1", ops: "1" });
  });

  it("ZERO credits rejects NEW server-side", async () => {
    const f = await makeTenant("zero");
    await addCredits(f.tenantId, 0, "zero-seed"); // wallet exists, no credits
    await expect(start(f, { clientOpId: "op-zero-000001" })).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
    });
    const jobs = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM partner_card_jobs WHERE tenant_id=$1`, [
      f.tenantId,
    ]);
    expect(jobs.rows[0].n).toBe("0");
    expect(await availableFor(f.tenantId)).toBe(0); // never negative
  });

  it("ZERO credits rejects a 20-click NEW spray with no Card Jobs, reservations or MV identities", async () => {
    const f = await makeTenant("zero-spray");
    await addCredits(f.tenantId, 0, "zero-spray-seed"); // wallet exists, no credits
    await admin.query(`UPDATE partner_submission_cards SET quantity=20 WHERE id=$1`, [f.cardId]);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        settle(start(f, { clientOpId: `op-zero-spray-${String(i).padStart(3, "0")}`, ordinal: i + 1 }))
      )
    );

    expect(results.every((r) => !r.ok && r.code === "INSUFFICIENT_CREDITS")).toBe(true);
    expect(await availableFor(f.tenantId)).toBe(0);
    const counts = await admin.query<{
      jobs: string;
      reservations: string;
      ops: string;
      mv_numbers: string;
    }>(
      `SELECT (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1)::text AS jobs,
              (SELECT count(*) FROM partner_credit_reservations WHERE tenant_id=$1)::text AS reservations,
              (SELECT count(*) FROM partner_card_job_op_keys WHERE tenant_id=$1)::text AS ops,
              (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1 AND mv_number IS NOT NULL)::text AS mv_numbers`,
      [f.tenantId]
    );
    expect(counts.rows[0]).toEqual({ jobs: "0", reservations: "0", ops: "0", mv_numbers: "0" });
  });

  it("ONE credit under a 100-way NEW race yields exactly one authorised Card Job", async () => {
    const f = await makeTenant("hundred-way");
    await addCredits(f.tenantId, 1, "hundred-way-seed");
    await admin.query(`UPDATE partner_submission_cards SET quantity=100 WHERE id=$1`, [f.cardId]);

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        settle(start(f, { clientOpId: `op-hundred-way-${String(i).padStart(3, "0")}`, ordinal: i + 1 }))
      )
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok) as Array<{ ok: false; code: string }>;
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(99);
    expect(losers.every((r) => r.code === "INSUFFICIENT_CREDITS")).toBe(true);
    expect(await availableFor(f.tenantId)).toBe(0);
    const counts = await admin.query<{
      jobs: string;
      reservations: string;
      active: string;
      mv_numbers: string;
    }>(
      `SELECT (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1)::text AS jobs,
              (SELECT count(*) FROM partner_credit_reservations WHERE tenant_id=$1)::text AS reservations,
              (SELECT count(*) FROM partner_credit_reservations WHERE tenant_id=$1 AND status='active')::text AS active,
              (SELECT count(*) FROM partner_card_jobs WHERE tenant_id=$1 AND mv_number IS NOT NULL)::text AS mv_numbers`,
      [f.tenantId]
    );
    expect(counts.rows[0]).toEqual({ jobs: "1", reservations: "1", active: "1", mv_numbers: "0" });
  });

  it("SUSPENSION overrides remaining credits", async () => {
    const f = await makeTenant("susp");
    await addCredits(f.tenantId, 10, "susp-seed"); // plenty of credits
    await admin.query(`UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1`, [f.tenantId]);

    await expect(start(f, { clientOpId: "op-susp-000001" })).rejects.toMatchObject({
      code: "ORGANISATION_NOT_ACTIVE",
    });
    // The credits are untouched — suspension blocks the operation, it does not consume capacity.
    expect(await availableFor(f.tenantId)).toBe(10);
  });

  it("EMERGENCY STOP overrides remaining credits", async () => {
    const f = await makeTenant("estop");
    await addCredits(f.tenantId, 10, "estop-seed");
    await admin.query(
      `INSERT INTO partner_emergency_controls (tenant_id, scope, frozen, reason, set_by)
       VALUES ($1,'partner',true,'incident drill','ops@mintvault.test')`,
      [f.tenantId]
    );

    await expect(start(f, { clientOpId: "op-estop-00001" })).rejects.toMatchObject({
      code: "EMERGENCY_STOP",
    });
    expect(await availableFor(f.tenantId)).toBe(10);
  });

  it("the idempotency record is append-only and tenant-isolated", async () => {
    const f = await makeTenant("append");
    await addCredits(f.tenantId, 2, "append-seed");
    const r = await start(f, { clientOpId: "op-append-0001" });

    // Write-once: neither an UPDATE nor a DELETE may rewrite recorded evidence, even as owner.
    await expect(
      admin.query(`UPDATE partner_card_job_op_keys SET client_op_id='tampered' WHERE card_job_id=$1`, [r.cardJobId])
    ).rejects.toThrow(/append-only/i);
    await expect(
      admin.query(`DELETE FROM partner_card_job_op_keys WHERE card_job_id=$1`, [r.cardJobId])
    ).rejects.toThrow(/append-only/i);

    // A second tenant cannot reach the first tenant's operation records through the runtime role.
    const other = await makeTenant("append-b");
    const runtime = new Client({ connectionString: cluster.url });
    await runtime.connect();
    try {
      await runtime.query("SET ROLE partner_runtime");
      await runtime.query("SELECT set_config('app.tenant_id', $1, false)", [other.tenantId]);
      const seen = await runtime.query<{ n: string }>(`SELECT count(*)::text n FROM partner_card_job_op_keys`);
      expect(seen.rows[0].n).toBe("0"); // tenant B sees none of tenant A's operations
    } finally {
      await runtime.end();
    }
  });

  it("does NOT block work on already-authorised Card Jobs when credits hit zero", async () => {
    const f = await makeTenant("after");
    await addCredits(f.tenantId, 1, "after-seed");
    const r = await start(f, { clientOpId: "op-after-00001" });
    expect(await availableFor(f.tenantId)).toBe(0);

    // A further NEW is refused...
    await expect(start(f, { clientOpId: "op-after-00002", ordinal: 2 })).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
    });

    // ...but the already-paid job keeps its reservation and can still advance its lifecycle, which
    // is what "zero credits blocks NEW only" means in practice.
    await admin.query(`UPDATE partner_card_jobs SET status='NEEDS_SCAN' WHERE id=$1`, [r.cardJobId]);
    const job = await admin.query<{ status: string; reservation_id: string | null }>(
      `SELECT status, reservation_id FROM partner_card_jobs WHERE id=$1`,
      [r.cardJobId]
    );
    expect(job.rows[0].status).toBe("NEEDS_SCAN");
    expect(job.rows[0].reservation_id).toBe(r.reservationId);
  });
});
