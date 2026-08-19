/**
 * P13 — LOAD AND CONCURRENCY. Correctness outranks throughput.
 *
 * WHAT THIS IS FOR. Every invariant in the Partner pilot that can only break under contention. Each
 * case below drives GENUINELY PARALLEL work through `Promise.all` on SEPARATE POOL CONNECTIONS —
 * run sequentially they would all pass with the locking removed entirely, which is worse than having
 * no test at all.
 *
 * THE ZERO-TOLERANCE LIST, checked here rather than asserted in a plan:
 *   - never a negative Grading Credit balance
 *   - never two paid Card Jobs for one credit
 *   - never a duplicate MV number
 *   - never a duplicate certificate identity for one Card Job
 *   - never a duplicate credit settlement
 *   - never a cross-tenant or cross-location read/write
 *   - never a silent grading overwrite (two graders both saving)
 *   - never premature printable output
 *   - never process-local authority (every guarantee is a database one)
 *
 * WHY NOT A THROUGHPUT BENCHMARK. A latency number measured on one laptop against a container tells
 * nobody anything about a shop floor, and tuning to it would be optimising a fiction. What DOES
 * transfer is whether the contention points serialise correctly: the wallet row lock, the
 * `cert_counter` row lock, the lease's partial unique index, the Card Job's FOR UPDATE, and the
 * credit engine's idempotency uniqueness. Those are what this measures, and they hold or they do not.
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
import type { PartnerPrincipal } from "../server/partner/session";

let cluster: DisposablePostgres17;
/*
 * A POOL, not a Client.
 *
 * A single pg `Client` multiplexes nothing: two overlapping `client.query()` calls are a deprecation
 * warning today and interleaved protocol traffic tomorrow. This suite exists to run work genuinely in
 * parallel, so its own fixture connection must be able to as well — otherwise the harness is the
 * bottleneck being measured rather than the database's locking.
 */
let admin: Pool;
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
let lifecycle: typeof import("../server/partner/card-job-lifecycle");
let bridge: typeof import("../server/partner/card-job-grading-bridge");
let leases: typeof import("../server/partner/grading-lease-service");
let reconciliation: typeof import("../server/partner/card-job-reconciliation");
let printEligibility: typeof import("../server/partner/print-eligibility");
let drizzle: typeof import("../server/db");
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };
const RUN_SALT = Math.random().toString(36).slice(2, 8);
let opSeq = 0;
let evidenceSeq = 0;

