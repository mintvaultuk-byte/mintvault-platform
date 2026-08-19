/**
 * P6c — CANCELLING A CARD JOB, PROVEN AGAINST REAL POSTGRESQL.
 *
 * THE DEFECT UNDER TEST. `NEEDS_SCAN -> CANCELLED` has been a legal edge since migration 0080 and
 * `transitionCardJob` could always perform it — but nothing reachable ever called it. A card started
 * by mistake at a counter held its Grading Credit for the full 365-day reservation TTL, and the job
 * sat in NEEDS_SCAN for ever: not gradeable, not closable, and permanently counted against the
 * shop's available balance.
 *
 * A MOCKED DATABASE WOULD PROVE NOTHING HERE. Every property that matters is a PostgreSQL behaviour:
 * `available_balance` is a VIEW over the ledger minus active reservations, "released exactly once"
 * is enforced by the reservation engine's own event key, "terminal means terminal" is 0080's
 * ENABLE ALWAYS trigger, and the double-cancel race is settled by `SELECT ... FOR UPDATE`. The
 * concurrency case therefore runs genuinely in parallel on SEPARATE pool connections — a sequential
 * "concurrency test" would pass with the locking completely broken.
 *
 * Mutation targets: CANCEL1 (one release, balance restored), CANCEL2 (retry returns nothing extra),
 * CANCEL3 (MV survives and is never reissued), CANCEL4 (a photographed card is refused),
 * CANCEL5 (cross-tenant is not found), CANCEL6 (terminal is terminal), CANCEL7 (double-cancel race).
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
let cancellation: typeof import("../server/partner/card-job-cancellation");
let management: typeof import("../server/partner/partner-management-service");
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };

interface Fixture {
  tenantId: string;
  locationId: string;
  userId: string;
  stationId: string;
}

/**
 * The MintVault-internal tables this path touches. `certificate_image_evidence` and
 * `scanner_capture_sessions` are here deliberately: both cancellation guards are `to_regclass`-gated,
 * so a fixture that omitted them would SILENTLY SKIP the two checks that stop a photographed card
 * being cancelled — the suite would pass while proving nothing.
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
  await admin.query(`CREATE TABLE certificate_image_evidence (
    id serial primary key,
    certificate_id integer not null,
    side text not null,
    is_current boolean not null default true,
    evidence_class text,
    format text,
    superseded_at timestamptz
  )`);
  await admin.query(`CREATE TABLE scanner_capture_sessions (
    id uuid primary key default gen_random_uuid(),
    certificate_id integer not null,
    side text not null,
    state varchar(16) not null CHECK (state IN ('armed','claimed','capturing','captured','failed','expired','cancelled')),
    failure_reason text,
    physical_released boolean not null default false,
    station_id uuid,
    workstation_id text,
    expires_at timestamptz not null default now() + interval '10 minutes'
  )`);
  await admin.query(`CREATE TABLE cert_counter (
    id integer primary key, last_issued bigint not null default 0, updated_at timestamptz not null default now()
  )`);
  await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)");
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "audit_log",
    "certificates",
    "certificate_image_evidence",
    "scanner_capture_sessions",
    "cert_counter",
  ]) {
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
  await wallet.appendFoundationCredit(adminActor, {
    tenantId,
    amount,
    entryType: "purchase",
    source: "admin",
    reason: "P6c cancellation test credits",
    idempotencyKey: key,
    actorType: "admin",
  });
}

async function availableFor(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ available: string }>(
    `SELECT available_balance::text AS available FROM partner_credit_availability WHERE tenant_id=$1`,
    [tenantId]
  );
  return Number(rows[0]?.available ?? 0);
}

async function reservedFor(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM partner_credit_reservations WHERE tenant_id=$1 AND status='active'`,
    [tenantId]
  );
  return Number(rows[0]?.n ?? 0);
}

function start(f: Fixture, clientOpId: string) {
  return authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId: f.locationId,
    stationId: f.stationId,
    clientOpId,
    actorUserId: f.userId,
    actorEmail: "operator@shop.test",
    cardName: null,
  });
}

function cancel(f: Fixture, cardJobId: string, reason = "Started by mistake at the counter.") {
  return cancellation.cancelCardJob({
    tenantId: f.tenantId,
    locationId: f.locationId,
    cardJobId,
    stationId: f.stationId,
    actorUserId: f.userId,
    actorEmail: "operator@shop.test",
    reason,
  });
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

describe("P6c Card Job cancellation (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-card-job-cancellation");
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
    cancellation = await import("../server/partner/card-job-cancellation");
    management = await import("../server/partner/partner-management-service");
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

  // ---- CANCEL1 ------------------------------------------------------------------------------
  it("returns exactly one Grading Credit and stamps the job CANCELLED", async () => {
    const f = await makeTenant("cancel1");
    await addCredits(f.tenantId, 3, "cancel1");
    const job = await start(f, "op-cancel1-aaaa");
    expect(await availableFor(f.tenantId)).toBe(2);
    expect(await reservedFor(f.tenantId)).toBe(1);

    const result = await cancel(f, job.cardJobId);

    expect(result.changed).toBe(true);
    expect(result.reservationReleased).toBe(true);
    expect(result.status).toBe("CANCELLED");
    // The balance is the VIEW's answer, not this module's: nothing here computes availability.
    expect(await availableFor(f.tenantId)).toBe(3);
    expect(await reservedFor(f.tenantId)).toBe(0);

    const row = await admin.query(
      `SELECT status, cancelled_at, cancelled_reason, reservation_id FROM partner_card_jobs WHERE id=$1`,
      [job.cardJobId]
    );
    expect(row.rows[0].status).toBe("CANCELLED");
    expect(row.rows[0].cancelled_at).not.toBeNull();
    expect(row.rows[0].cancelled_reason).toBe("Started by mistake at the counter.");
    // The reservation POINTER survives. Nothing is unpicked; the lineage stays readable for ever.
    expect(row.rows[0].reservation_id).toBe(job.reservationId);

    const reservation = await admin.query(`SELECT status, released_at FROM partner_credit_reservations WHERE id=$1`, [
      job.reservationId,
    ]);
    expect(reservation.rows[0].status).toBe("released");
    expect(reservation.rows[0].released_at).not.toBeNull();
  });

  // ---- VOID-AUDIT ---------------------------------------------------------------------------
  it("the super-admin void wrapper persists its exact management-audit action", async () => {
    const f = await makeTenant("void-audit");
    await addCredits(f.tenantId, 1, "void-audit");
    const job = await start(f, "op-void-audit");

    const result = await management.voidPartnerCardJob(
      {
        actorUserId: f.userId,
        actorEmail: "super-admin@mintvault.test",
        requestId: "void-audit-request",
        idempotencyKey: "void-audit-key",
      },
      f.tenantId,
      job.cardJobId,
      "Capture geometry cannot be recovered."
    );

    expect(result.alreadyCompleted).toBe(false);
    expect(result.result).toMatchObject({ cardJobId: job.cardJobId, status: "CANCELLED" });
    const audit = await admin.query<{ action_type: string; result: string }>(
      `SELECT action_type, result FROM partner_management_audit
        WHERE request_id='void-audit-request' ORDER BY created_at`
    );
    expect(audit.rows).toEqual([
      { action_type: "partner_card_job_voided", result: "attempted" },
      { action_type: "partner_card_job_voided", result: "succeeded" },
    ]);
  });

  // ---- CANCEL2 ------------------------------------------------------------------------------
  it("a retried cancellation returns nothing further and is not a second cancellation", async () => {
    const f = await makeTenant("cancel2");
    await addCredits(f.tenantId, 2, "cancel2");
    const job = await start(f, "op-cancel2-aaaa");
    await cancel(f, job.cardJobId);
    expect(await availableFor(f.tenantId)).toBe(2);

    const replay = await cancel(f, job.cardJobId);

    expect(replay.changed).toBe(false);
    expect(replay.reservationReleased).toBe(false);
    expect(replay.status).toBe("CANCELLED");
    // THE POINT OF THE WHOLE SUITE: a second press must not conjure a credit out of nothing.
    expect(await availableFor(f.tenantId)).toBe(2);

    const events = await admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM partner_credit_reservation_events
        WHERE reservation_id=$1 AND event_type='released'`,
      [job.reservationId]
    );
    expect(Number(events.rows[0].n)).toBe(1);
  });

  // ---- CANCEL3 ------------------------------------------------------------------------------
  it("keeps the MV number for ever and never reissues it to the next card", async () => {
    const f = await makeTenant("cancel3");
    await addCredits(f.tenantId, 2, "cancel3");
    const job = await start(f, "op-cancel3-aaaa");

    const result = await cancel(f, job.cardJobId);

    expect(result.mvNumber).toBe(job.mvNumber);
    expect(result.certificateId).toBe(job.certificateId);
    // The certificate is untouched — not deleted, not soft-deleted, not renamed.
    const cert = await admin.query(`SELECT certificate_number, deleted_at, status FROM certificates WHERE id=$1`, [
      job.certificateId,
    ]);
    expect(cert.rows[0].certificate_number).toBe(job.mvNumber);
    expect(cert.rows[0].deleted_at).toBeNull();
    // And the job still carries its identity, so the record reads as a real cancelled card.
    const row = await admin.query(`SELECT mv_number, certificate_id FROM partner_card_jobs WHERE id=$1`, [
      job.cardJobId,
    ]);
    expect(row.rows[0].mv_number).toBe(job.mvNumber);

    // The allocator moved ON, not BACK. A cancelled number is spent, never recycled.
    const next = await start(f, "op-cancel3-bbbb");
    expect(next.mvNumber).not.toBe(job.mvNumber);
    expect(Number(next.mvNumber.slice(2))).toBeGreaterThan(Number(job.mvNumber.slice(2)));
  });

  // ---- CANCEL4 ------------------------------------------------------------------------------
  it("refuses a card that already has an image, and refuses one mid-capture", async () => {
    const f = await makeTenant("cancel4");
    await addCredits(f.tenantId, 4, "cancel4");

    const photographed = await start(f, "op-cancel4-aaaa");
    await admin.query(
      `INSERT INTO certificate_image_evidence (certificate_id, side, is_current, evidence_class, format)
       VALUES ($1,'front',true,'NEW_IMMUTABLE_MASTER','tiff')`,
      [photographed.certificateId]
    );
    const refused = await settle(cancel(f, photographed.cardJobId));
    expect(refused).toEqual({ ok: false, code: "JOB_HAS_EVIDENCE" });
    // Refused means REFUSED: the credit stays reserved and the job stays where it was.
    expect(await reservedFor(f.tenantId)).toBe(1);
    const stillOpen = await admin.query(`SELECT status FROM partner_card_jobs WHERE id=$1`, [photographed.cardJobId]);
    expect(stillOpen.rows[0].status).toBe("NEEDS_SCAN");

    const finalising = await start(f, "op-cancel4-bbbb");
    await admin.query(
      `INSERT INTO scanner_capture_sessions (certificate_id, side, state) VALUES ($1,'front','capturing')`,
      [finalising.certificateId]
    );
    expect(await settle(cancel(f, finalising.cardJobId))).toEqual({ ok: false, code: "CAPTURE_IN_PROGRESS" });
  });

  it("serializes cancellation against a concurrent scanner finalisation before refunding", () => {
    const src = readFileSync("server/partner/card-job-cancellation.ts", "utf8");
    const advisory = src.indexOf("pg_advisory_xact_lock");
    const lock = src.indexOf("await lockActiveCaptureSessionsForCancellation(client, job.certificateId)");
    const assert = src.indexOf("await assertNothingCaptured(client, { certificateId: job.certificateId");
    const release = src.indexOf("await releaseReservationOnce(client");
    expect(src).toContain("hashLockKey(`scanner-capture-certificate:${certificateId}`)");
    expect(src).toMatch(/state IN \('armed', 'claimed', 'capturing'\)[\s\S]*FOR UPDATE/);
    expect(advisory).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(advisory).toBeLessThan(lock);
    expect(assert).toBeGreaterThan(lock);
    expect(release).toBeGreaterThan(assert);
  });

  // ---- CANCEL4b -----------------------------------------------------------------------------
  it("makes an outstanding armed target terminal so a cancelled card cannot be photographed", async () => {
    const f = await makeTenant("cancel4b");
    await addCredits(f.tenantId, 2, "cancel4b");
    const job = await start(f, "op-cancel4b-aaa");
    await admin.query(
      `INSERT INTO scanner_capture_sessions (certificate_id, side, state, station_id)
       VALUES ($1,'front','armed',$2)`,
      [job.certificateId, f.stationId]
    );

    const result = await cancel(f, job.cardJobId);

    expect(result.cancelledCaptureSessions).toBe(1);
    const session = await admin.query(
      `SELECT state, failure_reason FROM scanner_capture_sessions WHERE certificate_id=$1`,
      [job.certificateId]
    );
    expect(session.rows[0].state).toBe("cancelled");
    expect(session.rows[0].failure_reason).toContain("cancelled");
  });

  // ---- CANCEL5 ------------------------------------------------------------------------------
  it("cannot reach another partner's card, and says only that it was not found", async () => {
    const a = await makeTenant("cancel5a");
    const b = await makeTenant("cancel5b");
    await addCredits(a.tenantId, 1, "cancel5a");
    await addCredits(b.tenantId, 1, "cancel5b");
    const theirs = await start(b, "op-cancel5-bbbb");

    // The tenant predicate is in the SQL, so this is genuinely not visible — not merely rejected
    // afterwards. A distinct FORBIDDEN would confirm the id is real and belongs to somebody.
    expect(await settle(cancel(a, theirs.cardJobId))).toEqual({ ok: false, code: "CARD_JOB_NOT_FOUND" });
    expect(await availableFor(b.tenantId)).toBe(0);
    expect(await reservedFor(b.tenantId)).toBe(1);
  });

  // ---- CANCEL6 ------------------------------------------------------------------------------
  it("a cancelled card is inert: it cannot be resurrected and no lifecycle query finds it", async () => {
    const f = await makeTenant("cancel6");
    await addCredits(f.tenantId, 2, "cancel6");
    const job = await start(f, "op-cancel6-aaaa");
    await cancel(f, job.cardJobId);

    // 0080's trigger is ENABLE ALWAYS — terminal means terminal, even to a direct UPDATE.
    await expect(
      admin.query(`UPDATE partner_card_jobs SET status='NEEDS_SCAN' WHERE id=$1`, [job.cardJobId])
    ).rejects.toThrow();

    // And every lineage lookup carries `cancelled_at IS NULL`, so nothing downstream adopts it.
    const lifecycle = await import("../server/partner/card-job-lifecycle");
    const db = await import("../server/partner/db");
    const found = await db.withPartnerAdminTenantTransaction(
      { tenantId: f.tenantId, locationId: f.locationId },
      (client) =>
        lifecycle.findCardJobForCertificate(client, { tenantId: f.tenantId, locationId: null }, job.certificateId)
    );
    expect(found).toBeNull();
  });

  // ---- CANCEL7 ------------------------------------------------------------------------------
  it("two simultaneous cancellations of the same card return exactly one credit", async () => {
    const f = await makeTenant("cancel7");
    await addCredits(f.tenantId, 5, "cancel7");
    const job = await start(f, "op-cancel7-aaaa");
    expect(await availableFor(f.tenantId)).toBe(4);

    // GENUINELY parallel, on separate pool connections. Sequential calls would pass with the row
    // lock removed entirely and would be worse than no test at all.
    const [first, second] = await Promise.all([settle(cancel(f, job.cardJobId)), settle(cancel(f, job.cardJobId))]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const releases = [first, second].filter(
      (r) => r.ok && (r.value as { reservationReleased: boolean }).reservationReleased
    );
    expect(releases).toHaveLength(1);
    expect(await availableFor(f.tenantId)).toBe(5);
    expect(await reservedFor(f.tenantId)).toBe(0);
  });

  // ---- CANCEL8 ------------------------------------------------------------------------------
  it("demands a reason, because an unexplained cancellation cannot be told from an accident", async () => {
    const f = await makeTenant("cancel8");
    await addCredits(f.tenantId, 1, "cancel8");
    const job = await start(f, "op-cancel8-aaaa");

    expect(await settle(cancel(f, job.cardJobId, "   "))).toEqual({ ok: false, code: "REASON_REQUIRED" });
    expect(await reservedFor(f.tenantId)).toBe(1);
  });

  // ---- CANCEL9 ------------------------------------------------------------------------------
  it("writes an audit row naming the operator, the Mac, the MV and what happened to the money", async () => {
    const f = await makeTenant("cancel9");
    await addCredits(f.tenantId, 1, "cancel9");
    const job = await start(f, "op-cancel9-aaaa");

    await cancel(f, job.cardJobId, "Customer changed their mind before any scan.");

    const audit = await admin.query<{
      actor_user_id: string | null;
      device_id: string | null;
      after_value: Record<string, unknown>;
      reason: string | null;
    }>(
      `SELECT actor_user_id, device_id, after_value, reason FROM partner_audit_events
        WHERE record_type='partner_card_job' AND record_id=$1 AND action='partner_card_job_cancelled'`,
      [job.cardJobId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_user_id).toBe(f.userId);
    expect(audit.rows[0].device_id).toBe(f.stationId);
    expect(audit.rows[0].reason).toBe("Customer changed their mind before any scan.");
    expect(audit.rows[0].after_value.mvNumberPreserved).toBe(job.mvNumber);
    expect(audit.rows[0].after_value.reservationReleased).toBe(true);
  });
});
