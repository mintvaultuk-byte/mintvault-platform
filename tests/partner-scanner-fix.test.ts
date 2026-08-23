/**
 * P7 — SCANNER FIX, proven against real PostgreSQL.
 *
 * THE RULE UNDER TEST: repairing a side of an existing paid card costs ZERO Grading Credits, keeps
 * the SAME Card Job, the SAME MV and the SAME certificate, and destroys no evidence.
 *
 * FIX IS THE MOST ABUSABLE SURFACE IN THE SYSTEM, which is why most of this file is hostile. NEW is
 * guarded by money — you cannot have a card without paying. FIX is deliberately free and works at a
 * zero balance, so if it could be persuaded to create a card, allocate an MV, or touch another
 * partner's data, it would be a way to get grading for nothing or to reach across tenants. Every
 * one of those attempts is attempted here rather than reasoned about.
 *
 * WHY REAL POSTGRESQL. The guarantees are RLS, a partial unique index (`WHERE is_current`), an
 * `ON DELETE RESTRICT` supersede chain and the Card Job transition trigger. A mock reproduces none
 * of them, and it is precisely those that stop a "fix" from becoming a delete.
 *
 * Mutation targets: FIX1 (zero credit cost), FIX2 (evidence preserved), FIX3 (cross-tenant refused),
 * FIX4 (cannot replace an accepted side), FIX5 (works at zero balance).
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
let fix: typeof import("../server/partner/fix-authority");
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };

interface Fixture {
  tenantId: string;
  locationId: string;
  userId: string;
  stationId: string;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  await admin.query(`CREATE TABLE certificates (
    id serial primary key, certificate_number text not null unique,
    card_id integer, submission_item_id integer,
    status text not null default 'active', label_type text not null default 'Standard',
    grade_type text not null default 'numeric', source text, scan_status text,
    raw_uploaded boolean not null default false, created_by text,
    issued_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    origin_type text, origin_partner_id uuid, origin_partner_public_ref text,
    origin_partner_legal_name text, origin_partner_trading_name text,
    origin_location_id uuid, origin_location_public_ref text, origin_location_name text,
    origin_location_address text, origin_captured_at timestamptz, origin_snapshot_version integer
  )`);
  await admin.query(`CREATE TABLE cert_counter (
    id integer primary key, last_issued bigint not null default 0, updated_at timestamptz not null default now()
  )`);
  await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)");

  /*
   * The evidence table, with the two constraints that make FIX safe rather than destructive:
   *   - the PARTIAL unique index on (certificate_id, side) WHERE is_current, so a side can never
   *     have two live images and a replacement cannot quietly coexist with what it replaced;
   *   - ON DELETE RESTRICT on superseded_by_id, so an original can never be cascaded away by
   *     removing the thing that superseded it.
   */
  await admin.query(`CREATE TABLE certificate_image_evidence (
    id serial primary key,
    certificate_id integer not null references certificates(id) on delete restrict,
    side varchar(5) not null check (side in ('front','back')),
    evidence_class text not null default 'NEW_IMMUTABLE_MASTER',
    evidence_version text not null default 'v1',
    object_key text not null unique,
    sha256 text, byte_length integer,
    capture_metadata jsonb,
    is_current boolean not null default true,
    superseded_at timestamptz,
    superseded_by_id integer references certificate_image_evidence(id) on delete restrict,
    created_at timestamptz not null default now()
  )`);
  await admin.query(
    `CREATE UNIQUE INDEX uq_certificate_image_evidence_current_side
       ON certificate_image_evidence (certificate_id, side) WHERE is_current`
  );
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "audit_log",
    "certificates",
    "cert_counter",
    "certificate_image_evidence",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/** `partner_stations.station_code` is CHECK-constrained to MV-STN- plus 10-24 Base32 characters. */
function stationCodeFor(label: string): string {
  const base32 = label.toUpperCase().replace(/[^A-Z2-7]/g, "A");
  return `MV-STN-${base32.padEnd(10, "A").slice(0, 10)}`;
}

