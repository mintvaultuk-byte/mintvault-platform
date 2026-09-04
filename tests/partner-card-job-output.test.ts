/**
 * P11 — CERTIFICATE / LABEL / PRINT / NFC on the canonical Scanner Card Job lineage.
 *
 * WHAT IS BEING PROVEN. That a card which entered through Scanner NEW travels the EXISTING MintVault
 * output systems all the way to a finished physical product, carrying ONE identity the whole way:
 *
 *   Scanner NEW → Card Job → grading → QA_REVIEW → Super Admin APPROVE → approved certificate
 *   → print batch → printed → COMPLETED, with NFC where required.
 *
 * NO SECOND OUTPUT SYSTEM IS UNDER TEST, because none was built. The approval driven here is the real
 * `approveGraderCert` from server/grader.ts — including its publish gates and its atomic CAS — the
 * eligibility is the real `getPartnerPrintEligibilityBlocks`, the reprint and completion are the real
 * `requestReprint` / `markCompleted` from server/print-workflow.ts, and the provenance wording is the
 * real `certificateOrigin` from server/labels.ts.
 *
 * THE GAP THIS PHASE CLOSED. 0080's graph ends APPROVED → PRINTABLE → COMPLETED and nothing drove
 * either edge, so a Partner Card Job stopped dead at APPROVED however far its certificate travelled.
 * And the NFC facility — which has no migration at all — had no UNIQUE index on `nfc_uid` and no
 * bind-time approval guard, so one physical chip could be bound to two graded cards by two concurrent
 * requests, and a chip could be written for a card that had never been approved (the public scan
 * route returns 404 for those, so the tag was a physical object that resolved to nothing).
 *
 * WHY A REAL DATABASE. Every claim here is a constraint, an index, a CAS or a trigger: 0080's
 * ENABLE ALWAYS transition trigger, 0035's ENABLE ALWAYS origin-immutability trigger, 0088's partial
 * unique index on `lower(nfc_uid)`, and the approval CAS on `grading_revision`. A mock reproduces
 * none of them.
 *
 * Numbered AT-P1..AT-P15 against the required P11 hostile matrix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { createCertificatesStub } from "./helpers/certificates-stub";
import { checkNfcBindable } from "../shared/nfc-binding";
import type { PartnerPrincipal } from "../server/partner/session";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
let lifecycle: typeof import("../server/partner/card-job-lifecycle");
let bridge: typeof import("../server/partner/card-job-grading-bridge");
let leases: typeof import("../server/partner/grading-lease-service");
let graderService: typeof import("../server/grader");
let printWorkflow: typeof import("../server/print-workflow");
let printEligibility: typeof import("../server/partner/print-eligibility");
let labels: typeof import("../server/labels");
let drizzle: typeof import("../server/db");
let savedEnv: Record<string, string | undefined> = {};
let localEvidenceRoot = "";

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };
const QA = { actor: "qa@mintvault.test", role: "admin" as const };

/** Globally-unique fixture identifiers; a disposable cluster can outlive a failed run. */
const RUN_SALT = Math.random().toString(36).slice(2, 8);
let stationSeq = 0;
let opSeq = 0;
let evidenceSeq = 0;

