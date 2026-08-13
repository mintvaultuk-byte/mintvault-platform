/**
 * P6 — SCANNER "NEW CARD", proven against real PostgreSQL.
 *
 * The rule under test is P4's, now reachable from where it is actually pressed: ONE usable Grading
 * Credit authorises EXACTLY ONE new Card Job — and, on this path, exactly one permanent MV number.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM partner-card-job-authority.test.ts. That suite proves the
 * credit contract against a card unit the TEST created by hand. This one proves the contract when
 * the SERVER creates the unit, which is what an operator at a counter actually does — and that is a
 * materially harder problem, because a failed or retried NEW must not leave behind an orphan
 * submission, an orphan card, or a burned MV number. Those failure modes simply cannot occur in the
 * portal path and so cannot be caught by that suite.
 *
 * A MOCKED DATABASE WOULD PROVE NOTHING HERE. The three properties that matter most are all
 * PostgreSQL behaviours: the wallet row lock serialising two simultaneous NEW presses, the
 * `cert_counter` row lock keeping MV numbers gapless under contention, and RLS refusing a
 * cross-tenant read. Every concurrency case below therefore runs genuinely in parallel on SEPARATE
 * pool connections via Promise.all — a sequential "concurrency test" would pass with the locking
 * completely broken and would be worse than no test at all.
 *
 * Mutation targets: STATION-NEW1 (one credit -> one job -> one MV), STATION-NEW2 (replay creates
 * nothing), STATION-NEW3 (last-credit race), STATION-NEW4 (rollback burns no MV).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
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
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };

interface Fixture {
  tenantId: string;
  locationId: string;
  userId: string;
  stationId: string;
}

/**
 * The MintVault-internal tables the partner migrations GRANT on, plus the two this path needs that
 * the P4 fixture does not: `certificates` and `cert_counter`. They are seeded with the columns the
 * NEW transaction actually writes — including the origin snapshot columns and the PARTNER-complete
 * CHECK — so the constraint that guards provenance is genuinely exercised rather than assumed away.
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
  await admin.query(`CREATE TABLE certificates (
    id serial primary key,
    certificate_number text not null unique,
    -- Both nullable, and both load-bearing here: migration 0041 installs
    -- partner_certificate_credit_hold_guard as a trigger on this table which reads NEW.card_id and
    -- NEW.submission_item_id. Omitting them makes every INSERT fail with
    -- 'record "new" has no field "card_id"'. A walk-in card leaves both NULL, so the guard resolves
    -- no destination submission and correctly declines to block.
    card_id integer,
    submission_item_id integer,
    status text not null default 'active',
    label_type text not null default 'Standard',
    grade_type text not null default 'numeric',
    source text,
    scan_status text,
    raw_uploaded boolean not null default false,
    created_by text,
    issued_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    origin_type text,
    origin_partner_id uuid,
    origin_partner_public_ref text,
    origin_partner_legal_name text,
    origin_partner_trading_name text,
    origin_location_id uuid,
    origin_location_public_ref text,
    origin_location_name text,
    origin_location_address text,
    origin_captured_at timestamptz,
    origin_snapshot_version integer,
    CONSTRAINT chk_certificates_origin_partner_complete CHECK (
      origin_type IS DISTINCT FROM 'PARTNER'
      OR (origin_partner_id IS NOT NULL
          AND (btrim(coalesce(origin_partner_trading_name,'')) <> ''
               OR btrim(coalesce(origin_partner_legal_name,'')) <> '')
          AND origin_captured_at IS NOT NULL
          AND origin_snapshot_version IS NOT NULL)
    )
  )`);
  // The gapless allocator: a LOCKED ROW, never a sequence. This shape is what makes a rolled-back
  // NEW return its number instead of burning it, which STATION-NEW4 below proves.
  await admin.query(`CREATE TABLE cert_counter (
    id integer primary key, last_issued bigint not null default 0, updated_at timestamptz not null default now()
  )`);
  await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)");
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "cert_counter"]) {
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
  // The trading name lives on partner_profiles (0015), not on the organisation — the distinction
  // that migration 0035 relies on when it names legal_name as the origin fallback.
  await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [
    tenantId,
    `${label} Cards`,
  ]);
  const locationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
       VALUES ($1,$2,$2,$3,$4,'ACTIVE') RETURNING id`,
      [`loc-${label}`, tenantId, `${label} Shop`, "1 High Street"]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}`, tenantId, `${label}@shop.test`]
    )
  ).rows[0].id;
  const stationId = (await admin.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  return { tenantId, locationId, userId, stationId };
}

async function addCredits(tenantId: string, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, tenantId);
  if (amount > 0) {
    await wallet.appendFoundationCredit(adminActor, {
      tenantId,
      amount,
      entryType: "purchase",
      source: "admin",
      reason: "P6 station NEW test credits",
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

async function counterValue(): Promise<number> {
  const { rows } = await admin.query<{ last_issued: string }>(`SELECT last_issued::text FROM cert_counter WHERE id=1`);
  return Number(rows[0].last_issued);
}

function start(f: Fixture, opts: { clientOpId: string; stationId?: string; cardName?: string }) {
  return authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId: f.locationId,
    stationId: opts.stationId ?? f.stationId,
    clientOpId: opts.clientOpId,
    actorUserId: f.userId,
    actorEmail: "operator@shop.test",
    cardName: opts.cardName ?? null,
  });
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

describe("P6 Scanner NEW CARD (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-station-new-card");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);
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
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ---- STATION-NEW1 -----------------------------------------------------------------------
  it("spends one credit and returns a complete Card Job with a permanent MV", async () => {
    const f = await makeTenant("new1");
    await addCredits(f.tenantId, 1, "new1");

    const result = await start(f, { clientOpId: "op-new1-aaaa" });

    expect(result.replayed).toBe(false);
    expect(result.mvNumber).toMatch(/^MV\d+$/);
    expect(result.certificateId).toBeGreaterThan(0);
    expect(result.sides).toEqual(["front", "back"]);
    expect(await availableFor(f.tenantId)).toBe(0);

    // The card unit was created by the SERVER, and the job is born complete: identity paired,
    // reservation attached, ready for capture rather than needing a later stamping step.
    const job = await admin.query(
      `SELECT status, mv_number, certificate_id, reservation_id, submission_id, card_id, location_id
         FROM partner_card_jobs WHERE id=$1`,
      [result.cardJobId]
    );
    expect(job.rows[0].status).toBe("NEEDS_SCAN");
    expect(job.rows[0].mv_number).toBe(result.mvNumber);
    expect(job.rows[0].certificate_id).toBe(result.certificateId);
    expect(job.rows[0].reservation_id).toBe(result.reservationId);
    expect(job.rows[0].location_id).toBe(f.locationId);

    const cards = await admin.query(
      `SELECT card_name, sequence_number, quantity FROM partner_submission_cards WHERE submission_id=$1`,
      [result.submissionId]
    );
    expect(cards.rowCount).toBe(1);
    expect(cards.rows[0].card_name).toBe("Unidentified card");

    // A walk-in submission carries no customer and no service tier — that is the point (OD-7).
    const sub = await admin.query(
      `SELECT customer_id, service_tier_code, card_count FROM partner_submissions WHERE id=$1`,
      [result.submissionId]
    );
    expect(sub.rows[0].customer_id).toBeNull();
    expect(sub.rows[0].service_tier_code).toBeNull();
    expect(sub.rows[0].card_count).toBe(1);
  });

  it("stamps an immutable PARTNER origin snapshot on the certificate", async () => {
    const f = await makeTenant("origin1");
    await addCredits(f.tenantId, 1, "origin1");
    const result = await start(f, { clientOpId: "op-origin1-aaa" });

    const cert = await admin.query(
      `SELECT certificate_number, origin_type, origin_partner_id, origin_partner_trading_name,
              origin_location_id, origin_location_name, origin_snapshot_version
         FROM certificates WHERE id=$1`,
      [result.certificateId]
    );
    expect(cert.rows[0].certificate_number).toBe(result.mvNumber);
    expect(cert.rows[0].origin_type).toBe("PARTNER");
    expect(cert.rows[0].origin_partner_id).toBe(f.tenantId);
    expect(cert.rows[0].origin_partner_trading_name).toBe("origin1 Cards");
    expect(cert.rows[0].origin_location_id).toBe(f.locationId);
    expect(cert.rows[0].origin_snapshot_version).toBe(1);
  });

  it("records the operator's chosen card label when one is supplied", async () => {
    const f = await makeTenant("label1");
    await addCredits(f.tenantId, 1, "label1");
    const result = await start(f, { clientOpId: "op-label1-aaa", cardName: "Charizard 1999 Base Set" });
    const cards = await admin.query(`SELECT card_name FROM partner_submission_cards WHERE submission_id=$1`, [
      result.submissionId,
    ]);
    expect(cards.rows[0].card_name).toBe("Charizard 1999 Base Set");
  });

  // ---- STATION-NEW2 -----------------------------------------------------------------------
  it("REPLAY: the same (station, client_op_id) returns the same job, MV and lineage, spending nothing", async () => {
    const f = await makeTenant("new2");
    await addCredits(f.tenantId, 5, "new2");

    const first = await start(f, { clientOpId: "op-new2-aaaa" });
    const afterFirst = await availableFor(f.tenantId);
    const submissionsAfterFirst = await admin.query(
      `SELECT count(*)::int AS n FROM partner_submissions WHERE tenant_id=$1`,
      [f.tenantId]
    );

    for (let i = 0; i < 5; i += 1) {
      const replay = await start(f, { clientOpId: "op-new2-aaaa" });
      expect(replay.replayed).toBe(true);
      expect(replay.cardJobId).toBe(first.cardJobId);
      expect(replay.mvNumber).toBe(first.mvNumber);
      expect(replay.certificateId).toBe(first.certificateId);
      expect(replay.reservationId).toBe(first.reservationId);
    }

    // Nothing further spent, and — the failure mode unique to this path — no orphan submissions,
    // no orphan cards and no burned MV numbers left behind by the retries.
    expect(await availableFor(f.tenantId)).toBe(afterFirst);
    const submissionsAfterReplays = await admin.query(
      `SELECT count(*)::int AS n FROM partner_submissions WHERE tenant_id=$1`,
      [f.tenantId]
    );
    expect(submissionsAfterReplays.rows[0].n).toBe(submissionsAfterFirst.rows[0].n);
    const certs = await admin.query(`SELECT count(*)::int AS n FROM certificates WHERE origin_partner_id=$1`, [
      f.tenantId,
    ]);
    expect(certs.rows[0].n).toBe(1);
  });

  it("refuses a reused client_op_id carrying a DIFFERENT location", async () => {
    const f = await makeTenant("conflict1");
    await addCredits(f.tenantId, 3, "conflict1");
    await start(f, { clientOpId: "op-conflict1-a" });

    const otherLocation = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, status)
         VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
        [`loc-conflict1-b`, f.tenantId, "Second Shop"]
      )
    ).rows[0].id;

    const conflicted = await settle(
      authority.startNewCardJobAtStation({
        tenantId: f.tenantId,
        locationId: otherLocation,
        stationId: f.stationId,
        clientOpId: "op-conflict1-a",
        actorUserId: f.userId,
        actorEmail: "operator@shop.test",
      })
    );
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  // ---- STATION-NEW3 -----------------------------------------------------------------------
  it("LAST CREDIT RACE: two simultaneous NEW presses on one credit yield exactly one job and one MV", async () => {
    const f = await makeTenant("race1");
    await addCredits(f.tenantId, 1, "race1");
    const counterBefore = await counterValue();

    // Genuinely parallel, on separate pool connections. Sequential calls would pass even with the
    // wallet lock removed entirely.
    const [a, b] = await Promise.all([
      settle(start(f, { clientOpId: "op-race1-aaaa" })),
      settle(start(f, { clientOpId: "op-race1-bbbb" })),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { code: string }).code).toBe("INSUFFICIENT_CREDITS");
    expect(await availableFor(f.tenantId)).toBe(0);

    // Exactly one Card Job, and exactly one MV consumed — the loser's rollback returned its number.
    const jobs = await admin.query(`SELECT count(*)::int AS n FROM partner_card_jobs WHERE tenant_id=$1`, [f.tenantId]);
    expect(jobs.rows[0].n).toBe(1);
    expect(await counterValue()).toBe(counterBefore + 1);
  });

  it("LAST CREDIT RACE across TWO STATIONS still yields exactly one winner", async () => {
    const f = await makeTenant("race2");
    await addCredits(f.tenantId, 1, "race2");
    const second = (await admin.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;

    const [a, b] = await Promise.all([
      settle(start(f, { clientOpId: "op-race2-aaaa" })),
      settle(start(f, { clientOpId: "op-race2-bbbb", stationId: second })),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(await availableFor(f.tenantId)).toBe(0);
  });

  it("CONCURRENT double-click of the SAME operation creates one job, not two", async () => {
    const f = await makeTenant("dbl1");
    await addCredits(f.tenantId, 5, "dbl1");

    const results = await Promise.all([
      settle(start(f, { clientOpId: "op-dbl1-aaaa" })),
      settle(start(f, { clientOpId: "op-dbl1-aaaa" })),
      settle(start(f, { clientOpId: "op-dbl1-aaaa" })),
      settle(start(f, { clientOpId: "op-dbl1-aaaa" })),
    ]);

    const successes = results.filter((r): r is { ok: true; value: Awaited<ReturnType<typeof start>> } => r.ok);
    expect(successes.length).toBeGreaterThan(0);
    const ids = new Set(successes.map((r) => r.value.cardJobId));
    const mvs = new Set(successes.map((r) => r.value.mvNumber));
    expect(ids.size).toBe(1);
    expect(mvs.size).toBe(1);
    expect(await availableFor(f.tenantId)).toBe(4);
  });

  // ---- STATION-NEW4 -----------------------------------------------------------------------
  it("a refused NEW burns no MV number and leaves no partial card unit", async () => {
    const f = await makeTenant("burn1");
    await addCredits(f.tenantId, 0, "burn1");
    const counterBefore = await counterValue();

    const refused = await settle(start(f, { clientOpId: "op-burn1-aaaa" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("INSUFFICIENT_CREDITS");

    // The whole transaction rolled back: no MV consumed, no submission, no card, no certificate.
    expect(await counterValue()).toBe(counterBefore);
    const subs = await admin.query(`SELECT count(*)::int AS n FROM partner_submissions WHERE tenant_id=$1`, [
      f.tenantId,
    ]);
    expect(subs.rows[0].n).toBe(0);
    const certs = await admin.query(`SELECT count(*)::int AS n FROM certificates WHERE origin_partner_id=$1`, [
      f.tenantId,
    ]);
    expect(certs.rows[0].n).toBe(0);
  });

  it("ZERO credits rejects NEW server-side regardless of what any UI believes", async () => {
    const f = await makeTenant("zero1");
    await addCredits(f.tenantId, 0, "zero1");
    const refused = await settle(start(f, { clientOpId: "op-zero1-aaaa" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("SUSPENSION overrides remaining credits", async () => {
    const f = await makeTenant("susp1");
    await addCredits(f.tenantId, 5, "susp1");
    await admin.query(`UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1`, [f.tenantId]);

    const refused = await settle(start(f, { clientOpId: "op-susp1-aaaa" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("ORGANISATION_NOT_ACTIVE");
    // Credits untouched — a suspension is not a charge.
    expect(await availableFor(f.tenantId)).toBe(5);
  });

  it("EMERGENCY STOP overrides remaining credits", async () => {
    const f = await makeTenant("estop1");
    await addCredits(f.tenantId, 5, "estop1");
    // The emergency freeze lives in partner_emergency_controls, which is what readEmergencyState
    // consults. The `partner_emergency_stop` FEATURE FLAG is a different, global mechanism — setting
    // that one here would leave the tenant unfrozen and the test would pass a card through.
    await admin.query(
      `INSERT INTO partner_emergency_controls (tenant_id, scope, frozen, reason, set_by)
       VALUES ($1,'partner',true,'incident drill','ops@mintvault.test')`,
      [f.tenantId]
    );

    const refused = await settle(start(f, { clientOpId: "op-estop1-aaa" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("EMERGENCY_STOP");
    expect(await availableFor(f.tenantId)).toBe(5);
  });

  // ---- MV number discipline ----------------------------------------------------------------
  it("MV numbers are unique and monotonic across many NEW presses", async () => {
    const f = await makeTenant("mv1");
    await addCredits(f.tenantId, 6, "mv1");

    const issued: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await start(f, { clientOpId: `op-mv1-${String(i).padStart(4, "0")}` });
      issued.push(r.mvNumber);
    }

    expect(new Set(issued).size).toBe(6);
    const numeric = issued.map((mv) => Number(mv.replace("MV", "")));
    for (let i = 1; i < numeric.length; i += 1) expect(numeric[i]).toBe(numeric[i - 1] + 1);
    expect(await availableFor(f.tenantId)).toBe(0);
  });

  it("one MV never binds to two Card Jobs, enforced by the database", async () => {
    const f = await makeTenant("dup1");
    await addCredits(f.tenantId, 2, "dup1");
    const a = await start(f, { clientOpId: "op-dup1-aaaa" });
    const b = await start(f, { clientOpId: "op-dup1-bbbb" });
    expect(a.mvNumber).not.toBe(b.mvNumber);

    // Attempting to re-point one job at the other's certificate must be refused outright.
    await expect(
      admin.query(`UPDATE partner_card_jobs SET certificate_id=$1 WHERE id=$2`, [a.certificateId, b.cardJobId])
    ).rejects.toThrow(/immutable once allocated/i);
  });

  // ---- Tenant isolation --------------------------------------------------------------------
  it("Partner A's station cannot start a card against Partner B", async () => {
    const a = await makeTenant("iso-a");
    const b = await makeTenant("iso-b");
    await addCredits(a.tenantId, 5, "iso-a");
    await addCredits(b.tenantId, 5, "iso-b");

    // A's station id paired with B's tenant is not a request the route can produce — tenant and
    // station both come from the authenticated principals — but the authority must still refuse it.
    const crossed = await settle(
      authority.startNewCardJobAtStation({
        tenantId: b.tenantId,
        locationId: a.locationId, // A's location, B's tenant
        stationId: a.stationId,
        clientOpId: "op-iso-cross1",
        actorUserId: b.userId,
        actorEmail: "operator@shop.test",
      })
    );
    expect(crossed.ok).toBe(false);
    // Both wallets untouched whichever guard fired first.
    expect(await availableFor(a.tenantId)).toBe(5);
    expect(await availableFor(b.tenantId)).toBe(5);
  });

  it("does NOT block work on already-authorised cards when credits hit zero", async () => {
    const f = await makeTenant("auth1");
    await addCredits(f.tenantId, 1, "auth1");
    const started = await start(f, { clientOpId: "op-auth1-aaaa" });
    expect(await availableFor(f.tenantId)).toBe(0);

    // The next NEW is refused...
    const refused = await settle(start(f, { clientOpId: "op-auth1-bbbb" }));
    expect(refused.ok).toBe(false);

    // ...while the card already paid for keeps its identity and can still advance.
    await admin.query(`UPDATE partner_card_jobs SET status='CAPTURING' WHERE id=$1`, [started.cardJobId]);
    const job = await admin.query(`SELECT status, mv_number FROM partner_card_jobs WHERE id=$1`, [started.cardJobId]);
    expect(job.rows[0].status).toBe("CAPTURING");
    expect(job.rows[0].mv_number).toBe(started.mvNumber);
  });

  it("rejects a client operation id that is missing or too short to be a real retry token", async () => {
    const f = await makeTenant("opid1");
    await addCredits(f.tenantId, 1, "opid1");
    for (const clientOpId of ["", "short"]) {
      const refused = await settle(start(f, { clientOpId }));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("CARD_UNIT_INVALID");
    }
    expect(await availableFor(f.tenantId)).toBe(1);
  });
});

/**
 * Source-level contract assertions for the surfaces around the authority.
 *
 * These are structural properties — "the route takes tenant from the authenticated station, never
 * the body", "the retry token is held across a retry". A request-level test can show that one
 * particular call behaved; it cannot show that no code path exists which behaves otherwise. Both
 * kinds of proof are needed and neither replaces the other.
 */
