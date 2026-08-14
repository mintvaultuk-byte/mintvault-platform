/**
 * THE CARD JOB → CANONICAL GRADING BRIDGE, proven against real PostgreSQL.
 *
 * THE DEFECT. Scanner NEW (P6) mints a Card Job, a certificate and an MV in one transaction and
 * deliberately never enters the connector import path. Partner grading resolved ownership ENTIRELY
 * through `partner_connector_imports`. A Scanner Card Job matches zero rows in that chain, so a card
 * a shop had already paid a Grading Credit for could be captured and then never graded: absent from
 * the queue, 404 from the loader, and a write guard that matched nothing while reporting
 * "Card status changed; refresh and try again".
 *
 * Worse, nothing in the repository moved `partner_card_jobs.status` at all beyond FIX_REQUIRED, so
 * the whole lifecycle 0080 defines — CAPTURING, READY_TO_GRADE, GRADING, SUBMITTED, QA_REVIEW,
 * APPROVED — was unreachable. The graph was correct and connected to nothing.
 *
 * WHY EVERY CASE HERE NEEDS A REAL DATABASE. What is under test is SQL and constraints: a five-table
 * JOIN chain that must NOT match, an EXISTS arm that must, 0080's ENABLE ALWAYS transition trigger,
 * RLS tenant isolation, `FOR UPDATE` serialisation, a partial UNIQUE index on the lease, and the
 * credit engine's `(tenant_id, source, idempotency_key)` uniqueness. A mock reproduces none of them,
 * and the two properties that matter most — no double submit and no double settlement on retry —
 * are exactly the ones a mock would pass with the protection deleted.
 *
 * THE CARD JOBS ARE MADE BY THE REAL SCANNER NEW PATH (`startNewCardJobAtStation`), not by hand, so
 * what is proven is the spine an operator actually presses: real credit reservation, real MV
 * allocation, real certificate, real origin snapshot.
 *
 * Numbered AT-B1..AT-B23 against the required hostile bridge matrix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import type { PartnerPrincipal } from "../server/partner/session";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
let lifecycle: typeof import("../server/partner/card-job-lifecycle");
let bridge: typeof import("../server/partner/card-job-grading-bridge");
let leases: typeof import("../server/partner/grading-lease-service");
let grading: typeof import("../server/partner/grading-routes");
let printEligibility: typeof import("../server/partner/print-eligibility");
let drizzle: typeof import("../server/db");
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };

/**
 * A per-process salt for globally-unique fixture identifiers.
 *
 * `partner_stations.station_code` and `partner_organisations.public_ref` are UNIQUE across the whole
 * database, and a disposable cluster can survive a failed run. Salting means a re-run builds fresh
 * fixtures instead of colliding with the previous attempt's leftovers and reporting that as a defect.
 */
const RUN_SALT = Math.random().toString(36).slice(2, 8);
let stationSeq = 0;

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