async function makeTenant(label: string): Promise<Fixture> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}`, `${label} Ltd`]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [
    tenantId,
    `${label} Cards`,
  ]);
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
  const stationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_stations (station_code, tenant_id, location_id, status, public_key_pem, public_key_fingerprint)
       VALUES ($1,$2,$3,'ACTIVE',$4,$5) RETURNING id`,
      [
        stationCodeFor(label),
        tenantId,
        locationId,
        "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----",
        label.padEnd(64, "0").slice(0, 64),
      ]
    )
  ).rows[0].id;
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
      reason: "P7 FIX test credits",
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

/** Wallet + ledger + reservation snapshot, for before/after comparison across a FIX. */
async function walletSnapshot(tenantId: string) {
  const avail = await availableFor(tenantId);
  const ledger = await admin.query<{ n: string; total: string }>(
    `SELECT count(*)::text AS n, COALESCE(SUM(amount),0)::text AS total FROM partner_credit_ledger WHERE tenant_id=$1`,
    [tenantId]
  );
  const reservations = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM partner_credit_reservations WHERE tenant_id=$1`,
    [tenantId]
  );
  return {
    available: avail,
    ledgerRows: ledger.rows[0].n,
    ledgerTotal: ledger.rows[0].total,
    reservations: reservations.rows[0].n,
  };
}

/** Give a certificate an accepted image on one side, as a real capture would. */
async function acceptEvidence(certificateId: number, side: "front" | "back", tag: string): Promise<number> {
  const { rows } = await admin.query<{ id: number }>(
    `INSERT INTO certificate_image_evidence (certificate_id, side, object_key, sha256, byte_length)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [certificateId, side, `evidence/masters/${certificateId}/${side}/${tag}.tif`, tag.padEnd(64, "0"), 1024]
  );
  return rows[0].id;
}

async function startCard(f: Fixture, opId: string) {
  return authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId: f.locationId,
    stationId: f.stationId,
    clientOpId: opId,
    actorUserId: f.userId,
    actorEmail: "operator@shop.test",
  });
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