describe("P6 integration surfaces", () => {
  const stationRoutes = readFileSync("server/partner/station-routes.ts", "utf8");
  const captureService = readFileSync("server/scanner-capture-service.ts", "utf8");
  const scannerMain = readFileSync("scripts/scanner-app/main.js", "utf8");
  const scannerClient = readFileSync("scripts/scanner-app/lib/server-client.js", "utf8");
  const scannerHtml = readFileSync("scripts/scanner-app/renderer/index.html", "utf8");
  const scannerApp = readFileSync("scripts/scanner-app/renderer/app.js", "utf8");

  it("the NEW route demands BOTH an approved station and an authorised operator", () => {
    const route = stationRoutes.slice(stationRoutes.indexOf('r.post("/card-jobs"'));
    const body = route.slice(0, route.indexOf('r.post("/stations/calibrations"'));
    expect(body).toContain("requireSignedStation");
    expect(body).toContain("requireSignedStationOperator");
  });

  it("the NEW route takes tenant, location and station from the authenticated principals only", () => {
    const route = stationRoutes.slice(stationRoutes.indexOf('r.post("/card-jobs"'));
    const body = route.slice(0, route.indexOf('r.post("/stations/calibrations"'));
    expect(body).toContain("tenantId: station.tenantId");
    expect(body).toContain("locationId: station.locationId");
    expect(body).toContain("stationId: station.id");
    // A body-supplied tenant/location/station would let one shop start cards against another.
    expect(body).not.toMatch(/tenantId:\s*req\.body/);
    expect(body).not.toMatch(/locationId:\s*req\.body/);
    expect(body).not.toMatch(/stationId:\s*req\.body/);
  });

  it("insufficient credits is answered as 402, not a generic failure", () => {
    const route = stationRoutes.slice(stationRoutes.indexOf('r.post("/card-jobs"'));
    const body = route.slice(0, route.indexOf('r.post("/stations/calibrations"'));
    expect(body).toMatch(/INSUFFICIENT_CREDITS"?\s*\?\s*402/);
    expect(body).toMatch(/IDEMPOTENCY_CONFLICT"?\s*\n?\s*\?\s*409/);
  });

  it("the walk-in binding is an ADDITIONAL tenant check, not a relaxation of the existing one", () => {
    // The connector-import join must survive: it is what binds portal-originated certificates.
    expect(captureService).toContain("partner_connector_imports");
    // The new path demands the same tenant AND location facts through the Card Job instead.
    expect(captureService).toContain("partner_card_jobs job");
    expect(captureService).toMatch(/job\.tenant_id=station\.tenant_id/);
    expect(captureService).toMatch(/job\.location_id=station\.location_id/);
    expect(captureService).toContain("station.status='ACTIVE'");
    // And the refusal is still reached when neither path binds.
    expect(captureService).toContain("Certificate is not bound to this station's tenant and location");
  });

  it("the Scanner holds ONE retry token across retries of a single press", () => {
    expect(scannerMain).toContain("pendingNewCardOpId");
    // Reused when already set — a fresh id per retry is how a shop gets charged twice.
    expect(scannerMain).toContain("if (!pendingNewCardOpId) pendingNewCardOpId =");
    // A transport failure keeps the token, because the outcome is unknown.
    expect(scannerMain).toMatch(/catch[\s\S]{0,200}retryable: true/);
    expect(scannerClient).toContain("startNewCard");
    expect(scannerClient).toContain('postJson("/api/partner/card-jobs"');
  });

  it("the Scanner never invents an MV number", () => {
    // No client-side derivation of identity anywhere in the NEW/complete path.
    expect(scannerApp).not.toMatch(/last(Issued|Cert)\s*\+\s*1/);
    expect(scannerApp).not.toMatch(/nextCertOverride/);
    // The completion screen echoes the server's certId verbatim.
    expect(scannerApp).toContain("${completedCert} COMPLETE");
    expect(scannerApp).toContain("MARK CARD ${completedCert}");
  });

  it("the Scanner shows the operational identity the shop needs, and never fakes a credit balance", () => {
    expect(scannerHtml).toContain('id="newCardBtn"');
    expect(scannerHtml).toContain('id="cardCompletePanel"');
    expect(scannerHtml).toContain('id="stationCredits"');
    // An unanswered balance renders as an em dash, never as 0.
    expect(scannerApp).toContain('typeof credits === "number" ? String(credits) : "—"');
    expect(scannerApp).not.toMatch(/availableCredits\s*\|\|\s*0/);
  });
});