/**
 * The MintVault-internal tables this path touches, with the columns the code genuinely reads.
 *
 * `certificates` carries the full GRADING column set, not merely identity: the bridge stamps the
 * grader, hands the card to QA and reads `grade_approved_at`. A stub missing those models a database
 * that cannot exist, and would let a broken statement pass.
 *
 * `certificate_image_evidence` and `scanner_capture_sessions` mirror the live DDL in
 * scan-ingest-service.ts / scanner-capture-service.ts, because the "Ready to Grade is a physical
 * capture state" predicate joins all three and is the gate that stops a guessed certificate id
 * appearing in the operational queue.
 */
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
  await admin.query(`CREATE TABLE certificates (
    id serial primary key,
    certificate_number text not null unique,
    card_id integer, submission_item_id integer,
    status text not null default 'active',
    label_type text not null default 'Standard',
    grade_type text not null default 'numeric',
    source text, scan_status text, raw_uploaded boolean not null default false,
    created_by text,
    issued_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    card_game text, set_name text, card_name text, card_number_display text,
    year_text text, language text, variant text,
    assigned_grader_id varchar, assigned_at timestamptz,
    grader_status varchar(20) not null default 'unassigned',
    graded_at timestamptz, graded_by varchar,
    grade_approved_at timestamptz, grade_approved_by varchar,
    review_required boolean, rejection_reason text,
    redo_count integer not null default 0,
    grading_revision integer not null default 1,
    grade numeric,
    centering_score numeric, corners_score numeric, edges_score numeric, surface_score numeric,
    operator_grade numeric, operator_subgrades jsonb,
    print_state varchar(24) not null default 'awaiting_approval',
    origin_type text, origin_partner_id uuid, origin_partner_public_ref text,
    origin_partner_legal_name text, origin_partner_trading_name text,
    origin_location_id uuid, origin_location_public_ref text,
    origin_location_name text, origin_location_address text,
    origin_captured_at timestamptz, origin_snapshot_version integer,
    CONSTRAINT chk_certificates_origin_partner_complete CHECK (
      origin_type IS DISTINCT FROM 'PARTNER'
      OR (origin_partner_id IS NOT NULL
          AND (btrim(coalesce(origin_partner_trading_name,'')) <> ''
               OR btrim(coalesce(origin_partner_legal_name,'')) <> '')
          AND origin_captured_at IS NOT NULL
          AND origin_snapshot_version IS NOT NULL)
    )
  )`);
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
    scanner_profile_version text not null, actor_id text,
    state varchar(16) not null check (state in ('armed','claimed','capturing','captured','failed','expired','cancelled')),
    claimed_by_device_id text, recapture boolean not null default false, failure_reason text,
    created_at timestamptz not null default now(), claimed_at timestamptz,
    captured_at timestamptz, expires_at timestamptz not null
  )`);
  await admin.query(`CREATE TABLE certificate_image_evidence (
    id serial primary key,
    certificate_id integer not null references certificates(id) on delete restrict,
    side varchar(5) not null check (side in ('front','back')),
    evidence_class varchar(32) not null check (evidence_class in ('NEW_IMMUTABLE_MASTER','LEGACY_DERIVED_ONLY')),
    evidence_version varchar(32) not null default 'v1',
    object_key text not null unique,
    sha256 varchar(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
    byte_length bigint not null check (byte_length > 0),
    pixel_width integer not null check (pixel_width > 0),
    pixel_height integer not null check (pixel_height > 0),
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
    "certificates",
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
  const mkLocation = async (ref: string, name: string): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
         VALUES ($1,$2,$2,$3,$4,'ACTIVE') RETURNING id`,
        [`${ref}-${RUN_SALT}`, tenantId, name, "1 High Street"]
      )
    ).rows[0].id;
  const mkUser = async (tag: string): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
         VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
        [`usr-${label}-${tag}-${RUN_SALT}`, tenantId, `${tag}.${label}.${RUN_SALT}@shop.test`]
      )
    ).rows[0].id;

  const locationA = await mkLocation(`loc-${label}-a`, `${label} Rochester`);
  const locationB = await mkLocation(`loc-${label}-b`, `${label} Bluewater`);
  // 0045 requires a real enrolment credential on every station. Synthetic, disposable-DB only —
  // nothing here signs anything; the station exists so the evidence predicate has a real ACTIVE,
  // approved station in the right tenant AND location to join against.
  /*
   * `chk_partner_station_code` demands MV-STN- + 10..24 base32 characters and `station_code` is
   * GLOBALLY unique, so codes are generated to that shape and salted per process. A disposable
   * cluster can outlive a failed run, and a hard-coded code would then collide on the next one and
   * report a fixture clash as a suite failure.
   */
  const mkStation = async (tag: string, locationId: string): Promise<string> => {
    stationSeq += 1;
    const base32 = (raw: string, length: number) =>
      raw
        .toUpperCase()
        .replace(/[^A-Z2-7]/g, "2")
        .padEnd(length, "2")
        .slice(0, length);
    const suffix = base32(`${label}${tag}${RUN_SALT}${stationSeq}`, 16);
    const fingerprint = `${label}${tag}${RUN_SALT}${stationSeq}`
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "0")
      .padEnd(64, "0")
      .slice(0, 64);
    const stationId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_stations
           (tenant_id, location_id, station_code, status, approved_at, public_key_pem, public_key_fingerprint)
         VALUES ($1,$2,$3,'ACTIVE', now(), $4, $5) RETURNING id`,
        [
          tenantId,
          locationId,
          `MV-STN-${suffix}`,
          `-----BEGIN PUBLIC KEY-----\nsynthetic-${stationSeq}\n-----END PUBLIC KEY-----`,
          fingerprint,
        ]
      )
    ).rows[0].id;
    const profileRevisionId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO partner_station_profile_revisions
         (id,station_id,tenant_id,location_id,semantic_operation_id,candidate_digest_sha256,
          profile_digest_sha256,profile,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8)`,
      [profileRevisionId, stationId, tenantId, locationId, crypto.randomUUID(), "a".repeat(64), "b".repeat(64), crypto.randomUUID()]
    );
    await admin.query(
      `UPDATE partner_stations SET current_profile_revision_id=$2 WHERE id=$1`,
      [stationId, profileRevisionId]
    );
    return stationId;
  };

  return {
    label,
    tenantId,
    locationA,
    locationB,
    graderOne: await mkUser("g1"),
    graderTwo: await mkUser("g2"),
    owner: await mkUser("owner"),
    stationA: await mkStation(`ST-${label}-A`, locationA),
    stationB: await mkStation(`ST-${label}-B`, locationB),
  };
}

function principal(
  f: Fixture,
  userId: string,
  opts: { orgWide?: boolean; locationId?: string | null; canGrade?: boolean } = {}
): PartnerPrincipal {
  const permissions = new Set<string>(["partner.dashboard.view", "partner.cards.view"]);
  // SCANNER_OPERATOR holds cards.scan + cards.view and NEVER cards.assess (AG-2).
  if (opts.canGrade === false) permissions.add("partner.cards.scan");
  else permissions.add("partner.cards.assess");
  return {
    sessionId: "00000000-0000-0000-0000-0000000000ff",
    tenantId: f.tenantId,
    userId,
    locationId: opts.locationId === undefined ? f.locationA : opts.locationId,
    mfaPassed: true,
    permissions,
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: opts.orgWide ?? false,
  };
}

async function addCredits(tenantId: string, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, tenantId);
  await wallet.appendFoundationCredit(adminActor, {
    tenantId,
    amount,
    entryType: "purchase",
    source: "admin",
    reason: "bridge suite credits",
    idempotencyKey: key,
    actorType: "admin",
  });
}

let opSeq = 0;

/** Press NEW at a station — the real P6 path, producing a real Card Job / MV / certificate. */
async function scannerNew(
  f: Fixture,
  opts: { locationId?: string; stationId?: string; cardName?: string } = {}
): Promise<{ cardJobId: string; certificateId: number; mvNumber: string }> {
  opSeq += 1;
  const result = await authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId: opts.locationId ?? f.locationA,
    stationId: opts.stationId ?? f.stationA,
    clientOpId: `bridge-op-${f.label}-${opSeq}-${Date.now()}`,
    actorUserId: f.graderOne,
    actorEmail: "operator@shop.test",
    cardName: opts.cardName ?? "Charizard",
  });
  return { cardJobId: result.cardJobId, certificateId: result.certificateId, mvNumber: result.mvNumber };
}

let evidenceSeq = 0;

/**
 * Accept ONE side on a station — the evidence shape the queue and the lifecycle both require.
 *
 * Writes the terminal capture session AND the current immutable TIFF master, linked by
 * `capture_metadata->>'captureSessionId'`, because every gate in the system joins them that way. A
 * row missing either half proves nothing.
 */
async function captureSide(
  f: Fixture,
  certificateId: number,
  side: "front" | "back",
  stationId?: string
): Promise<void> {
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

/** A Scanner card captured on both sides and advanced to READY_TO_GRADE through the real bridge. */
async function readyToGradeCard(
  f: Fixture,
  opts: { locationId?: string; stationId?: string } = {}
): Promise<{ cardJobId: string; certificateId: number; mvNumber: string }> {
  const card = await scannerNew(f, opts);
  await captureSide(f, card.certificateId, "front", opts.stationId);
  await lifecycle.advanceCardJobAfterCapture(card.certificateId);
  await captureSide(f, card.certificateId, "back", opts.stationId);
  await lifecycle.advanceCardJobAfterCapture(card.certificateId);
  return card;
}

async function jobStatus(cardJobId: string): Promise<string> {
  const { rows } = await admin.query<{ status: string }>(`SELECT status FROM partner_card_jobs WHERE id=$1`, [
    cardJobId,
  ]);
  return rows[0]?.status ?? "MISSING";
}

async function certRow(certificateId: number): Promise<Record<string, unknown>> {
  const { rows } = await admin.query(`SELECT * FROM certificates WHERE id=$1`, [certificateId]);
  return rows[0] as Record<string, unknown>;
}

async function reservationStatus(cardJobId: string): Promise<string | null> {
  const { rows } = await admin.query<{ status: string }>(
    `SELECT r.status FROM partner_card_jobs j
       JOIN partner_credit_reservations r ON r.id = j.reservation_id
      WHERE j.id = $1`,
    [cardJobId]
  );
  return rows[0]?.status ?? null;
}

/** How many times this reservation was actually DEBITED. The double-settlement detector. */
async function consumeEventCount(cardJobId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM partner_card_jobs j
       JOIN partner_credit_reservation_events e ON e.reservation_id = j.reservation_id
      WHERE j.id = $1 AND e.event_type = 'consumed'`,
    [cardJobId]
  );
  return Number(rows[0]?.n ?? 0);
}