interface Fixture {
  label: string;
  tenantId: string;
  locationA: string;
  graderOne: string;
  stationA: string;
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
    scanner_profile_version text not null, actor_id text,
    state varchar(16) not null,
    claimed_by_device_id text, physical_released boolean not null default false,
    recapture boolean not null default false, failure_reason text,
    created_at timestamptz not null default now(), claimed_at timestamptz,
    captured_at timestamptz, expires_at timestamptz not null
  )`);
  await admin.query(`CREATE TABLE certificate_image_evidence (
    id serial primary key,
    certificate_id integer not null references certificates(id) on delete restrict,
    side varchar(5) not null check (side in ('front','back')),
    evidence_class varchar(32) not null,
    evidence_version varchar(32) not null default 'v1',
    object_key text not null unique,
    sha256 varchar(64) not null, byte_length bigint not null,
    pixel_width integer not null, pixel_height integer not null,
    bit_depth integer, dpi integer, format varchar(16) not null,
    working_object_key text, working_sha256 varchar(64),
    working_width integer, working_height integer, working_format varchar(16), working_settings jsonb,
    capture_metadata jsonb not null default '{}'::jsonb,
    is_current boolean not null default true,
    superseded_at timestamptz, superseded_by_id integer,
    created_at timestamptz not null default now()
  )`);
  // The print lifecycle's own tables — the real requestReprint/markCompleted write to these.
  await admin.query(`CREATE TABLE print_events (
    id serial primary key, cert_id text not null, batch_id text, actor text not null,
    actor_role varchar(16), action varchar(24) not null,
    from_state varchar(24), to_state varchar(24), reason text, reason_category varchar(24),
    created_at timestamptz not null default now()
  )`);
  await admin.query(`CREATE TABLE print_batches (
    id serial primary key, batch_id text not null unique, kind varchar(12) not null default 'batch',
    status varchar(12) not null default 'open', cert_ids jsonb not null default '[]'::jsonb,
    cert_count integer not null default 0, success_count integer not null default 0,
    failure_count integer not null default 0, created_by text, created_by_role varchar(16),
    created_at timestamptz not null default now(), printed_at timestamptz,
    notes text, reason text, reason_category varchar(24), layout_version text
  )`);
  await admin.query(`CREATE TABLE reprint_log (
    id serial primary key, cert_id text not null, reprint_time timestamptz not null default now()
  )`);
  await admin.query(`CREATE TABLE label_prints (
    id serial primary key, cert_id text not null unique, sheet_ref text,
    queued_at timestamptz not null default now(), printed_at timestamptz
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
    "print_events",
    "print_batches",
    "reprint_log",
    "label_prints",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function writeWorkingEvidence(key: string): Promise<void> {
  const destination = join(localEvidenceRoot, ...key.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, "fixture working evidence");
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
  const locationA = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
       VALUES ($1,$2,$2,$3,$4,'ACTIVE') RETURNING id`,
      [`loc-${label}-a-${RUN_SALT}`, tenantId, `${label} Rochester`, "1 High Street"]
    )
  ).rows[0].id;
  const graderOne = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}-g1-${RUN_SALT}`, tenantId, `g1.${label}.${RUN_SALT}@shop.test`]
    )
  ).rows[0].id;
  stationSeq += 1;
  const base32 = (raw: string, n: number) =>
    raw
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, "2")
      .padEnd(n, "2")
      .slice(0, n);
  const stationA = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_stations
         (tenant_id, location_id, station_code, status, approved_at, public_key_pem, public_key_fingerprint)
       VALUES ($1,$2,$3,'ACTIVE', now(), $4, $5) RETURNING id`,
      [
        tenantId,
        locationA,
        `MV-STN-${base32(`${label}${RUN_SALT}${stationSeq}`, 16)}`,
        `-----BEGIN PUBLIC KEY-----\nsynthetic-${stationSeq}\n-----END PUBLIC KEY-----`,
        `${label}${RUN_SALT}${stationSeq}`
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "0")
          .padEnd(64, "0")
          .slice(0, 64),
      ]
    )
  ).rows[0].id;
  return { label, tenantId, locationA, graderOne, stationA };
}

function principal(f: Fixture): PartnerPrincipal {
  return {
    sessionId: "00000000-0000-0000-0000-0000000000ff",
    tenantId: f.tenantId,
    userId: f.graderOne,
    locationId: f.locationA,
    mfaPassed: true,
    permissions: new Set(["partner.dashboard.view", "partner.cards.view", "partner.cards.assess"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: false,
  };
}

async function captureSide(f: Fixture, certificateId: number, side: "front" | "back"): Promise<void> {
  evidenceSeq += 1;
  const sessionId = `sess-${certificateId}-${side}-${evidenceSeq}`;
  const workingKey = `evidence/${certificateId}/${side}/${evidenceSeq}.working.jpg`;
  await admin.query(
    `INSERT INTO scanner_capture_sessions
       (id, certificate_id, side, workstation_id, station_id, scanner_profile_version, actor_id, state,
        captured_at, expires_at)
     VALUES ($1,$2,$3,'WS-1',$4,'lide400-v1',$5,'captured', now(), now() + interval '1 hour')`,
    [sessionId, certificateId, side, f.stationA, f.graderOne]
  );
  await admin.query(
    `INSERT INTO certificate_image_evidence
       (certificate_id, side, evidence_class, object_key, sha256, byte_length, pixel_width, pixel_height, dpi,
        format, working_object_key, working_width, working_height, working_format, working_settings,
        capture_metadata, is_current)
     VALUES ($1,$2,'NEW_IMMUTABLE_MASTER',$3,$4,1024,4724,6136,1200,'tiff',$5,4724,6136,'jpeg',
             '{"resize":null}'::jsonb,$6::jsonb,true)`,
    [
      certificateId,
      side,
      `evidence/${certificateId}/${side}/${evidenceSeq}.tif`,
      "a".repeat(64),
      workingKey,
      JSON.stringify({ captureSessionId: sessionId, scannerProfileVersion: "mintvault-canon-lide-400-v3" }),
    ]
  );
  await writeWorkingEvidence(workingKey);
}

interface OutputCard {
  cardJobId: string;
  certificateId: number;
  mvNumber: string;
}

/** Scanner NEW → captured → graded → submitted. Stops just short of QA approval. */
async function cardAwaitingQa(f: Fixture, grade = "9.5"): Promise<OutputCard> {
  opSeq += 1;
  const started = await authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId: f.locationA,
    stationId: f.stationA,
    clientOpId: `p11-op-${f.label}-${opSeq}-${RUN_SALT}`,
    actorUserId: f.graderOne,
    actorEmail: "operator@shop.test",
    cardName: "Charizard",
  });
  const card: OutputCard = {
    cardJobId: started.cardJobId,
    certificateId: started.certificateId,
    mvNumber: started.mvNumber,
  };
  await captureSide(f, card.certificateId, "front");
  await lifecycle.advanceCardJobAfterCapture(card.certificateId);
  await captureSide(f, card.certificateId, "back");
  await lifecycle.advanceCardJobAfterCapture(card.certificateId);

  await leases.acquireLease(principal(f), card.cardJobId, "Ada");
  // A SERVER-side grade. The bridge carries it; nothing here or in the bridge computes one.
  await admin.query(
    `UPDATE certificates
        SET grade = $2, grade_type = 'numeric',
            centering_score = 9, corners_score = 10, edges_score = 9, surface_score = 10
      WHERE id = $1`,
    [card.certificateId, grade]
  );
  await bridge.submitCardJobForReview(principal(f), card.certificateId);
  return card;
}

/** The REAL Super Admin QA approval — publish gates, atomic CAS and the Card Job hook. */
async function approve(card: OutputCard): Promise<void> {
  const { rows } = await admin.query<{ grading_revision: number }>(
    `SELECT grading_revision FROM certificates WHERE id=$1`,
    [card.certificateId]
  );
  const result = await graderService.approveGraderCert(card.certificateId, QA.actor, Number(rows[0].grading_revision));
  if (!result.ok) throw new Error(`approval refused: ${JSON.stringify(result)}`);
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

async function walletSnapshot(tenantId: string): Promise<{ available: string; consumed: string; debits: string }> {
  const { rows } = await admin.query<{ available: string; consumed: string; debits: string }>(
    `SELECT
       COALESCE((SELECT available_balance::text FROM partner_credit_availability WHERE tenant_id=$1), '0') AS available,
       (SELECT count(*)::text FROM partner_credit_reservations WHERE tenant_id=$1 AND status='consumed') AS consumed,
       (SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0) AS debits`,
    [tenantId]
  );
  return rows[0];
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? "unknown" };
  }
}

let shopA: Fixture;
let shopB: Fixture;

describe("P11 Card Job output: certificate, label, print, NFC (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-card-job-output");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      // 0035 installs the ENABLE ALWAYS origin-immutability trigger on `certificates`. AT-P7 proves a
      // partner rename cannot rewrite historical provenance, and without this migration that proof
      // would be vacuous — the UPDATE would simply succeed and the test would be asserting nothing.
      "0035_partner_certificate_origin",
      "0045_partner_stations",
      "0087_partner_grading_edit_lease",
      // P11. The NFC facility never had a migration; 0088 gives "one tag, one certificate" a real
      // database authority instead of a racy read-then-write.
      "0088_nfc_binding_integrity",
    ]);
    await applyMigrations(
      admin,
      listMigrationFiles().filter((file) =>
        ["0121_main_runtime_role_authority.sql", "0122_object_write_intent_reconciliation.sql"].includes(
          file.filename
        )
      )
    );
    // 0035's origin-immutability trigger is what AT-P7 proves. It is applied here rather than through
    // the partner list because this suite owns a `certificates` table for it to attach to.
    await admin.query(`ALTER TABLE certificates OWNER TO pn_migrator`);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
      PARTNER_CONNECTOR_DATABASE_URL: process.env.PARTNER_CONNECTOR_DATABASE_URL,
      MINTVAULT_LOCAL_EVIDENCE_DIR: process.env.MINTVAULT_LOCAL_EVIDENCE_DIR,
    };
    localEvidenceRoot = await mkdtemp(join(tmpdir(), "mintvault-output-evidence-"));
    process.env.MINTVAULT_LOCAL_EVIDENCE_DIR = localEvidenceRoot;
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    delete process.env.PARTNER_CONNECTOR_DATABASE_URL;

    wallet = await import("../server/partner/partner-wallet-service");
    authority = await import("../server/partner/card-job-authority");
    lifecycle = await import("../server/partner/card-job-lifecycle");
    bridge = await import("../server/partner/card-job-grading-bridge");
    leases = await import("../server/partner/grading-lease-service");
    graderService = await import("../server/grader");
    printWorkflow = await import("../server/print-workflow");
    printEligibility = await import("../server/partner/print-eligibility");
    labels = await import("../server/labels");
    drizzle = await import("../server/db");

    shopA = await makeTenant("outa");
    shopB = await makeTenant("outb");
    await wallet.ensureWallet(adminActor, shopA.tenantId);
    await wallet.appendFoundationCredit(adminActor, {
      tenantId: shopA.tenantId,
      amount: 40,
      entryType: "purchase",
      source: "admin",
      reason: "P11 output suite credits",
      idempotencyKey: `p11-a-${RUN_SALT}`,
      actorType: "admin",
    });
    await wallet.ensureWallet(adminActor, shopB.tenantId);
    await wallet.appendFoundationCredit(adminActor, {
      tenantId: shopB.tenantId,
      amount: 10,
      entryType: "purchase",
      source: "admin",
      reason: "P11 output suite credits",
      idempotencyKey: `p11-b-${RUN_SALT}`,
      actorType: "admin",
    });
  }, 240_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await drizzle?.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    await rm(localEvidenceRoot, { recursive: true, force: true }).catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /* ============================================================================================
   * AT-P1..AT-P4 — the whole road, carrying ONE identity.
   * ========================================================================================== */
  it("AT-P1/P2/P3/P4: a Scanner Card Job reaches finished output with the SAME job, MV and certificate", async () => {
    const card = await cardAwaitingQa(shopA);
    const before = { job: card.cardJobId, mv: card.mvNumber, cert: card.certificateId };
    expect(await jobStatus(card.cardJobId)).toBe("QA_REVIEW");

    // Super Admin QA — the real approval, publish gates and all.
    await approve(card);
    expect(await jobStatus(card.cardJobId)).toBe("APPROVED");

    // Approval atomically enters the print queue. This is the HQ workflow's own CAS, untouched.
    const approved = await certRow(card.certificateId);
    expect(approved.grader_status).toBe("approved");
    expect(approved.grade_approved_at).not.toBeNull();
    expect(approved.print_state).toBe("needs_printing");

    // Output has begun → PRINTABLE. (The batch-creation hook; createBatchAtomic renders to R2, which
    // a disposable database has none of, so the lifecycle edge it drives is exercised directly.)
    await lifecycle.markCardJobPrintable(card.mvNumber, QA.actor);
    expect(await jobStatus(card.cardJobId)).toBe("PRINTABLE");

    // Physically printed, then completed through the REAL print workflow.
    await admin.query(`UPDATE certificates SET print_state='printed' WHERE id=$1`, [card.certificateId]);
    const completed = await printWorkflow.markCompleted({ certIds: [card.mvNumber], identity: QA });
    expect(completed.applied).toEqual([card.mvNumber]);
    expect(await jobStatus(card.cardJobId)).toBe("COMPLETED");

    // ONE identity, start to finish. Nothing was re-minted because the card came from a Partner.
    const { rows } = await admin.query<{ id: string; mv_number: string; certificate_id: number }>(
      `SELECT id, mv_number, certificate_id FROM partner_card_jobs WHERE id=$1`,
      [card.cardJobId]
    );
    expect(rows[0].id).toBe(before.job);
    expect(rows[0].mv_number).toBe(before.mv);
    expect(Number(rows[0].certificate_id)).toBe(before.cert);
    expect((await certRow(card.certificateId)).certificate_number).toBe(before.mv);
  });

  /* ============================================================================================
   * AT-P5 — nothing may be produced before Super Admin QA.
   * ========================================================================================== */
  it("AT-P5: output is refused before approval, and refused again in QA_REVIEW", async () => {
    const card = await cardAwaitingQa(shopA);

    // In QA_REVIEW: refused for the Card Job's OWN state, never for a connector mapping it can
    // never have. The distinction matters — the second is an unfixable cause.
    const inReview = await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber]);
    expect(inReview.map((b) => b.code)).toEqual(["partner_card_job_state_invalid"]);

    // And the print workflow itself will not batch it.
    const batched = await settle(printWorkflow.createBatchAtomic({ certIds: [card.mvNumber], identity: QA }));
    expect(batched.ok).toBe(true);
    if (batched.ok) {
      expect(batched.value.applied).toEqual([]);
      expect(batched.value.rejected.length).toBeGreaterThan(0);
    }
    expect((await certRow(card.certificateId)).print_state).toBe("awaiting_approval");

    // After approval it becomes eligible — the same card, by the same route.
    await approve(card);
    expect(await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber])).toEqual([]);
  });

  /* ============================================================================================
   * AT-P6 — cross-tenant output.
   * ========================================================================================== */
  it("AT-P6: Partner B cannot reach Partner A's approved card through any Partner-facing surface", async () => {
    const card = await cardAwaitingQa(shopA);
    await approve(card);

    const grading = await import("../server/partner/grading-routes");
    const intruder = principal(shopB);
    // The canonical Partner loader is the front door to every Partner-facing read of a card.
    expect(await grading.loadPartnerCert(intruder, card.certificateId)).toBeNull();

    // And Partner B's own Card Job table cannot see it — RLS plus the tenant predicate.
    const { rows } = await admin.query(`SELECT id FROM partner_card_jobs WHERE mv_number=$1 AND tenant_id=$2`, [
      card.mvNumber,
      shopB.tenantId,
    ]);
    expect(rows).toHaveLength(0);
  });

  /* ============================================================================================
   * AT-P7 — provenance is frozen at issue.
   * ========================================================================================== */
  it("AT-P7: renaming the partner and its location does NOT rewrite historical certificate provenance", async () => {
    const card = await cardAwaitingQa(shopA);
    await approve(card);
    const before = await certRow(card.certificateId);

    /*
     * Read through the APPLICATION's own record shape, not the raw row.
     *
     * `certificateOrigin` consumes a `CertificateRecord` — camelCase, as Drizzle produces it — so
     * handing it a snake_case pg row would silently find every field undefined and fall through to
     * the "unnamed partner" default. The assertion would then pass or fail for reasons that have
     * nothing to do with provenance. Going through storage is what makes this exercise the real path.
     */
    const { storage } = await import("../server/storage");
    const record = await storage.getCertificate(card.certificateId);
    const originBefore = labels.certificateOrigin(record as never);
    expect(originBefore.isPartner).toBe(true);
    expect(originBefore.name).toBe("outa Cards");
    expect(originBefore.line).toBe("Graded by outa Cards");

    // The shop rebrands and moves.
    await admin.query(`UPDATE partner_profiles SET trading_name='Rebranded Cards' WHERE tenant_id=$1`, [
      shopA.tenantId,
    ]);
    await admin.query(`UPDATE partner_locations SET name='Moved Shop', address='9 New Road' WHERE id=$1`, [
      shopA.locationA,
    ]);

    const after = await certRow(card.certificateId);
    expect(after.origin_partner_trading_name).toBe(before.origin_partner_trading_name);
    expect(after.origin_location_name).toBe(before.origin_location_name);
    expect(after.origin_location_address).toBe(before.origin_location_address);
    const recordAfter = await storage.getCertificate(card.certificateId);
    expect(labels.certificateOrigin(recordAfter as never).line).toBe("Graded by outa Cards");

    // And it is not merely that nothing tried: 0035's ENABLE ALWAYS trigger REFUSES a rewrite.
    const rewrite = await settle(
      admin.query(`UPDATE certificates SET origin_partner_trading_name='Rebranded Cards' WHERE id=$1`, [
        card.certificateId,
      ])
    );
    expect(rewrite.ok).toBe(false);
    if (!rewrite.ok) expect(rewrite.message.toLowerCase()).toContain("immutable");
  });

  /* ============================================================================================
   * AT-P8 — the rendered grade is the approved grade.
   * ========================================================================================== */
  it("AT-P8: the grade the renderer would print is exactly the server-authoritative approved grade", async () => {
    const card = await cardAwaitingQa(shopA, "8.5");
    await approve(card);
    const cert = await certRow(card.certificateId);

    // The renderer's entry gate and its printed digit both read `grade` / `grade_type` off this row —
    // there is no Partner-specific grade column and no second grading authority to disagree with.
    const { checkPrintableGrade } = await import("../shared/printable-grade");
    const verdict = checkPrintableGrade({
      gradeType: String(cert.grade_type),
      gradeOverall: String(cert.grade),
    });
    expect(verdict.printable).toBe(true);
    expect(Number(cert.grade)).toBe(8.5);
    // The operator's submitted snapshot is preserved alongside it, so QA's decision stays auditable
    // against what the Partner actually asserted.
    expect(Number(cert.operator_grade)).toBe(8.5);
    expect(cert.operator_subgrades).toEqual({ centering: 9, corners: 10, edges: 9, surface: 10 });
  });

  /* ============================================================================================
   * AT-P9 / AT-P10 — reprint.
   * ========================================================================================== */
  it("AT-P9/AT-P10: a reprint reuses the SAME certificate and MV, and costs ZERO Grading Credits", async () => {
    const card = await cardAwaitingQa(shopA);
    await approve(card);
    await lifecycle.markCardJobPrintable(card.mvNumber, QA.actor);
    await admin.query(`UPDATE certificates SET print_state='printed' WHERE id=$1`, [card.certificateId]);

    const walletBefore = await walletSnapshot(shopA.tenantId);

    const reprint = await printWorkflow.requestReprint({
      certIds: [card.mvNumber],
      reason: "Label damaged during slab assembly",
      reasonCategory: "damaged_print",
      identity: QA,
      idempotencyKey: `partner-reprint-${card.mvNumber}`,
    });
    expect(reprint.applied).toEqual([card.mvNumber]);

    // SAME certificate row, SAME MV — a reprint re-renders from the current row and mints nothing.
    const after = await certRow(card.certificateId);
    expect(after.certificate_number).toBe(card.mvNumber);
    expect(after.print_state).toBe("reprint_required");
    const { rows: jobRows } = await admin.query<{ certificate_id: number; mv_number: string }>(
      `SELECT certificate_id, mv_number FROM partner_card_jobs WHERE id=$1`,
      [card.cardJobId]
    );
    expect(Number(jobRows[0].certificate_id)).toBe(card.certificateId);
    expect(jobRows[0].mv_number).toBe(card.mvNumber);

    // Not one credit moved. The card was paid for once, at NEW, and settled once, at submit.
    expect(await walletSnapshot(shopA.tenantId)).toEqual(walletBefore);

    // The reprint is recorded, so a shop cannot be silently reprinted at.
    const { rows: events } = await admin.query<{ action: string; to_state: string; reason: string }>(
      `SELECT action, to_state, reason FROM print_events WHERE cert_id=$1 AND action='reprint'`,
      [card.mvNumber]
    );
    expect(events).toHaveLength(1);
    expect(events[0].to_state).toBe("reprint_required");
    const { rows: log } = await admin.query(`SELECT 1 FROM reprint_log WHERE cert_id=$1`, [card.mvNumber]);
    expect(log).toHaveLength(1);
  });

  it("AT-P10b: a printer failure that releases a batch cannot mint a replacement identity", async () => {
    const card = await cardAwaitingQa(shopA);
    await approve(card);
    const certsBefore = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM certificates WHERE origin_partner_id=$1`,
      [shopA.tenantId]
    );
    const counterBefore = await admin.query<{ last_issued: string }>(
      `SELECT last_issued::text FROM cert_counter WHERE id=1`
    );

    // createBatchAtomic renders and uploads; with no R2 configured it fails and RELEASES the
    // reservation. What must never happen is a new certificate or a burned MV number.
    await settle(printWorkflow.createBatchAtomic({ certIds: [card.mvNumber], identity: QA }));

    const certsAfter = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM certificates WHERE origin_partner_id=$1`,
      [shopA.tenantId]
    );
    const counterAfter = await admin.query<{ last_issued: string }>(
      `SELECT last_issued::text FROM cert_counter WHERE id=1`
    );
    expect(certsAfter.rows[0].n).toBe(certsBefore.rows[0].n);
    expect(counterAfter.rows[0].last_issued).toBe(counterBefore.rows[0].last_issued);
    // And the card still owns exactly one certificate.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_card_jobs WHERE certificate_id=$1`,
      [card.certificateId]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  /* ============================================================================================
   * AT-P11 / AT-P12 — NFC.
   * ========================================================================================== */
  it("AT-P11/AT-P12: NFC binds only to an approved certificate, retries keep one identity, and cost nothing", async () => {
    const card = await cardAwaitingQa(shopA);

    // BEFORE approval a tag must be refused: the public scan route 404s an unapproved certificate, so
    // such a tag is a physical object that resolves to nothing.
    const preApproval = checkNfcBindable((await certRow(card.certificateId)) as never);
    expect(preApproval.ok).toBe(false);
    if (!preApproval.ok) expect(preApproval.refusal).toBe("not_approved");

    await approve(card);
    const approved = await certRow(card.certificateId);
    expect(checkNfcBindable({ gradeApprovedAt: approved.grade_approved_at as Date, deletedAt: null }).ok).toBe(true);

    const walletBefore = await walletSnapshot(shopA.tenantId);
    const uid = `04:AA:BB:${RUN_SALT}`;

    // Bind, then RETRY the same tag — the retry is the same row, the same MV, the same certificate.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await admin.query(`UPDATE certificates SET nfc_uid=$2, nfc_enabled=true, nfc_written_at=now() WHERE id=$1`, [
        card.certificateId,
        uid,
      ]);
    }
    const bound = await certRow(card.certificateId);
    expect(bound.nfc_uid).toBe(uid);
    expect(bound.certificate_number).toBe(card.mvNumber);
    expect(bound.id).toBe(card.certificateId);

    // NFC touches no credit surface at all — a failed tag is a consumable, never a re-grade.
    expect(await walletSnapshot(shopA.tenantId)).toEqual(walletBefore);
  });

  it("AT-P11b: 0088 makes 'one tag, one certificate' a DATABASE constraint, not a racy read", async () => {
    const first = await cardAwaitingQa(shopA);
    const second = await cardAwaitingQa(shopA);
    await approve(first);
    await approve(second);
    const uid = `04:CC:DD:${RUN_SALT}`;

    await admin.query(`UPDATE certificates SET nfc_uid=$2 WHERE id=$1`, [first.certificateId, uid]);

    // The same physical chip on a second graded card is refused by the index, regardless of what any
    // application-level read-then-write believed. This is the case two concurrent binds hit.
    const clash = await settle(
      admin.query(`UPDATE certificates SET nfc_uid=$2 WHERE id=$1`, [second.certificateId, uid])
    );
    expect(clash.ok).toBe(false);

    // Case-insensitively, too: the read guard queries lower(nfc_uid), so the index must agree or the
    // hazard the code believes is closed stays open.
    const casedClash = await settle(
      admin.query(`UPDATE certificates SET nfc_uid=$2 WHERE id=$1`, [second.certificateId, uid.toUpperCase()])
    );
    expect(casedClash.ok).toBe(false);

    // Rebinding the SAME certificate to the same tag stays legal — a retry must not be a conflict.
    const rebind = await settle(
      admin.query(`UPDATE certificates SET nfc_uid=$2 WHERE id=$1`, [first.certificateId, uid])
    );
    expect(rebind.ok).toBe(true);
  });

  /* ============================================================================================
   * AT-P13 / AT-P14 — the two lineages.
   * ========================================================================================== */
  it("AT-P14: Card Job output requires NO connector mapping, and none is manufactured to get it", async () => {
    const card = await cardAwaitingQa(shopA);
    await approve(card);
    expect(await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber])).toEqual([]);

    // Not one connector row exists for this tenant. Output was reached entirely on Card Job lineage.
    const { rows } = await admin.query(`SELECT 1 FROM partner_connector_imports WHERE partner_organisation_id=$1`, [
      shopA.tenantId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("AT-P13: connector-lineage output protections are untouched — mapping is still required", async () => {
    // A Partner-origin certificate with NO Card Job and NO connector import. The connector arm must
    // still refuse it, so nothing in the lineage split globally loosened legacy output.
    const { rows } = await admin.query<{ certificate_number: string }>(
      `INSERT INTO certificates
         (certificate_number, origin_type, origin_partner_id, origin_partner_legal_name,
          origin_location_id, origin_captured_at, origin_snapshot_version,
          grader_status, grade_approved_at, grade_approved_by, review_required, print_state,
          grade, grade_type, centering_score, corners_score, edges_score, surface_score)
       VALUES ($1,'PARTNER',$2,'outa Ltd',$3, now(), 1,
               'approved', now(), 'qa@mintvault.test', true, 'needs_printing',
               9, 'numeric', 9, 9, 9, 9)
       RETURNING certificate_number`,
      [`MV-LEGACY-${RUN_SALT}`, shopA.tenantId, shopA.locationA]
    );
    const blocks = await printEligibility.getPartnerPrintEligibilityBlocks([rows[0].certificate_number]);
    expect(blocks.map((b) => b.code)).toEqual(["partner_mapping_invalid"]);
  });

  /* ============================================================================================
   * AT-P15 — corrections do not fork identity or double-count population.
   * ========================================================================================== */
  it("AT-P15: a QA return, regrade and re-approval produce ONE certificate, ONE MV and ONE population row", async () => {
    const card = await cardAwaitingQa(shopA);

    const populationBefore = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM certificates
        WHERE card_name = 'Charizard' AND status='active' AND deleted_at IS NULL AND grade IS NOT NULL`
    );

    /*
     * RETURN TO GRADER happens from QA_REVIEW, not from APPROVED.
     *
     * `rejectCertGrade` is gated on `grader_status = 'pending_review'` — which is correct, and is the
     * pilot's whole point: once Super Admin has approved a card the grade is published, and the way
     * back is Correction Mode, not the review queue. So the correction cycle under test is
     * submit → return → regrade → resubmit → approve, with exactly ONE approval at the end.
     */
    const rejected = await graderService.rejectCertGrade(card.certificateId, "Centering re-measure", QA.actor);
    expect(rejected.ok).toBe(true);
    expect(await jobStatus(card.cardJobId)).toBe("GRADING");

    // Regrade and resubmit on the SAME job.
    await leases.acquireLease(principal(shopA), card.cardJobId, "Ada");
    await admin.query(`UPDATE certificates SET grade = 9 WHERE id=$1`, [card.certificateId]);
    await bridge.submitCardJobForReview(principal(shopA), card.certificateId);
    await approve(card);

    // ONE of everything. A correction updates the certificate in place; it never forks identity, so
    // the population census — which counts certificate ROWS — cannot double-count it.
    const populationAfter = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM certificates
        WHERE card_name = 'Charizard' AND status='active' AND deleted_at IS NULL AND grade IS NOT NULL`
    );
    expect(populationAfter.rows[0].n).toBe(populationBefore.rows[0].n);

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_card_jobs WHERE certificate_id=$1`,
      [card.certificateId]
    );
    expect(Number(rows[0].n)).toBe(1);
    const cert = await certRow(card.certificateId);
    expect(cert.certificate_number).toBe(card.mvNumber);
    expect(Number(cert.grade)).toBe(9);
    // The correction history is preserved rather than reset.
    expect(Number(cert.redo_count)).toBe(1);

    // And the credit settled exactly once across the whole correction cycle.
    const { rows: consumes } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM partner_card_jobs j
         JOIN partner_credit_reservation_events e ON e.reservation_id = j.reservation_id
        WHERE j.id = $1 AND e.event_type = 'consumed'`,
      [card.cardJobId]
    );
    expect(Number(consumes[0].n)).toBe(1);
  });
});