interface Fixture {
  label: string;
  tenantId: string;
  locationA: string;
  locationB: string;
  graderOne: string;
  graderTwo: string;
  owner: string;
  stationA: string;
  stationB: string;
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
  await admin.query(`CREATE TABLE scanner_capture_sessions (
    id text primary key,
    certificate_id integer not null references certificates(id) on delete restrict,
    card_id integer, submission_item_id integer, submission_id integer,
    side varchar(5) not null check (side in ('front','back')),
    workstation_id text not null, station_id uuid,
    scanner_profile_version text not null, actor_id text, state varchar(16) not null,
    claimed_by_device_id text, physical_released boolean not null default false,
    recapture boolean not null default false, failure_reason text,
    created_at timestamptz not null default now(), claimed_at timestamptz,
    captured_at timestamptz, expires_at timestamptz not null
  )`);
  await admin.query(`CREATE TABLE certificate_image_evidence (
    id serial primary key,
    certificate_id integer not null references certificates(id) on delete restrict,
    side varchar(5) not null check (side in ('front','back')),
    evidence_class varchar(32) not null, evidence_version varchar(32) not null default 'v1',
    object_key text not null unique, sha256 varchar(64) not null, byte_length bigint not null,
    pixel_width integer not null, pixel_height integer not null,
    bit_depth integer, dpi integer, format varchar(16) not null,
    capture_metadata jsonb not null default '{}'::jsonb,
    is_current boolean not null default true,
    superseded_at timestamptz, superseded_by_id integer,
    created_at timestamptz not null default now()
  )`);
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "cards",
    "audit_log",
    "cert_counter",
    "scanner_capture_sessions",
    "certificate_image_evidence",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function makeTenant(label: string): Promise<Fixture> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}-${RUN_SALT}`, `${label} Ltd`]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [
    tenantId,
    `${label} Cards`,
  ]);
  const mkLocation = async (tag: string, name: string) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
         VALUES ($1,$2,$2,$3,$4,'ACTIVE') RETURNING id`,
        [`loc-${label}-${tag}-${RUN_SALT}`, tenantId, name, "1 High Street"]
      )
    ).rows[0].id;
  const mkUser = async (tag: string) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
         VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
        [`usr-${label}-${tag}-${RUN_SALT}`, tenantId, `${tag}.${label}.${RUN_SALT}@shop.test`]
      )
    ).rows[0].id;
  const locationA = await mkLocation("a", `${label} Rochester`);
  const locationB = await mkLocation("b", `${label} Bluewater`);
  const base32 = (raw: string, n: number) =>
    raw
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, "2")
      .padEnd(n, "2")
      .slice(0, n);
  const mkStation = async (tag: string, locationId: string) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_stations
           (tenant_id, location_id, station_code, status, approved_at, public_key_pem, public_key_fingerprint)
         VALUES ($1,$2,$3,'ACTIVE', now(), $4, $5) RETURNING id`,
        [
          tenantId,
          locationId,
          `MV-STN-${base32(`${label}${tag}${RUN_SALT}`, 16)}`,
          "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----",
          `${label}${tag}${RUN_SALT}`
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "0")
            .padEnd(64, "0")
            .slice(0, 64),
        ]
      )
    ).rows[0].id;
  return {
    label,
    tenantId,
    locationA,
    locationB,
    graderOne: await mkUser("g1"),
    graderTwo: await mkUser("g2"),
    owner: await mkUser("owner"),
    stationA: await mkStation("a", locationA),
    stationB: await mkStation("b", locationB),
  };
}

function principal(
  f: Fixture,
  userId: string,
  opts: { orgWide?: boolean; locationId?: string } = {}
): PartnerPrincipal {
  return {
    sessionId: "00000000-0000-0000-0000-0000000000ff",
    tenantId: f.tenantId,
    userId,
    locationId: opts.locationId ?? f.locationA,
    mfaPassed: true,
    permissions: new Set(["partner.dashboard.view", "partner.cards.view", "partner.cards.assess"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: opts.orgWide ?? false,
  };
}

async function credit(tenantId: string, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, tenantId);
  await wallet.appendFoundationCredit(adminActor, {
    tenantId,
    amount,
    entryType: "purchase",
    source: "admin",
    reason: "P13 concurrency credits",
    idempotencyKey: key,
    actorType: "admin",
  });
}

function startNew(f: Fixture, clientOpId: string, opts: { locationId?: string; stationId?: string } = {}) {
  return authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId: opts.locationId ?? f.locationA,
    stationId: opts.stationId ?? f.stationA,
    clientOpId,
    actorUserId: f.graderOne,
    actorEmail: "operator@shop.test",
    cardName: "Contended card",
  });
}

async function captureSide(f: Fixture, certificateId: number, side: "front" | "back", stationId?: string) {
  evidenceSeq += 1;
  const sessionId = `sess-${certificateId}-${side}-${evidenceSeq}`;
  await admin.query(
    `INSERT INTO scanner_capture_sessions
       (id, certificate_id, side, workstation_id, station_id, scanner_profile_version, actor_id, state,
        captured_at, expires_at)
     VALUES ($1,$2,$3,'WS-1',$4,'lide400-v1',$5,'captured', now(), now() + interval '1 hour')`,
    [sessionId, certificateId, side, stationId ?? f.stationA, f.graderOne]
  );
  await admin.query(
    `INSERT INTO certificate_image_evidence
       (certificate_id, side, evidence_class, object_key, sha256, byte_length, pixel_width, pixel_height,
        format, capture_metadata, is_current)
     VALUES ($1,$2,'NEW_IMMUTABLE_MASTER',$3,$4,1024,1000,1400,'tiff',$5::jsonb,true)`,
    [
      certificateId,
      side,
      `evidence/${certificateId}/${side}/${evidenceSeq}.tif`,
      "a".repeat(64),
      JSON.stringify({ captureSessionId: sessionId }),
    ]
  );
}

async function readyCard(f: Fixture, opts: { locationId?: string; stationId?: string } = {}) {
  opSeq += 1;
  const started = await startNew(f, `p13-${f.label}-${opSeq}-${RUN_SALT}`, opts);
  await captureSide(f, started.certificateId, "front", opts.stationId);
  await lifecycle.advanceCardJobAfterCapture(started.certificateId);
  await captureSide(f, started.certificateId, "back", opts.stationId);
  await lifecycle.advanceCardJobAfterCapture(started.certificateId);
  return started;
}

async function available(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ v: string }>(
    `SELECT COALESCE(available_balance, 0)::text AS v FROM partner_credit_availability WHERE tenant_id=$1`,
    [tenantId]
  );
  return Number(rows[0]?.v ?? 0);
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

/**
 * THE INVARIANTS THAT MUST HOLD AFTER ANY AMOUNT OF CONTENTION, checked as one sweep.
 *
 * Asserted after every stress case rather than once at the end: a violation introduced by case 3 and
 * only detected after case 9 is a violation whose cause nobody can find.
 */
async function assertGlobalInvariants(): Promise<void> {
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

  // Never a negative balance.
  expect(await q(`SELECT tenant_id FROM partner_credit_availability WHERE available_balance < 0`)).toEqual([]);

  // Never a duplicate MV number, and never two jobs on one certificate. Both are unique indexes in
  // 0080 — this proves the indexes exist and are doing their job, not merely that the code is careful.
  expect(
    await q(`SELECT mv_number FROM partner_card_jobs WHERE mv_number IS NOT NULL
             GROUP BY mv_number HAVING count(*) > 1`)
  ).toEqual([]);
  expect(
    await q(`SELECT certificate_id FROM partner_card_jobs WHERE certificate_id IS NOT NULL
             GROUP BY certificate_id HAVING count(*) > 1`)
  ).toEqual([]);
  expect(
    await q(`SELECT certificate_number FROM certificates GROUP BY certificate_number HAVING count(*) > 1`)
  ).toEqual([]);

  // Never one reservation funding two Card Jobs — the "one credit cannot pay for two cards" breach.
  expect(
    await q(`SELECT reservation_id FROM partner_card_jobs WHERE reservation_id IS NOT NULL
             GROUP BY reservation_id HAVING count(*) > 1`)
  ).toEqual([]);

  // Never a double settlement: at most one 'consumed' event per reservation.
  expect(
    await q(`SELECT reservation_id FROM partner_credit_reservation_events WHERE event_type='consumed'
             GROUP BY reservation_id HAVING count(*) > 1`)
  ).toEqual([]);

  // Never two live leases on one Card Job — the partial unique index in 0087.
  expect(
    await q(`SELECT card_job_id FROM partner_grading_leases WHERE released_at IS NULL
             GROUP BY card_job_id HAVING count(*) > 1`)
  ).toEqual([]);

  // Never a Card Job whose certificate belongs to another tenant. Cross-tenant bleed would show here
  // even if every route check had been bypassed.
  expect(
    await q(`SELECT job.id FROM partner_card_jobs job
               JOIN certificates cert ON cert.id = job.certificate_id
              WHERE cert.origin_partner_id IS DISTINCT FROM job.tenant_id`)
  ).toEqual([]);

  // Never a Card Job whose location belongs to another tenant — cross-location bleed.
  expect(
    await q(`SELECT job.id FROM partner_card_jobs job
               JOIN partner_locations loc ON loc.id = job.location_id
              WHERE loc.tenant_id IS DISTINCT FROM job.tenant_id`)
  ).toEqual([]);
}

let shopA: Fixture;
let shopB: Fixture;

describe("P13 Partner pilot concurrency (real PostgreSQL, genuinely parallel)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-pilot-concurrency");
    admin = new Pool({ connectionString: cluster.url, max: 16 });
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      "0035_partner_certificate_origin",
      "0045_partner_stations",
      "0087_partner_grading_edit_lease",
      "0088_nfc_binding_integrity",
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
    lifecycle = await import("../server/partner/card-job-lifecycle");
    bridge = await import("../server/partner/card-job-grading-bridge");
    leases = await import("../server/partner/grading-lease-service");
    reconciliation = await import("../server/partner/card-job-reconciliation");
    printEligibility = await import("../server/partner/print-eligibility");
    drizzle = await import("../server/db");

    shopA = await makeTenant("loada");
    shopB = await makeTenant("loadb");
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

  it("L1: 12 simultaneous NEW presses against 5 credits produce exactly 5 paid Card Jobs", async () => {
    await credit(shopA.tenantId, 5, `l1-${RUN_SALT}`);
    const before = await available(shopA.tenantId);
    expect(before).toBe(5);

    // Twelve stations pressing NEW at once. The wallet row lock is what serialises them; without it
    // the availability read races and more than five jobs are minted against five credits.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => settle(startNew(shopA, `l1-op-${i}-${RUN_SALT}`)))
    );
    const won = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(won).toHaveLength(5);
    expect(refused.every((r) => !r.ok && r.code === "INSUFFICIENT_CREDITS")).toBe(true);
    expect(await available(shopA.tenantId)).toBe(0);

    // Five DISTINCT MV numbers and five distinct certificates — the cert_counter row lock.
    const mvs = new Set(won.map((r) => (r as { value: { mvNumber: string } }).value.mvNumber));
    const certs = new Set(won.map((r) => (r as { value: { certificateId: number } }).value.certificateId));
    expect(mvs.size).toBe(5);
    expect(certs.size).toBe(5);
    await assertGlobalInvariants();
  });

  it("L2: the SAME client op id pressed 10 times concurrently spends exactly one credit", async () => {
    await credit(shopA.tenantId, 4, `l2-${RUN_SALT}`);
    const before = await available(shopA.tenantId);
    const opId = `l2-double-click-${RUN_SALT}`;

    // One operator double-clicking, or one dropped response retried nine times. Idempotency is keyed
    // on (station_id, client_op_id) in PostgreSQL, not in process memory — so a retry landing on the
    // other Fly Machine is the same case.
    const results = await Promise.all(Array.from({ length: 10 }, () => settle(startNew(shopA, opId))));
    const ok = results.filter((r) => r.ok) as { ok: true; value: { cardJobId: string; mvNumber: string } }[];
    expect(ok.length).toBeGreaterThan(0);
    // Every success is the SAME job and the SAME MV.
    expect(new Set(ok.map((r) => r.value.cardJobId)).size).toBe(1);
    expect(new Set(ok.map((r) => r.value.mvNumber)).size).toBe(1);
    expect(await available(shopA.tenantId)).toBe(before - 1);
    await assertGlobalInvariants();
  });

  it("L3: 8 graders racing for one card produce exactly ONE editor, and no silent overwrite", async () => {
    await credit(shopA.tenantId, 2, `l3-${RUN_SALT}`);
    const card = await readyCard(shopA);
    const graders = [shopA.graderOne, shopA.graderTwo, shopA.owner];

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        settle(leases.acquireLease(principal(shopA, graders[i % graders.length]), card.cardJobId, `G${i}`))
      )
    );
    const holders = attempts.filter((r) => r.ok);
    // The three principals are only three distinct users, so several attempts are the SAME grader
    // reacquiring — which is legitimately idempotent. What must be true is that exactly one USER ends
    // up holding it, and that nobody else can write.
    const { rows } = await admin.query<{ n: string; holder: string }>(
      `SELECT count(*)::text AS n, min(holder_user_id::text) AS holder
         FROM partner_grading_leases WHERE card_job_id=$1 AND released_at IS NULL`,
      [card.cardJobId]
    );
    expect(Number(rows[0].n)).toBe(1);
    expect(holders.length).toBeGreaterThan(0);

    // Every grader who is NOT the holder is refused the write authority — this is the "silent
    // overwrite" the whole lease exists to prevent.
    const holder = rows[0].holder;
    for (const userId of graders.filter((g) => g !== holder)) {
      const refused = await settle(leases.assertMayWriteCertificate(principal(shopA, userId), card.certificateId, 1));
      expect(refused.ok).toBe(false);
    }
    await assertGlobalInvariants();
  });

  it("L4: 10 concurrent submits on one card settle exactly one credit and transition once", async () => {
    await credit(shopA.tenantId, 2, `l4-${RUN_SALT}`);
    const card = await readyCard(shopA);
    const grader = principal(shopA, shopA.graderOne);
    await leases.acquireLease(grader, card.cardJobId, "Ada");
    await admin.query(
      `UPDATE certificates SET grade=9, centering_score=9, corners_score=9, edges_score=9, surface_score=9
        WHERE id=$1`,
      [card.certificateId]
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => settle(bridge.submitCardJobForReview(grader, card.certificateId)))
    );
    const settled = results.filter((r) => r.ok && (r.value as { creditSettled: boolean }).creditSettled);
    // EXACTLY one of ten actually consumed the credit. The Card Job row lock is the first floor and
    // the reservation engine's idempotency key is the second, independent one.
    expect(settled).toHaveLength(1);

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_card_jobs j
         JOIN partner_credit_reservation_events e ON e.reservation_id = j.reservation_id
        WHERE j.id=$1 AND e.event_type='consumed'`,
      [card.cardJobId]
    );
    expect(Number(rows[0].n)).toBe(1);

    // And exactly one submit audit row — not ten harmless duplicates.
    const { rows: audits } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_audit_events
        WHERE record_id=$1 AND action='partner_card_job_submitted'`,
      [card.cardJobId]
    );
    expect(Number(audits[0].n)).toBe(1);
    await assertGlobalInvariants();
  });

  it("L5: two tenants working simultaneously never see or touch each other's cards", async () => {
    await credit(shopA.tenantId, 3, `l5a-${RUN_SALT}`);
    await credit(shopB.tenantId, 3, `l5b-${RUN_SALT}`);
    const grading = await import("../server/partner/grading-routes");

    // Both shops run a full intake at the same time.
    const [cardA, cardB] = await Promise.all([readyCard(shopA), readyCard(shopB)]);

    // Neither can resolve the other's card by certificate id...
    const [aSeesB, bSeesA] = await Promise.all([
      grading.loadPartnerCert(principal(shopA, shopA.graderOne), cardB.certificateId),
      grading.loadPartnerCert(principal(shopB, shopB.graderOne), cardA.certificateId),
    ]);
    expect(aSeesB).toBeNull();
    expect(bSeesA).toBeNull();

    // ...nor take a lease on it by Card Job id.
    const [aLeasesB, bLeasesA] = await Promise.all([
      settle(leases.acquireLease(principal(shopA, shopA.graderOne), cardB.cardJobId)),
      settle(leases.acquireLease(principal(shopB, shopB.graderOne), cardA.cardJobId)),
    ]);
    expect(aLeasesB.ok).toBe(false);
    expect(bLeasesA.ok).toBe(false);
    await assertGlobalInvariants();
  });

  it("L6: a location-scoped grader cannot reach another shop floor under concurrent load", async () => {
    await credit(shopA.tenantId, 4, `l6-${RUN_SALT}`);
    // Two shop floors of the SAME partner working at once.
    const [floorA, floorB] = await Promise.all([
      readyCard(shopA, { locationId: shopA.locationA, stationId: shopA.stationA }),
      readyCard(shopA, { locationId: shopA.locationB, stationId: shopA.stationB }),
    ]);
    const scopedToA = principal(shopA, shopA.graderOne, { locationId: shopA.locationA });

    expect(await settle(leases.acquireLease(scopedToA, floorA.cardJobId))).toMatchObject({ ok: true });
    const crossFloor = await settle(leases.acquireLease(scopedToA, floorB.cardJobId));
    expect(crossFloor.ok).toBe(false);
    if (!crossFloor.ok) expect(crossFloor.code).toBe("CARD_JOB_NOT_FOUND");
    await assertGlobalInvariants();
  });

  it("L7: concurrent reconciliation redrives repair a drifted card exactly once", async () => {
    await credit(shopA.tenantId, 2, `l7-${RUN_SALT}`);
    const card = await readyCard(shopA);
    const grader = principal(shopA, shopA.graderOne);
    await leases.acquireLease(grader, card.cardJobId, "Ada");
    await admin.query(
      `UPDATE certificates SET grade=9, centering_score=9, corners_score=9, edges_score=9, surface_score=9
        WHERE id=$1`,
      [card.certificateId]
    );
    await bridge.submitCardJobForReview(grader, card.certificateId);
    // Approve the certificate WITHOUT the Card Job transition — the documented split-transaction seam.
    await admin.query(
      `UPDATE certificates
          SET grade_approved_at=NOW(), grade_approved_by='qa@mintvault.test', status='active',
              grader_status='approved', print_state='needs_printing'
        WHERE id=$1 AND grader_status='pending_review'`,
      [card.certificateId]
    );

    // Several machines ticking at once. Only one may perform the repair.
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => settle(reconciliation.redriveQaCardJobDrift({ actor: "p13" })))
    );
    const repairedCount = runs.reduce((total, run) => {
      if (!run.ok) return total;
      return total + run.value.results.filter((r) => r.cardJobId === card.cardJobId && r.outcome === "repaired").length;
    }, 0);
    expect(repairedCount).toBe(1);

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_audit_events
        WHERE record_id=$1 AND action='partner_card_job_drift_repaired'`,
      [card.cardJobId]
    );
    expect(Number(rows[0].n)).toBe(1);
    await assertGlobalInvariants();
  });

  it("L8: no card is ever printable before its Card Job says so, under load", async () => {
    await credit(shopA.tenantId, 4, `l8-${RUN_SALT}`);
    const cards = await Promise.all([readyCard(shopA), readyCard(shopA), readyCard(shopA)]);

    // Every one of them is mid-flow. Not one may produce output, whatever else is happening.
    const blocks = await printEligibility.getPartnerPrintEligibilityBlocks(cards.map((c) => c.mvNumber));
    expect(blocks).toHaveLength(cards.length);
    expect(new Set(blocks.map((b) => b.code))).toEqual(new Set(["partner_card_job_state_invalid"]));

    // Belt and braces, straight from the database: nothing is in an output-legal state.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_card_jobs
        WHERE status IN ('APPROVED','PRINTABLE','COMPLETED') AND mv_number = ANY($1::text[])`,
      [cards.map((c) => c.mvNumber)]
    );
    expect(Number(rows[0].n)).toBe(0);
    await assertGlobalInvariants();
  });

  it("L9: a sustained mixed workload leaves every invariant intact", async () => {
    await credit(shopA.tenantId, 10, `l9a-${RUN_SALT}`);
    await credit(shopB.tenantId, 10, `l9b-${RUN_SALT}`);

    /*
     * Everything at once, across two tenants and two shop floors: intake, capture, lease contention,
     * submit, and a reconciliation tick — the shape of a busy Saturday rather than one isolated race.
     * The assertion is not a latency figure; it is that the invariant sweep still holds afterwards.
     */
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i += 1) {
      const shop = i % 2 === 0 ? shopA : shopB;
      work.push(
        (async () => {
          const card = await readyCard(shop, {
            locationId: i % 4 < 2 ? shop.locationA : shop.locationB,
            stationId: i % 4 < 2 ? shop.stationA : shop.stationB,
          });
          const grader = principal(shop, shop.graderOne, {
            locationId: i % 4 < 2 ? shop.locationA : shop.locationB,
          });
          await settle(leases.acquireLease(grader, card.cardJobId, "Ada"));
          await admin.query(
            `UPDATE certificates SET grade=9, centering_score=9, corners_score=9, edges_score=9, surface_score=9
              WHERE id=$1`,
            [card.certificateId]
          );
          await settle(bridge.submitCardJobForReview(grader, card.certificateId));
        })()
      );
    }
    work.push(settle(reconciliation.redriveQaCardJobDrift({ actor: "p13-mixed" })));
    work.push(settle(reconciliation.detectStuckCardJobs()));
    await Promise.all(work);

    await assertGlobalInvariants();

    // And the books balance: every consumed reservation has exactly one debit behind it.
    const { rows } = await admin.query<{ consumed: string; debits: string }>(
      `SELECT
         (SELECT count(*)::text FROM partner_credit_reservations WHERE status='consumed') AS consumed,
         (SELECT count(*)::text FROM partner_credit_ledger WHERE amount < 0) AS debits`
    );
    expect(rows[0].debits).toBe(rows[0].consumed);
  });
});