async function ledgerDebitCount(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0`,
    [tenantId]
  );
  return Number(rows[0]?.n ?? 0);
}

async function auditActions(cardJobId: string): Promise<string[]> {
  const { rows } = await admin.query<{ action: string }>(
    `SELECT action FROM partner_audit_events
      WHERE record_type='partner_card_job' AND record_id=$1 ORDER BY id`,
    [cardJobId]
  );
  return rows.map((r) => r.action);
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

/**
 * Run the draft-write guard in the EXACT composition applyCertGradeDraft builds:
 *   UPDATE certificates SET ... WHERE id = ? AND grade_approved_at IS NULL <guard> RETURNING id
 * so what is proven is the statement that actually runs in production, not a paraphrase of it.
 */
async function runDraftWriteGuard(p: PartnerPrincipal, certificateId: number): Promise<number> {
  const auth = await grading.loadPartnerCert(p, certificateId);
  if (!auth) return -1;
  const { sql } = await import("drizzle-orm");
  const guard = grading.partnerDraftWriteGuard(p, auth);
  const result = await drizzle.db.execute(sql`
    UPDATE certificates SET card_name = 'GUARD-WROTE', updated_at = NOW()
     WHERE id = ${certificateId} AND grade_approved_at IS NULL ${guard}
    RETURNING id
  `);
  return result.rows.length;
}

let shopA: Fixture;
let shopB: Fixture;

describe("Card Job → canonical grading bridge (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-card-job-bridge");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    /*
     * 0081 is deliberately ABSENT. It rewrites `partner_allocate_import_certificates()` — the
     * CONNECTOR allocation path — which the Scanner spine never enters: `startNewCardJobAtStation`
     * stamps certificate_id and mv_number at INSERT, inside the same transaction that pays for them.
     * Applying it here would add a definer-role dependency this suite has no use for and prove
     * nothing about the bridge.
     */
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      "0045_partner_stations",
      "0046_scanner_processing_jobs",
      "0047_scanner_evidence_staging",
      "0075_partner_station_single_active_capture",
      "0087_partner_grading_edit_lease",
      "0091_scanner_station_v2_authority",
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
    grading = await import("../server/partner/grading-routes");
    printEligibility = await import("../server/partner/print-eligibility");
    drizzle = await import("../server/db");

    shopA = await makeTenant("alpha");
    shopB = await makeTenant("beta");
    await addCredits(shopA.tenantId, 60, `bridge-alpha-credits-${RUN_SALT}`);
    await addCredits(shopB.tenantId, 20, `bridge-beta-credits-${RUN_SALT}`);
  }, 240_000);

  afterAll(async () => {
    /*
     * Close EVERY pool before the container goes away.
     *
     * The HQ Drizzle pool (server/db.ts) is opened by the print-eligibility and write-guard proofs,
     * and it is not one of the Partner pools. Leaving it open means its idle connections are killed
     * by the container stopping, which surfaces as "terminating connection due to administrator
     * command" unhandled rejections — noise that can redden an otherwise green run.
     */
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

  /* ============================================================================================
   * AT-B1 — a Scanner NEW Card Job actually becomes Ready to Grade.
   * ========================================================================================== */
  it("AT-B1: Scanner NEW starts at NEEDS_SCAN and reaches READY_TO_GRADE only once BOTH sides are accepted", async () => {
    const card = await scannerNew(shopA);
    // The state nothing in the repository could previously leave.
    expect(await jobStatus(card.cardJobId)).toBe("NEEDS_SCAN");

    await captureSide(shopA, card.certificateId, "front");
    const afterFront = await lifecycle.advanceCardJobAfterCapture(card.certificateId);
    expect(afterFront?.readyToGrade).toBe(false);
    // One side is capture UNDER WAY, never gradeable. 0080 has no NEEDS_SCAN → READY_TO_GRADE edge,
    // so the intermediate hop is mandatory rather than cosmetic.
    expect(await jobStatus(card.cardJobId)).toBe("CAPTURING");

    await captureSide(shopA, card.certificateId, "back");
    const afterBack = await lifecycle.advanceCardJobAfterCapture(card.certificateId);
    expect(afterBack?.readyToGrade).toBe(true);
    expect(await jobStatus(card.cardJobId)).toBe("READY_TO_GRADE");

    // Idempotent: a retried or duplicated accept promotes nothing a second time.
    const again = await lifecycle.advanceCardJobAfterCapture(card.certificateId);
    expect(again?.readyToGrade).toBe(false);
    expect(await jobStatus(card.cardJobId)).toBe("READY_TO_GRADE");
    expect(await auditActions(card.cardJobId)).toEqual([
      "partner_card_job_started",
      "partner_card_job_capturing",
      "partner_card_job_ready_to_grade",
    ]);
  });

  it("AT-B1b: a card captured on a station in ANOTHER location never becomes ready to grade", async () => {
    const card = await scannerNew(shopA);
    // Both sides accepted, but on the wrong shop floor's station.
    await captureSide(shopA, card.certificateId, "front", shopA.stationB);
    await captureSide(shopA, card.certificateId, "back", shopA.stationB);
    await lifecycle.advanceCardJobAfterCapture(card.certificateId);
    expect(await jobStatus(card.cardJobId)).toBe("CAPTURING");
  });

  /* ============================================================================================
   * AT-B1c — the REAL arm gate accepts a walk-in Card Job certificate (AT-23 §B regression).
   *
   * captureSide() above inserts terminal sessions directly, so createScannerCaptureSession()'s own
   * gates were never exercised here — and on staging its card/submission binding gate threw before
   * the walk-in Card-Job branch could run, refusing every Scanner-started card at first capture.
   * This drives the real service: a station-scoped walk-in certificate (card_id NULL) must arm, a
   * station in another location must be refused, and a stationless arm of an unbound certificate
   * must stay refused exactly as before.
   * ========================================================================================== */
  it("AT-B1c: createScannerCaptureSession arms a walk-in Card Job certificate on its own station only", async () => {
    // 0075's one-active-per-station invariant, which the service verifies before arming.
    await admin.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_one_active_station
      ON scanner_capture_sessions (station_id)
      WHERE station_id IS NOT NULL AND state IN ('armed', 'claimed', 'capturing')`);
    const captures = await import("../server/scanner-capture-service");
    const card = await scannerNew(shopA);

    // Own station, own location: arms.
    const session = await captures.createScannerCaptureSession({
      certificateId: card.certificateId,
      side: "front",
      workstationId: "MV-STN-B1CTESTAA22",
      stationId: shopA.stationA,
      actorId: shopA.graderOne,
      recapture: false,
      scannerProfileVersion: "mintvault-canon-lide-400-v3",
    });
    expect(session.state).toBe("armed");
    expect(session.certificateId).toBe(card.certificateId);

    // The signed-station claim path must actually execute (its station-scoped query previously
    // bound a parameter PostgreSQL could not type, so it had never run) and must return THIS
    // station's armed session.
    const claimed = await captures.claimNextScannerCapture("MV-STN-B1CTESTAA22", "MV-STN-B1CTESTAA22", shopA.stationA);
    expect(claimed?.id).toBe(session.id);
    expect(claimed?.state).toBe("claimed");
    await admin.query("UPDATE scanner_capture_sessions SET state='cancelled' WHERE id=$1", [session.id]);

    // Another location's station: refused — the walk-in path is scoped, not open.
    await expect(
      captures.createScannerCaptureSession({
        certificateId: card.certificateId,
        side: "front",
        workstationId: "MV-STN-B1CTESTAA22",
        stationId: shopA.stationB,
        actorId: shopA.graderOne,
        recapture: false,
        scannerProfileVersion: "mintvault-canon-lide-400-v3",
      })
    ).rejects.toThrow(/must be bound|not bound/i);

    // No station principal at all: the legacy binding gate stands untouched.
    await expect(
      captures.createScannerCaptureSession({
        certificateId: card.certificateId,
        side: "front",
        workstationId: "LEGACY-DESK",
        stationId: null,
        actorId: shopA.graderOne,
        recapture: false,
        scannerProfileVersion: "mintvault-canon-lide-400-v3",
      })
    ).rejects.toThrow(/must be bound/i);
  });

  /* ============================================================================================
   * AT-B2 / AT-B6 — a Partner grader can open a Scanner Card Job at all.
   * ========================================================================================== */
  it("AT-B2/AT-B6: a grader opens a Scanner Card Job — the lease is granted and the job enters GRADING", async () => {
    const card = await readyToGradeCard(shopA);
    const p = principal(shopA, shopA.graderOne);

    const result = await leases.acquireLease(p, card.cardJobId, "Ada");
    expect(result.lease.heldByYou).toBe(true);
    expect(await jobStatus(card.cardJobId)).toBe("GRADING");

    // The lease is the ASSIGNMENT authority: the certificate is stamped with whoever took the card,
    // having had no assigned grader at all until this moment.
    const cert = await certRow(card.certificateId);
    expect(cert.assigned_grader_id).toBe(shopA.graderOne);
    expect(cert.grader_status).toBe("assigned");

    // And the canonical loader now resolves it by CARD JOB lineage, not connector.
    const auth = await grading.loadPartnerCert(p, card.certificateId);
    expect(auth?.lineage).toBe("card_job");
    expect(auth?.cardJobId).toBe(card.cardJobId);
    expect(auth?.cardJobStatus).toBe("GRADING");
    expect(auth?.destinationSubmissionId).toBeNull();
    expect(grading.authorizeAssignedPartnerCert(p, auth).ok).toBe(true);
  });

  it("AT-B2b: a Card Job with NO assigned grader is still loadable — the defect that blocked every Scanner card", async () => {
    const card = await readyToGradeCard(shopA);
    const p = principal(shopA, shopA.graderTwo);
    // Nobody has taken the lease, so assigned_grader_id is NULL. The old rule
    // (`assigned_grader_id === principal.userId`) made this permanently 403/404.
    const cert = await certRow(card.certificateId);
    expect(cert.assigned_grader_id).toBeNull();
    const auth = await grading.loadPartnerCert(p, card.certificateId);
    expect(auth?.lineage).toBe("card_job");
    expect(grading.authorizeAssignedPartnerCert(p, auth).ok).toBe(true);
  });

  /* ============================================================================================
   * AT-B3 — SCANNER_OPERATOR cannot grade.
   * ========================================================================================== */
  it("AT-B3: SCANNER_OPERATOR (no partner.cards.assess) cannot acquire, heartbeat, take over or write", async () => {
    const card = await readyToGradeCard(shopA);
    const operator = principal(shopA, shopA.graderTwo, { canGrade: false });
    expect(operator.permissions.has("partner.cards.assess")).toBe(false);

    for (const attempt of [
      () => leases.acquireLease(operator, card.cardJobId, "Scanner"),
      () => leases.heartbeatLease(operator, card.cardJobId),
      () => leases.takeoverLease(operator, card.cardJobId, "because"),
    ]) {
      const outcome = await settle(attempt());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
    }
    // And the job is untouched — a refused grader starts nothing.
    expect(await jobStatus(card.cardJobId)).toBe("READY_TO_GRADE");
  });

  /* ============================================================================================
   * AT-B4 / AT-B5 — cross-tenant and cross-location probing.
   * ========================================================================================== */
  it("AT-B4: Partner B cannot discover or open Partner A's card by Card Job id, certificate id or MV", async () => {
    const card = await readyToGradeCard(shopA);
    const intruder = principal(shopB, shopB.graderOne, { orgWide: true, locationId: shopB.locationA });

    // By Card Job id — the same answer an absent id gets, never a distinct 403 that would confirm
    // the id is real and belongs to somebody.
    const byJob = await settle(leases.acquireLease(intruder, card.cardJobId));
    expect(byJob.ok).toBe(false);
    if (!byJob.ok) expect(byJob.code).toBe("CARD_JOB_NOT_FOUND");
    const readJob = await settle(leases.getLease(intruder, card.cardJobId));
    expect(readJob.ok).toBe(false);
    if (!readJob.ok) expect(readJob.code).toBe("CARD_JOB_NOT_FOUND");

    // By certificate id.
    expect(await grading.loadPartnerCert(intruder, card.certificateId)).toBeNull();

    // By MV number — no Partner-facing lookup resolves another tenant's MV to a job.
    const { rows } = await admin.query(`SELECT id FROM partner_card_jobs WHERE mv_number = $1 AND tenant_id = $2`, [
      card.mvNumber,
      shopB.tenantId,
    ]);
    expect(rows).toHaveLength(0);

    // Nothing about the card moved.
    expect(await jobStatus(card.cardJobId)).toBe("READY_TO_GRADE");
  });

  it("AT-B5: a location-scoped grader cannot reach a card on another shop floor", async () => {
    const card = await readyToGradeCard(shopA, { locationId: shopA.locationB, stationId: shopA.stationB });
    const scoped = principal(shopA, shopA.graderOne, { locationId: shopA.locationA });

    const outcome = await settle(leases.acquireLease(scoped, card.cardJobId));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("CARD_JOB_NOT_FOUND");
    expect(await grading.loadPartnerCert(scoped, card.certificateId)).toBeNull();

    // The grader entitled to that floor CAN.
    const entitled = principal(shopA, shopA.graderOne, { locationId: shopA.locationB });
    const auth = await grading.loadPartnerCert(entitled, card.certificateId);
    expect(auth?.lineage).toBe("card_job");
  });

  /* ============================================================================================
   * AT-B7 / AT-B8 / AT-B9 / AT-B10 — one editor at a time, on a Scanner card.
   * ========================================================================================== */
  it("AT-B7: a second grader is refused the lease and cannot write", async () => {
    const card = await readyToGradeCard(shopA);
    const first = principal(shopA, shopA.graderOne);
    const second = principal(shopA, shopA.graderTwo);
    await leases.acquireLease(first, card.cardJobId, "Ada");

    const blocked = await settle(leases.acquireLease(second, card.cardJobId, "Grace"));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("LEASE_HELD_BY_ANOTHER");

    // The write authority refuses before any grade is touched...
    const guarded = await settle(leases.assertMayWriteCertificate(second, card.certificateId, 1));
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.code).toBe("NOT_LEASE_HOLDER");

    // ...and so does SUBMIT itself, in the transaction that would have spent the Grading Credit.
    // The route's lease check commits separately, so a settlement that consumes real money must not
    // depend on the caller having remembered to ask permission first.
    const write = await settle(bridge.submitCardJobForReview(second, card.certificateId));
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.code).toBe("NOT_LEASE_HOLDER");
    expect(await jobStatus(card.cardJobId)).toBe("GRADING");
    expect(await reservationStatus(card.cardJobId)).toBe("active");

    // The genuine holder still can.
    const ok = await bridge.submitCardJobForReview(first, card.certificateId);
    expect(ok.submitted).toBe(true);
    expect(ok.creditSettled).toBe(true);
  });

  it("AT-B8: the heartbeat extends a live lease and refuses a non-holder", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    const other = principal(shopA, shopA.graderTwo);
    const acquired = await leases.acquireLease(holder, card.cardJobId, "Ada");

    const beat = await leases.heartbeatLease(holder, card.cardJobId);
    expect(beat.heldByYou).toBe(true);
    expect(new Date(beat.expiresAt).getTime()).toBeGreaterThanOrEqual(new Date(acquired.lease.expiresAt).getTime());

    const refused = await settle(leases.heartbeatLease(other, card.cardJobId));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("LEASE_EXPIRED");
  });

  it("AT-B9/AT-B10: a takeover is permissioned, reasoned and audited — and the displaced grader cannot write", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    const manager = principal(shopA, shopA.owner, { orgWide: true });
    const acquired = await leases.acquireLease(holder, card.cardJobId, "Ada");

    // A location-scoped colleague may not seize the card, and no reason means no takeover.
    const scoped = await settle(leases.takeoverLease(principal(shopA, shopA.graderTwo), card.cardJobId, "mine now"));
    expect(scoped.ok).toBe(false);
    if (!scoped.ok) expect(scoped.code).toBe("FORBIDDEN");
    const unexplained = await settle(leases.takeoverLease(manager, card.cardJobId, "   "));
    expect(unexplained.ok).toBe(false);
    if (!unexplained.ok) expect(unexplained.code).toBe("FORBIDDEN");

    const seized = await leases.takeoverLease(manager, card.cardJobId, "Grader went home mid-card", "Owner");
    expect(seized.heldByYou).toBe(true);
    // The revision CARRIES OVER, so the displaced grader's stale form cannot look current again.
    expect(seized.revision).toBeGreaterThan(acquired.lease.revision);

    const { rows } = await admin.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM partner_audit_events
        WHERE record_id = $1 AND action = 'partner_grading_lease_taken_over'`,
      [card.cardJobId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("Grader went home mid-card");

    // AT-B10: the former holder is refused, holding a revision that WAS current.
    const stale = await settle(leases.assertMayWriteCertificate(holder, card.certificateId, acquired.lease.revision));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("NOT_LEASE_HOLDER");

    // The card stays open for grading and now names the NEW grader.
    expect(await jobStatus(card.cardJobId)).toBe("GRADING");
    expect((await certRow(card.certificateId)).assigned_grader_id).toBe(shopA.owner);
  });

  /* ============================================================================================
   * AT-B11 — the write guard: the UPDATE must genuinely match and write.
   * ========================================================================================== */
  it("AT-B11: the Card Job write guard matches and WRITES in GRADING, and matches nothing otherwise", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);

    // READY_TO_GRADE — nobody has opened it, so no draft may land.
    expect(await runDraftWriteGuard(holder, card.certificateId)).toBe(0);

    await leases.acquireLease(holder, card.cardJobId, "Ada");
    // GRADING — the guard matches and the row is genuinely written. This is the exact composition
    // applyCertGradeDraft builds; before the Card Job arm existed it matched ZERO rows and the
    // operator was told "Card status changed; refresh and try again".
    expect(await runDraftWriteGuard(holder, card.certificateId)).toBe(1);
    expect((await certRow(card.certificateId)).card_name).toBe("GUARD-WROTE");

    // A grader on the wrong floor gets no row even in GRADING.
    const wrongFloor = principal(shopA, shopA.graderOne, { locationId: shopA.locationB });
    expect(await runDraftWriteGuard(wrongFloor, card.certificateId)).toBe(-1);

    // Another tenant gets no row.
    const intruder = principal(shopB, shopB.graderOne);
    expect(await runDraftWriteGuard(intruder, card.certificateId)).toBe(-1);
  });

  it("AT-B11b: the workstation can AUTOSAVE — one generation, many writes — and a foreign generation cannot", async () => {
    /*
     * The revision is an editing-SESSION generation, not a per-write counter. It used to be bumped on
     * every accepted write, which made the SECOND autosave from the rightful holder fail
     * STALE_REVISION — an unusable workstation rather than a safety property, and the reason this UX
     * could not previously be wired honestly. Replay protection lives on the irreversible edge
     * (submit), where the Card Job transition and the credit idempotency key enforce it, rather than
     * being approximated by a counter on every keystroke.
     */
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    const acquired = await leases.acquireLease(holder, card.cardJobId, "Ada");
    const current = acquired.lease.revision;

    for (let i = 0; i < 3; i += 1) {
      const authority = await leases.assertMayWriteCertificate(holder, card.certificateId, current);
      expect(authority).toEqual({ cardJobId: card.cardJobId, revision: current });
      // And each of those writes genuinely lands, rather than merely being authorised.
      expect(await runDraftWriteGuard(holder, card.certificateId)).toBe(1);
    }

    const foreign = await settle(leases.assertMayWriteCertificate(holder, card.certificateId, current + 1));
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("STALE_REVISION");
  });

  /* ============================================================================================
   * AT-B12 / AT-B13 / AT-B14 — submit, and the two things a retry must never do.
   * ========================================================================================== */
  it("AT-B12: submit moves the Card Job to QA_REVIEW, hands the certificate to QA and settles the credit once", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    expect(await reservationStatus(card.cardJobId)).toBe("active");

    const result = await bridge.submitCardJobForReview(holder, card.certificateId);
    expect(result.submitted).toBe(true);
    expect(result.creditSettled).toBe(true);
    expect(result.status).toBe("QA_REVIEW");
    expect(await jobStatus(card.cardJobId)).toBe("QA_REVIEW");

    const cert = await certRow(card.certificateId);
    expect(cert.grader_status).toBe("pending_review");
    expect(cert.review_required).toBe(true);
    expect(cert.graded_by).toBe(shopA.graderOne);

    // Migration 0080 calls SUBMITTED "credit consumed exactly once at this edge". It now is.
    expect(await reservationStatus(card.cardJobId)).toBe("consumed");
    expect(await consumeEventCount(card.cardJobId)).toBe(1);

    // Both edges are audited, in order.
    const actions = await auditActions(card.cardJobId);
    expect(actions).toContain("partner_card_job_submitted");
    expect(actions).toContain("partner_card_job_qa_review");
    expect(actions.indexOf("partner_card_job_submitted")).toBeLessThan(actions.indexOf("partner_card_job_qa_review"));
  });

  it("AT-B13/AT-B14: a retried submit is a REPLAY — no second transition, no second debit", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    const debitsBefore = await ledgerDebitCount(shopA.tenantId);

    const first = await bridge.submitCardJobForReview(holder, card.certificateId);
    expect(first.submitted).toBe(true);
    expect(first.creditSettled).toBe(true);

    const retry = await bridge.submitCardJobForReview(holder, card.certificateId);
    expect(retry.submitted).toBe(false);
    expect(retry.creditSettled).toBe(false);
    expect(retry.status).toBe("QA_REVIEW");

    // ONE debit, ONE consume event, ONE submit audit — however many times the client retried.
    expect(await consumeEventCount(card.cardJobId)).toBe(1);
    expect(await ledgerDebitCount(shopA.tenantId)).toBe(debitsBefore + 1);
    const actions = await auditActions(card.cardJobId);
    expect(actions.filter((a) => a === "partner_card_job_submitted")).toHaveLength(1);
  });

  it("AT-B14b: two CONCURRENT submits settle exactly one credit — the race, not the sequence", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    const debitsBefore = await ledgerDebitCount(shopA.tenantId);

    // Genuinely parallel, on separate pool connections. Run sequentially this would pass with the
    // row lock removed entirely, which is worse than having no test.
    const [a, b] = await Promise.all([
      settle(bridge.submitCardJobForReview(holder, card.certificateId)),
      settle(bridge.submitCardJobForReview(holder, card.certificateId)),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const settledCount = [a, b].filter((r) => r.ok && (r.value as { creditSettled: boolean }).creditSettled).length;
    expect(settledCount).toBe(1);
    expect(await consumeEventCount(card.cardJobId)).toBe(1);
    expect(await ledgerDebitCount(shopA.tenantId)).toBe(debitsBefore + 1);
    expect(await jobStatus(card.cardJobId)).toBe("QA_REVIEW");
  });

  it("AT-B12b: a card that was never opened for grading cannot be submitted", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    const outcome = await settle(bridge.submitCardJobForReview(holder, card.certificateId));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NOT_GRADING");
    expect(await reservationStatus(card.cardJobId)).toBe("active");
  });

  /* ============================================================================================
   * AT-B15 / AT-B16 — Super Admin QA receives the card; the Partner cannot self-approve.
   * ========================================================================================== */
  it("AT-B15: a Scanner Card Job reaches Super Admin Pending Review WITHOUT any connector row", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    await bridge.submitCardJobForReview(holder, card.certificateId);

    // The Super Admin review queue is HQ-wide over `certificates` and does NOT join Partner tables,
    // so this is the predicate that surface actually uses.
    const { rows } = await admin.query<{ id: number }>(
      `SELECT id FROM certificates WHERE deleted_at IS NULL AND grader_status = 'pending_review' AND id = $1`,
      [card.certificateId]
    );
    expect(rows).toHaveLength(1);

    // And no connector row was manufactured to get it there.
    const mappings = await admin.query(`SELECT 1 FROM partner_connector_imports WHERE partner_organisation_id = $1`, [
      shopA.tenantId,
    ]);
    expect(mappings.rows).toHaveLength(0);
  });

  it("AT-B16: a Partner cannot self-approve, and cannot edit the card while QA holds it", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    await bridge.submitCardJobForReview(holder, card.certificateId);

    // No Partner-reachable transition publishes a grade: QA_REVIEW → APPROVED is refused from the
    // Partner surface, and the certificate is still unpublished.
    const auth = await grading.loadPartnerCert(holder, card.certificateId);
    expect(auth?.cardJobStatus).toBe("QA_REVIEW");
    const editable = grading.draftEditability(auth!, holder);
    expect(editable.ok).toBe(false);

    // The draft write guard matches nothing while the job is not GRADING.
    expect(await runDraftWriteGuard(holder, card.certificateId)).toBe(0);
    expect((await certRow(card.certificateId)).grade_approved_at).toBeNull();
  });

  /* ============================================================================================
   * AT-B17 / AT-B18 — RETURN and APPROVE.
   * ========================================================================================== */
  it("AT-B17: RETURN TO GRADER preserves the Card Job, MV and certificate lineage and its history", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    await bridge.submitCardJobForReview(holder, card.certificateId);

    const returned = await lifecycle.returnCardJobToGraderForCertificate(
      card.certificateId,
      "qa@mintvault.test",
      "Centering needs a second look"
    );
    expect(returned?.changed).toBe(true);
    expect(await jobStatus(card.cardJobId)).toBe("GRADING");

    // SAME job, SAME MV, SAME certificate — nothing was re-minted.
    const { rows } = await admin.query<{ mv_number: string; certificate_id: number }>(
      `SELECT mv_number, certificate_id FROM partner_card_jobs WHERE id=$1`,
      [card.cardJobId]
    );
    expect(rows[0].mv_number).toBe(card.mvNumber);
    expect(Number(rows[0].certificate_id)).toBe(card.certificateId);

    // The credit was already settled at submit and is NOT re-settled by a return.
    expect(await consumeEventCount(card.cardJobId)).toBe(1);

    // The grader can work on it again; the audit trail records the return.
    expect(await auditActions(card.cardJobId)).toContain("partner_card_job_returned_to_grader");
    const auth = await grading.loadPartnerCert(holder, card.certificateId);
    expect(grading.draftEditability(auth!, holder).ok).toBe(true);
    expect(await runDraftWriteGuard(holder, card.certificateId)).toBe(1);
  });

  it("AT-B18: APPROVE moves the Card Job to APPROVED and begins output eligibility", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    await bridge.submitCardJobForReview(holder, card.certificateId);

    const approved = await lifecycle.approveCardJobForCertificate(card.certificateId, "qa@mintvault.test");
    expect(approved?.changed).toBe(true);
    expect(await jobStatus(card.cardJobId)).toBe("APPROVED");
    expect(await auditActions(card.cardJobId)).toContain("partner_card_job_qa_approved");
    // Idempotent — a retried approval does not re-transition.
    expect((await lifecycle.approveCardJobForCertificate(card.certificateId, "qa@mintvault.test"))?.changed).toBe(
      false
    );
  });

  /* ============================================================================================
   * AT-B19 — output eligibility must not require a connector mapping that cannot exist.
   * ========================================================================================== */
  it("AT-B19: a fully approved Scanner card is print-eligible WITHOUT any connector mapping", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    await bridge.submitCardJobForReview(holder, card.certificateId);

    // Still in QA — output is refused, but for the RIGHT reason: the job's own state, never a
    // connector mapping it can never have.
    const held = await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber]);
    expect(held.map((b) => b.code)).toEqual(["partner_card_job_state_invalid"]);
    expect(held.map((b) => b.code)).not.toContain("partner_mapping_invalid");

    // Complete QA exactly as the Super Admin path does.
    await lifecycle.approveCardJobForCertificate(card.certificateId, "qa@mintvault.test");
    await admin.query(
      `UPDATE certificates
          SET grader_status='approved', review_required=true, grade_approved_at=now(),
              grade_approved_by='qa@mintvault.test', print_state='needs_printing'
        WHERE id=$1`,
      [card.certificateId]
    );

    const blocks = await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber]);
    expect(blocks).toEqual([]);
  });

  it("AT-B19b: output stays blocked when the Card Job's own requirements are unmet", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");
    await bridge.submitCardJobForReview(holder, card.certificateId);
    await lifecycle.approveCardJobForCertificate(card.certificateId, "qa@mintvault.test");

    // QA state not actually complete on the certificate → still blocked, and never as a mapping fault.
    const beforeQa = await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber]);
    expect(beforeQa.map((b) => b.code)).toEqual(["partner_qa_incomplete"]);

    await admin.query(
      `UPDATE certificates
          SET grader_status='approved', review_required=true, grade_approved_at=now(),
              grade_approved_by='qa@mintvault.test', print_state='awaiting_approval'
        WHERE id=$1`,
      [card.certificateId]
    );
    const badPrintState = await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber]);
    expect(badPrintState.map((b) => b.code)).toEqual(["partner_print_state_invalid"]);
  });

  /* ============================================================================================
   * AT-B20 / AT-B21 — the legacy lineage, and no duplicates.
   * ========================================================================================== */
  it("AT-B20: connector-lineage protections are untouched — the guard still demands the assigned grader", async () => {
    // A Partner-origin certificate with NO Card Job and NO connector import: the connector arm must
    // still refuse it, so nothing about this repair globally loosened the legacy path.
    const { rows } = await admin.query<{ id: number }>(
      `INSERT INTO certificates
         (certificate_number, origin_type, origin_partner_id, origin_partner_legal_name,
          origin_location_id, origin_captured_at, origin_snapshot_version,
          assigned_grader_id, grader_status)
       VALUES ($1,'PARTNER',$2,'Alpha Ltd',$3, now(), 1, $4, 'assigned')
       RETURNING id`,
      [`MV-LEGACY-${Date.now()}`, shopA.tenantId, shopA.locationA, shopA.graderOne]
    );
    const legacyCertId = rows[0].id;
    const p = principal(shopA, shopA.graderOne);

    // No Card Job and no valid import ⇒ the loader resolves nothing at all.
    expect(await grading.loadPartnerCert(p, legacyCertId)).toBeNull();
    expect(await runDraftWriteGuard(p, legacyCertId)).toBe(-1);
  });

  it("AT-B21: the loader prefers Card Job lineage, so a card resolves exactly once", async () => {
    const card = await readyToGradeCard(shopA);
    const p = principal(shopA, shopA.graderOne);
    const auth = await grading.loadPartnerCert(p, card.certificateId);
    expect(auth?.lineage).toBe("card_job");
    // Exactly one Card Job can ever back a certificate — 0080's unique index, not a convention.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_card_jobs WHERE certificate_id = $1`,
      [card.certificateId]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  /* ============================================================================================
   * AT-B22 / AT-B23 — the grading authority itself is untouched.
   * ========================================================================================== */
  it("AT-B22/AT-B23: the bridge moves lifecycle and settles credit — it never computes or writes a grade", async () => {
    const card = await readyToGradeCard(shopA);
    const holder = principal(shopA, shopA.graderOne);
    await leases.acquireLease(holder, card.cardJobId, "Ada");

    // A grade the SERVER put there. The bridge must carry it, never derive it.
    await admin.query(
      `UPDATE certificates
          SET grade = 9.5, centering_score = 9, corners_score = 10, edges_score = 9, surface_score = 10
        WHERE id = $1`,
      [card.certificateId]
    );
    await bridge.submitCardJobForReview(holder, card.certificateId);

    const cert = await certRow(card.certificateId);
    expect(Number(cert.grade)).toBe(9.5);
    // operator_grade/operator_subgrades are a SNAPSHOT of what the server already held, so a later
    // QA decision can be compared against what the grader actually submitted.
    expect(Number(cert.operator_grade)).toBe(9.5);
    expect(cert.operator_subgrades).toEqual({ centering: 9, corners: 10, edges: 9, surface: 10 });
    // Nothing recomputed the overall from the subgrades.
    expect(Number(cert.grade)).toBe(9.5);
  });

  it("AT-B23b: the module's transition graph is the one the DATABASE enforces", async () => {
    // The duplicated LEGAL_TRANSITIONS table is PROVEN equal to 0080's trigger rather than asserted
    // equal in a comment: a future migration widening the graph without updating the module fails
    // here, not in production.
    // Read the trigger body over the suite's OWN admin connection. Opening a fresh client here and
    // leaving it connected is what previously surfaced as a teardown "terminating connection due to
    // administrator command" when the disposable container stopped.
    const source = await lifecycle.databaseTransitionGraphSource(admin as unknown as import("pg").PoolClient);
    for (const [from, to] of lifecycle.legalCardJobTransitions()) {
      expect(source).toContain(`('${from}',`);
      expect(source).toContain(`'${to}')`);
    }
    // And an edge the graph does NOT contain is refused by the module.
    expect(lifecycle.isLegalCardJobTransition("NEEDS_SCAN", "READY_TO_GRADE")).toBe(false);
    expect(lifecycle.isLegalCardJobTransition("QA_REVIEW", "PRINTABLE")).toBe(false);
    expect(lifecycle.isLegalCardJobTransition("READY_TO_GRADE", "GRADING")).toBe(true);
  });

  it("AT-B23c: an illegal transition is refused by the module AND by the database trigger", async () => {
    const card = await readyToGradeCard(shopA);
    const refused = await settle(
      lifecycle.transitionCardJobInOwnTxn({
        tenantId: shopA.tenantId,
        locationId: shopA.locationA,
        cardJobId: card.cardJobId,
        from: ["READY_TO_GRADE"],
        to: "APPROVED",
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("ILLEGAL_TRANSITION");

    // The DATABASE is the floor, independently of the module: a direct UPDATE is refused too.
    const direct = await admin
      .query(`UPDATE partner_card_jobs SET status='APPROVED' WHERE id=$1`, [card.cardJobId])
      .then(() => "allowed")
      .catch((e: { message: string }) => e.message);
    expect(String(direct)).toContain("illegal transition");
    expect(await jobStatus(card.cardJobId)).toBe("READY_TO_GRADE");
  });
});