describe("P7 Scanner FIX (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-scanner-fix");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    /*
     * 0045 is PARTNER scope but is not in the PER_CARD cumulative list, and this suite needs real
     * `partner_stations` rows: the station lifecycle checks (REVOKED, wrong location) are the whole
     * point of half the hostile cases, and a synthetic uuid would let them pass vacuously. Appended
     * rather than inserted because it depends only on 0001's organisations and locations, which the
     * list already applied.
     */
    await applyMigrationsRealistic(admin, cluster.url, [...PARTNER_MIGRATIONS_WITH_PER_CARD, "0045_partner_stations"]);
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
    fix = await import("../server/partner/fix-authority");
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

  // ---- FIX1 / FIX2: the core contract ------------------------------------------------------
  it("invalidating a side keeps the job, MV, certificate and credit lineage, and destroys nothing", async () => {
    const f = await makeTenant("fixa");
    await addCredits(f.tenantId, 1, "fixa");
    const card = await startCard(f, "op-fixa-0001");
    const frontId = await acceptEvidence(card.certificateId, "front", "aaa");
    await acceptEvidence(card.certificateId, "back", "bbb");
    const before = await walletSnapshot(f.tenantId);

    const result = await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "front",
      actorUserId: f.userId,
      reason: "Front scan is blurred along the top edge",
    });

    expect(result.mvNumber).toBe(card.mvNumber);
    expect(result.status).toBe("FIX_REQUIRED");

    // The job kept everything that identifies and pays for it.
    const job = await admin.query(
      `SELECT status, mv_number, certificate_id, reservation_id FROM partner_card_jobs WHERE id=$1`,
      [card.cardJobId]
    );
    expect(job.rows[0].mv_number).toBe(card.mvNumber);
    expect(job.rows[0].certificate_id).toBe(card.certificateId);
    expect(job.rows[0].reservation_id).toBe(card.reservationId);
    expect(job.rows[0].status).toBe("FIX_REQUIRED");

    // FIX2 — the original evidence row still EXISTS. It is retired, not removed.
    const original = await admin.query(
      `SELECT id, is_current, superseded_at, object_key FROM certificate_image_evidence WHERE id=$1`,
      [frontId]
    );
    expect(original.rowCount).toBe(1);
    expect(original.rows[0].is_current).toBe(false);
    expect(original.rows[0].superseded_at).not.toBeNull();
    expect(original.rows[0].object_key).toContain("evidence/masters/");

    // FIX1 — the wallet, the ledger and the reservations are byte-for-byte unchanged.
    expect(await walletSnapshot(f.tenantId)).toEqual(before);
  });

  it("writes an audit row naming the actor, the card, the MV and the reason", async () => {
    const f = await makeTenant("fixaudit");
    await addCredits(f.tenantId, 1, "fixaudit");
    const card = await startCard(f, "op-fixaudit-01");
    await acceptEvidence(card.certificateId, "front", "ccc");

    await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "front",
      actorUserId: f.userId,
      reason: "Corner cropped",
      stationId: f.stationId,
    });

    const audit = await admin.query<{
      action: string;
      actor_user_id: string;
      record_id: string;
      reason: string;
      after_value: Record<string, unknown>;
    }>(
      `SELECT action, actor_user_id, record_id, reason, after_value
         FROM partner_audit_events
        WHERE tenant_id=$1 AND action='partner_card_front_invalidated'`,
      [f.tenantId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_user_id).toBe(f.userId);
    expect(audit.rows[0].record_id).toBe(card.cardJobId);
    expect(audit.rows[0].reason).toBe("Corner cropped");
    expect(audit.rows[0].after_value).toMatchObject({ mvNumber: card.mvNumber });
  });

  it("refuses to invalidate without a reason", async () => {
    const f = await makeTenant("fixnoreason");
    await addCredits(f.tenantId, 1, "fixnoreason");
    const card = await startCard(f, "op-fixnoreason1");
    await acceptEvidence(card.certificateId, "front", "ddd");

    const refused = await settle(
      fix.invalidateSide({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: card.cardJobId,
        side: "front",
        actorUserId: f.userId,
        reason: "   ",
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("SIDE_INVALID");
  });

  // ---- The FIX queue ------------------------------------------------------------------------
  it("the queue is server-derived and names exactly the missing sides", async () => {
    const f = await makeTenant("fixq");
    await addCredits(f.tenantId, 3, "fixq");

    const frontMissing = await startCard(f, "op-fixq-0001");
    await acceptEvidence(frontMissing.certificateId, "back", "q1b");

    const backMissing = await startCard(f, "op-fixq-0002");
    await acceptEvidence(backMissing.certificateId, "front", "q2f");

    const bothMissing = await startCard(f, "op-fixq-0003");

    const queue = await fix.listFixQueue({ tenantId: f.tenantId, locationId: f.locationId });
    const byMv = new Map(queue.map((q) => [q.mvNumber, q]));

    expect(byMv.get(frontMissing.mvNumber)?.missingLabel).toBe("FRONT MISSING");
    expect(byMv.get(backMissing.mvNumber)?.missingLabel).toBe("BACK MISSING");
    expect(byMv.get(bothMissing.mvNumber)?.missingLabel).toBe("FRONT + BACK MISSING");
    expect(byMv.get(frontMissing.mvNumber)?.missingSides).toEqual(["front"]);
    expect(byMv.get(backMissing.mvNumber)?.missingSides).toEqual(["back"]);
  });

  it("a complete card does not appear in the FIX queue", async () => {
    const f = await makeTenant("fixcomplete");
    await addCredits(f.tenantId, 1, "fixcomplete");
    const card = await startCard(f, "op-fixcomplete1");
    await acceptEvidence(card.certificateId, "front", "cf");
    await acceptEvidence(card.certificateId, "back", "cb");

    const queue = await fix.listFixQueue({ tenantId: f.tenantId, locationId: f.locationId });
    expect(queue.find((q) => q.mvNumber === card.mvNumber)).toBeUndefined();
  });

  // ---- FIX5: free, and available at a zero balance ------------------------------------------
  it("FIX works with a wallet balance of ZERO and changes nothing about the wallet", async () => {
    const f = await makeTenant("fixzero");
    await addCredits(f.tenantId, 1, "fixzero");
    const card = await startCard(f, "op-fixzero-001");
    await acceptEvidence(card.certificateId, "front", "z1");
    // BACK too, so that invalidating FRONT leaves exactly ONE missing side. Without this the card
    // has never had a back image and the assertion below would be testing a half-captured card.
    await acceptEvidence(card.certificateId, "back", "z2");
    expect(await availableFor(f.tenantId)).toBe(0); // the single credit is spent on the card

    const before = await walletSnapshot(f.tenantId);

    await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "front",
      actorUserId: f.userId,
      reason: "Bad scan",
    });
    const authorised = await fix.authoriseFix({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      stationId: f.stationId,
      actorUserId: f.userId,
    });

    expect(authorised.authorisedSides).toEqual(["front"]);
    expect(authorised.mvNumber).toBe(card.mvNumber);
    expect(authorised.certificateId).toBe(card.certificateId);
    expect(await walletSnapshot(f.tenantId)).toEqual(before);
  });

  it("authorises ONLY the missing side, never both", async () => {
    const f = await makeTenant("fixone");
    await addCredits(f.tenantId, 1, "fixone");
    const card = await startCard(f, "op-fixone-0001");
    await acceptEvidence(card.certificateId, "front", "o1f");
    await acceptEvidence(card.certificateId, "back", "o1b");
    await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "back",
      actorUserId: f.userId,
      reason: "Back is out of focus",
    });

    const authorised = await fix.authoriseFix({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      actorUserId: f.userId,
    });
    expect(authorised.authorisedSides).toEqual(["back"]);
  });

  it("creates no new Card Job, no new MV and no new reservation across a full FIX cycle", async () => {
    const f = await makeTenant("fixnonew");
    await addCredits(f.tenantId, 1, "fixnonew");
    const card = await startCard(f, "op-fixnonew-01");
    await acceptEvidence(card.certificateId, "front", "n1");

    const counterBefore = (
      await admin.query<{ last_issued: string }>(`SELECT last_issued::text FROM cert_counter WHERE id=1`)
    ).rows[0].last_issued;

    await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "front",
      actorUserId: f.userId,
      reason: "Blurred",
    });
    await fix.authoriseFix({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      actorUserId: f.userId,
    });
    // The replacement lands, exactly as a real capture would.
    await acceptEvidence(card.certificateId, "front", "n2");

    const jobs = await admin.query(`SELECT count(*)::int AS n FROM partner_card_jobs WHERE tenant_id=$1`, [f.tenantId]);
    expect(jobs.rows[0].n).toBe(1);
    const certs = await admin.query(`SELECT count(*)::int AS n FROM certificates WHERE origin_partner_id=$1`, [
      f.tenantId,
    ]);
    expect(certs.rows[0].n).toBe(1);
    const counterAfter = (
      await admin.query<{ last_issued: string }>(`SELECT last_issued::text FROM cert_counter WHERE id=1`)
    ).rows[0].last_issued;
    expect(counterAfter).toBe(counterBefore);

    // Both the original and the replacement exist; exactly one is current.
    const evidence = await admin.query<{ n: string; current: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE is_current)::text AS current
         FROM certificate_image_evidence WHERE certificate_id=$1 AND side='front'`,
      [card.certificateId]
    );
    expect(evidence.rows[0].n).toBe("2");
    expect(evidence.rows[0].current).toBe("1");
  });

  // ---- HOSTILE ------------------------------------------------------------------------------
  it("HOSTILE: Partner A cannot list Partner B's FIX items", async () => {
    const a = await makeTenant("hosta");
    const b = await makeTenant("hostb");
    await addCredits(a.tenantId, 1, "hosta");
    await addCredits(b.tenantId, 1, "hostb");
    const aCard = await startCard(a, "op-hosta-00001");
    const bCard = await startCard(b, "op-hostb-00001");

    const aQueue = await fix.listFixQueue({ tenantId: a.tenantId, locationId: a.locationId });
    const mvs = aQueue.map((q) => q.mvNumber);
    expect(mvs).toContain(aCard.mvNumber);
    expect(mvs).not.toContain(bCard.mvNumber);
  });

  it("HOSTILE: knowing Partner B's MV number and Card Job id grants nothing", async () => {
    const a = await makeTenant("knowa");
    const b = await makeTenant("knowb");
    await addCredits(a.tenantId, 1, "knowa");
    await addCredits(b.tenantId, 1, "knowb");
    const bCard = await startCard(b, "op-knowb-00001");
    await acceptEvidence(bCard.certificateId, "front", "kb");
    const bBefore = await walletSnapshot(b.tenantId);

    // A, using B's real Card Job id — the strongest form of the attack, because the id is genuine.
    for (const attempt of [
      () =>
        fix.invalidateSide({
          tenantId: a.tenantId,
          locationId: a.locationId,
          cardJobId: bCard.cardJobId,
          side: "front",
          actorUserId: a.userId,
          reason: "not mine",
        }),
      () =>
        fix.authoriseFix({
          tenantId: a.tenantId,
          locationId: a.locationId,
          cardJobId: bCard.cardJobId,
          actorUserId: a.userId,
        }),
    ]) {
      const refused = await settle(attempt());
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("CARD_JOB_NOT_FOUND");
    }

    // B's card is untouched: still has its image, still not in FIX_REQUIRED.
    const evidence = await admin.query(
      `SELECT is_current FROM certificate_image_evidence WHERE certificate_id=$1 AND side='front'`,
      [bCard.certificateId]
    );
    expect(evidence.rows[0].is_current).toBe(true);
    expect(await walletSnapshot(b.tenantId)).toEqual(bBefore);
  });

  it("HOSTILE: a forged Card Job id is refused", async () => {
    const f = await makeTenant("forge");
    await addCredits(f.tenantId, 1, "forge");
    const forged = (await admin.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;

    const refused = await settle(
      fix.authoriseFix({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: forged,
        actorUserId: f.userId,
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("CARD_JOB_NOT_FOUND");
  });

  it("HOSTILE: a REVOKED station cannot authorise a FIX", async () => {
    const f = await makeTenant("revoked");
    await addCredits(f.tenantId, 1, "revoked");
    const card = await startCard(f, "op-revoked-0001");
    await acceptEvidence(card.certificateId, "front", "rv");
    await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "front",
      actorUserId: f.userId,
      reason: "Bad scan",
    });

    await admin.query(`UPDATE partner_stations SET status='REVOKED' WHERE id=$1`, [f.stationId]);
    const refused = await settle(
      fix.authoriseFix({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: card.cardJobId,
        stationId: f.stationId,
        actorUserId: f.userId,
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("STATION_NOT_ACTIVE");
  });

  it("HOSTILE: a station at the WRONG location cannot authorise a FIX", async () => {
    const f = await makeTenant("wrongloc");
    await addCredits(f.tenantId, 1, "wrongloc");
    const card = await startCard(f, "op-wrongloc-001");
    await acceptEvidence(card.certificateId, "front", "wl");
    await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "front",
      actorUserId: f.userId,
      reason: "Bad scan",
    });

    // A second, legitimate station of the SAME tenant, at a different location.
    const otherLocation = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, status)
         VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
        ["loc-wrongloc-2", f.tenantId, "Other Shop"]
      )
    ).rows[0].id;
    const otherStation = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_stations (station_code, tenant_id, location_id, status, public_key_pem, public_key_fingerprint)
         VALUES ($1,$2,$3,'ACTIVE',$4,$5) RETURNING id`,
        [
          stationCodeFor("WRONGLOCTWO"),
          f.tenantId,
          otherLocation,
          "-----BEGIN PUBLIC KEY-----\nsynthetic2\n-----END PUBLIC KEY-----",
          "w".repeat(64),
        ]
      )
    ).rows[0].id;

    const refused = await settle(
      fix.authoriseFix({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: card.cardJobId,
        stationId: otherStation,
        actorUserId: f.userId,
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("CARD_JOB_NOT_FOUND");
  });

  // ---- FIX4: FIX cannot become a free NEW, nor overwrite good evidence -----------------------
  it("HOSTILE: an ACCEPTED side cannot be replaced without invalidating it first", async () => {
    const f = await makeTenant("accepted");
    await addCredits(f.tenantId, 1, "accepted");
    const card = await startCard(f, "op-accepted-001");
    await acceptEvidence(card.certificateId, "front", "af");
    await acceptEvidence(card.certificateId, "back", "ab");

    const refused = await settle(
      fix.authoriseFix({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: card.cardJobId,
        actorUserId: f.userId,
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("SIDE_NOT_INVALIDATED");
  });

  it("HOSTILE: asking for a side that is NOT missing is refused, not silently narrowed", async () => {
    const f = await makeTenant("narrow");
    await addCredits(f.tenantId, 1, "narrow");
    const card = await startCard(f, "op-narrow-00001");
    await acceptEvidence(card.certificateId, "front", "nf");
    await acceptEvidence(card.certificateId, "back", "nb");
    await fix.invalidateSide({
      tenantId: f.tenantId,
      locationId: f.locationId,
      cardJobId: card.cardJobId,
      side: "front",
      actorUserId: f.userId,
      reason: "Blurred",
    });

    // FRONT is missing; asking for BACK as well must be refused outright — quietly returning only
    // FRONT would let a caller believe it had authority to overwrite an accepted image.
    const refused = await settle(
      fix.authoriseFix({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: card.cardJobId,
        requestedSides: ["front", "back"],
        actorUserId: f.userId,
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("SIDE_NOT_INVALIDATED");
  });

  it("HOSTILE: FIX cannot be used on an APPROVED card to bypass the correction workflow", async () => {
    const f = await makeTenant("approved");
    await addCredits(f.tenantId, 1, "approved");
    const card = await startCard(f, "op-approved-001");
    await acceptEvidence(card.certificateId, "front", "pf");
    await acceptEvidence(card.certificateId, "back", "pb");
    // Walk the card up the legal transition path to APPROVED.
    // The 0080 trigger enforces the legal graph, so the card is walked step by step rather than
    // teleported: NEEDS_SCAN -> READY_TO_GRADE is refused outright.
    for (const status of ["CAPTURING", "READY_TO_GRADE", "GRADING", "SUBMITTED", "QA_REVIEW", "APPROVED"]) {
      await admin.query(`UPDATE partner_card_jobs SET status=$1 WHERE id=$2`, [status, card.cardJobId]);
    }

    const refused = await settle(
      fix.invalidateSide({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: card.cardJobId,
        side: "front",
        actorUserId: f.userId,
        reason: "trying to slip past QA",
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("JOB_NOT_FIXABLE");
  });

  it("HOSTILE: invalidating an already-missing side is refused rather than reported as done", async () => {
    const f = await makeTenant("already");
    await addCredits(f.tenantId, 1, "already");
    const card = await startCard(f, "op-already-0001");
    // No evidence was ever accepted, so FRONT is already missing.

    const refused = await settle(
      fix.invalidateSide({
        tenantId: f.tenantId,
        locationId: f.locationId,
        cardJobId: card.cardJobId,
        side: "front",
        actorUserId: f.userId,
        reason: "double click",
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("SIDE_ALREADY_MISSING");
  });
});

describe("P7 integration surfaces", () => {
  const stationRoutes = readFileSync("server/partner/station-routes.ts", "utf8");
  const fixAuthority = readFileSync("server/partner/fix-authority.ts", "utf8");
  const stationScope = readFileSync("server/lib/station-request-scope.ts", "utf8");
  const routes = readFileSync("server/routes.ts", "utf8");

  it("does NOT weaken /api/admin/orphan-certs to make the Scanner button work", () => {
    /*
     * The whole point of P7. That route addresses certificates with NO tenant predicate, so
     * admitting a partner station would hand every shop cross-tenant reads and soft-deletes.
     * It must remain outside the station allowlist, and its guard must be unchanged.
     */
    const allowlist = stationScope.slice(
      stationScope.indexOf("const STATION_ALLOWED_PATHS"),
      stationScope.indexOf("];", stationScope.indexOf("const STATION_ALLOWED_PATHS"))
    );
    expect(allowlist).not.toContain("orphan-certs");
    // The module still explains WHY it is excluded — that comment is the institutional memory.
    expect(stationScope).toContain("orphan-certs");
    expect(routes).toContain('app.get("/api/admin/orphan-certs", requireScannerOrAdmin');
  });

  it("the FIX authority never touches the wallet", () => {
    // Not "does not call it today" — there is no import by which it could.
    expect(fixAuthority).not.toMatch(
      /reserveCreditInTransaction|appendFoundationCredit|partner-wallet-service|partner-credit/
    );
    expect(fixAuthority).not.toMatch(/cert_counter|getNextCertId/);
    // And no way to create a Card Job.
    expect(fixAuthority).not.toMatch(/INSERT INTO partner_card_jobs/);
  });

  it("FIX never deletes evidence — it supersedes it", () => {
    expect(fixAuthority).not.toMatch(/DELETE FROM certificate_image_evidence/);
    expect(fixAuthority).toContain("SET is_current = false, superseded_at = NOW()");
  });

  it("the station FIX routes are guarded by BOTH station and operator", () => {
    /*
     * Anchored on the quoted PATH, and read to the start of the handler.
     *
     * This previously anchored on `r.get("/stations/fix-queue"` and read a fixed 300 characters.
     * Both halves were fragile: a prose mention of that same call expression elsewhere in the file
     * captured the match instead of the route, and any doc comment added above the middleware
     * pushed the guards past the window. Either one turns a real security assertion into a false
     * alarm, which is the worst kind — it teaches you to ignore it.
     */
    const guardsFor = (path: string): string => {
      const at = stationRoutes.indexOf(`"${path}",`);
      expect(at, `route ${path} must be registered`).toBeGreaterThan(-1);
      const handlerAt = stationRoutes.indexOf("async (req", at);
      expect(handlerAt, `route ${path} must have a handler`).toBeGreaterThan(at);
      return stationRoutes.slice(at, handlerAt);
    };
    for (const path of ["/stations/fix-queue", "/card-jobs/:cardJobId/fix-authorise"]) {
      const guards = guardsFor(path);
      expect(guards, `${path} must require a signed station`).toContain("requireSignedStation");
      expect(guards, `${path} must require a signed operator`).toContain("requireSignedStationOperator");
    }
  });

  it("the dashboard invalidation route is session-guarded and blocked for view-only principals", () => {
    const invalidate = stationRoutes.slice(stationRoutes.indexOf('"/card-jobs/:cardJobId/invalidate-side"'));
    const body = invalidate.slice(0, 500);
    expect(body).toContain("requirePartnerAuth");
    expect(body).toContain("requireNotViewOnly");
    expect(body).toContain("requireNotSensitiveFrozen");
  });

  it("tenant comes from the session, never the request", () => {
    const invalidate = stationRoutes.slice(stationRoutes.indexOf('"/card-jobs/:cardJobId/invalidate-side"'));
    const body = invalidate.slice(0, 700);
    expect(body).toContain("tenantId: principal.tenantId");
    expect(body).not.toMatch(/tenantId:\s*req\.body/);
    // The FIX queue takes no client-supplied filter that could widen its scope.
    expect(fixAuthority).toContain("WHERE job.tenant_id = $1");
  });
});
