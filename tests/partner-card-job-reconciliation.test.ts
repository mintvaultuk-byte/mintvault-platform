/**
 * P12 — THE ONE DOCUMENTED MEDIUM, PROVEN REPAIRABLE.
 *
 * THE CONDITION. Super Admin QA approval publishes the certificate through the HQ grader on the
 * Drizzle pool, then transitions the Card Job on the restricted partner-admin pool. Those cannot be
 * one transaction without restructuring protected HQ grading infrastructure. A crash, a deploy or a
 * transient pool failure in between leaves an approved grade whose Card Job never left QA_REVIEW.
 *
 * WHY IT IS A MEDIUM AND NOT A BLOCKER — and this suite proves that claim rather than asserting it:
 * output is FAIL-CLOSED in that state. Nothing publishes early, no credit moves, no identity is
 * minted. The card simply waits.
 *
 * WHY IT STILL HAD TO BE CLOSED. "Waits" means a shop that has paid for a card and had it approved
 * can never print it, and nobody is told. Fail-closed is the right direction, not an acceptable
 * resting place.
 *
 * WHAT IS PROVEN HERE, end to end:
 *   1. the failure is simulated at exactly the documented seam — the certificate is approved, the
 *      Card Job transition does not land;
 *   2. output stays blocked while drifted;
 *   3. reconciliation DETECTS it, by the exact documented predicate;
 *   4. redrive REPAIRS it through the canonical transition authority;
 *   5. a second redrive is a no-op — no second approval, no second anything;
 *   6. the wallet is untouched throughout: no settlement, no re-settlement;
 *   7. no certificate and no MV number was minted;
 *   8. the repair is audited AS a repair, distinguishable from an ordinary QA approval;
 *   9. an item whose premise does not hold is REFUSED and left fail-closed.
 *
 * A mock would prove none of this: the seam is two pools, the repair rides 0080's ENABLE ALWAYS
 * transition trigger, and the idempotency is a locked row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { createCertificatesStub } from "./helpers/certificates-stub";
import type { PartnerPrincipal } from "../server/partner/session";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
let lifecycle: typeof import("../server/partner/card-job-lifecycle");
let bridge: typeof import("../server/partner/card-job-grading-bridge");
let leases: typeof import("../server/partner/grading-lease-service");
let reconciliation: typeof import("../server/partner/card-job-reconciliation");
let reconciliationJob: typeof import("../server/jobs/partner-card-job-reconciliation");
let printEligibility: typeof import("../server/partner/print-eligibility");
let drizzle: typeof import("../server/db");
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };
const RUN_SALT = Math.random().toString(36).slice(2, 8);
let opSeq = 0;
let evidenceSeq = 0;

interface Fixture {
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
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
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
    working_object_key text, working_sha256 varchar(64),
    working_width integer, working_height integer, working_format varchar(16), working_settings jsonb,
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
  const locationA = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
       VALUES ($1,$2,$2,$3,$4,'ACTIVE') RETURNING id`,
      [`loc-${label}-${RUN_SALT}`, tenantId, `${label} Shop`, "1 High Street"]
    )
  ).rows[0].id;
  const graderOne = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}-${RUN_SALT}`, tenantId, `g.${label}.${RUN_SALT}@shop.test`]
    )
  ).rows[0].id;
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
        `MV-STN-${base32(`${label}${RUN_SALT}`, 16)}`,
        "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----",
        `${label}${RUN_SALT}`
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "0")
          .padEnd(64, "0")
          .slice(0, 64),
      ]
    )
  ).rows[0].id;
  return { tenantId, locationA, graderOne, stationA };
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
      `evidence/${certificateId}/${side}/${evidenceSeq}.working.jpg`,
      JSON.stringify({ captureSessionId: sessionId, scannerProfileVersion: "mintvault-canon-lide-400-v3" }),
    ]
  );
}

interface Card {
  cardJobId: string;
  certificateId: number;
  mvNumber: string;
}

/** Scanner NEW → captured → graded → submitted, so the card sits in QA_REVIEW. */
async function cardInQaReview(f: Fixture): Promise<Card> {
  opSeq += 1;
  const started = await authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId: f.locationA,
    stationId: f.stationA,
    clientOpId: `p12-op-${opSeq}-${RUN_SALT}`,
    actorUserId: f.graderOne,
    actorEmail: "operator@shop.test",
    cardName: "Blastoise",
  });
  const card = {
    cardJobId: started.cardJobId,
    certificateId: started.certificateId,
    mvNumber: started.mvNumber,
  };
  await captureSide(f, card.certificateId, "front");
  await lifecycle.advanceCardJobAfterCapture(card.certificateId);
  await captureSide(f, card.certificateId, "back");
  await lifecycle.advanceCardJobAfterCapture(card.certificateId);
  await leases.acquireLease(principal(f), card.cardJobId, "Ada");
  await admin.query(
    `UPDATE certificates
        SET grade = 9, grade_type='numeric',
            centering_score=9, corners_score=9, edges_score=9, surface_score=9
      WHERE id=$1`,
    [card.certificateId]
  );
  await bridge.submitCardJobForReview(principal(f), card.certificateId);
  return card;
}

/**
 * SIMULATE THE FAILURE AT EXACTLY THE DOCUMENTED SEAM.
 *
 * The certificate approval commits on the HQ pool — the real UPDATE `approveCertGrade` performs,
 * including its `print_state` entry into the queue — and the Card Job transition that should have
 * followed on the partner pool never runs. That is precisely what a crash or a deploy between the
 * two commits leaves behind, and it is the only honest way to produce the state under test.
 */
async function approveButDropCardJobTransition(card: Card): Promise<void> {
  await admin.query(
    `UPDATE certificates
        SET grade_approved_at = NOW(), grade_approved_by = 'qa@mintvault.test', status='active',
            grader_status = 'approved', graded_at = NOW(), updated_at = NOW(),
            print_state = CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing' ELSE print_state END
      WHERE id = $1 AND grader_status = 'pending_review'`,
    [card.certificateId]
  );
}

async function jobStatus(cardJobId: string): Promise<string> {
  const { rows } = await admin.query<{ status: string }>(`SELECT status FROM partner_card_jobs WHERE id=$1`, [
    cardJobId,
  ]);
  return rows[0]?.status ?? "MISSING";
}

async function walletSnapshot(tenantId: string): Promise<Record<string, string>> {
  const { rows } = await admin.query<Record<string, string>>(
    `SELECT
       COALESCE((SELECT available_balance::text FROM partner_credit_availability WHERE tenant_id=$1), '0') AS available,
       (SELECT count(*)::text FROM partner_credit_reservations WHERE tenant_id=$1 AND status='consumed') AS consumed,
       (SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1) AS ledger_rows,
       (SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='consumed') AS consume_events`,
    [tenantId]
  );
  return rows[0];
}

async function auditActions(cardJobId: string): Promise<string[]> {
  const { rows } = await admin.query<{ action: string }>(
    `SELECT action FROM partner_audit_events WHERE record_type='partner_card_job' AND record_id=$1 ORDER BY id`,
    [cardJobId]
  );
  return rows.map((r) => r.action);
}

let shop: Fixture;

describe("P12 Card Job reconciliation: QA split-transaction drift (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-card-job-reconciliation");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      "0035_partner_certificate_origin",
      "0045_partner_stations",
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
    lifecycle = await import("../server/partner/card-job-lifecycle");
    bridge = await import("../server/partner/card-job-grading-bridge");
    leases = await import("../server/partner/grading-lease-service");
    reconciliation = await import("../server/partner/card-job-reconciliation");
    reconciliationJob = await import("../server/jobs/partner-card-job-reconciliation");
    printEligibility = await import("../server/partner/print-eligibility");
    drizzle = await import("../server/db");

    shop = await makeTenant("recon");
    await wallet.ensureWallet(adminActor, shop.tenantId);
    await wallet.appendFoundationCredit(adminActor, {
      tenantId: shop.tenantId,
      amount: 30,
      entryType: "purchase",
      source: "admin",
      reason: "P12 reconciliation suite credits",
      idempotencyKey: `p12-${RUN_SALT}`,
      actorType: "admin",
    });
  }, 240_000);

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

  it("R1: a failure between certificate approval and the Card Job transition leaves output BLOCKED", async () => {
    const card = await cardInQaReview(shop);
    await approveButDropCardJobTransition(card);

    // Exactly the documented condition: grade published, Card Job never advanced.
    const { rows } = await admin.query<{ grade_approved_at: string | null; print_state: string }>(
      `SELECT grade_approved_at, print_state FROM certificates WHERE id=$1`,
      [card.certificateId]
    );
    expect(rows[0].grade_approved_at).not.toBeNull();
    expect(rows[0].print_state).toBe("needs_printing");
    expect(await jobStatus(card.cardJobId)).toBe("QA_REVIEW");

    // FAIL-CLOSED: output is refused. This is the claim that makes it a MEDIUM rather than a
    // BLOCKER, and it is proven here rather than asserted in a comment.
    const blocks = await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber]);
    expect(blocks.map((b) => b.code)).toEqual(["partner_card_job_state_invalid"]);
  });

  it("R2: reconciliation DETECTS the drift by the exact documented predicate", async () => {
    const card = await cardInQaReview(shop);
    await approveButDropCardJobTransition(card);

    const scan = await reconciliation.detectQaCardJobDrift();
    expect(scan.ran).toBe(true);
    const found = scan.items.find((i) => i.cardJobId === card.cardJobId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("QA_REVIEW");
    expect(found?.certificateId).toBe(card.certificateId);
    expect(found?.tenantId).toBe(shop.tenantId);
    expect(found?.approvedBy).toBe("qa@mintvault.test");

    // A HEALTHY card is not swept up. The detector names one understood inconsistency, so an
    // unrelated fault can never be silently "repaired" into a state nobody reasoned about.
    const healthy = await cardInQaReview(shop);
    expect((await reconciliation.detectQaCardJobDrift()).items.map((i) => i.cardJobId)).not.toContain(
      healthy.cardJobId
    );
  });

  it("R3/R4/R5: redrive REPAIRS it, a second redrive is a no-op, and the wallet never moves", async () => {
    const card = await cardInQaReview(shop);
    await approveButDropCardJobTransition(card);
    const walletBefore = await walletSnapshot(shop.tenantId);
    const certCountBefore = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM certificates`);
    const counterBefore = await admin.query<{ v: string }>(
      `SELECT last_issued::text AS v FROM cert_counter WHERE id=1`
    );

    const first = await reconciliation.redriveQaCardJobDrift({ actor: "test:redrive" });
    expect(first.ran).toBe(true);
    expect(first.results.find((r) => r.cardJobId === card.cardJobId)?.outcome).toBe("repaired");
    expect(await jobStatus(card.cardJobId)).toBe("APPROVED");

    // Output is now permitted — the card is unstuck through the SAME eligibility authority.
    expect(await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber])).toEqual([]);

    // R5: a SECOND redrive performs nothing. Not "harmlessly repeats" — performs nothing.
    const second = await reconciliation.redriveQaCardJobDrift({ actor: "test:redrive" });
    const secondResult = second.results.find((r) => r.cardJobId === card.cardJobId);
    expect(secondResult === undefined || secondResult.outcome === "already_advanced").toBe(true);
    expect(await jobStatus(card.cardJobId)).toBe("APPROVED");

    // R4: NO settlement, NO re-settlement, NO ledger movement — the credit settled once at SUBMIT and
    // this path never touches a wallet.
    expect(await walletSnapshot(shop.tenantId)).toEqual(walletBefore);

    // NO certificate and NO MV number was minted by the repair.
    const certCountAfter = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM certificates`);
    const counterAfter = await admin.query<{ v: string }>(`SELECT last_issued::text AS v FROM cert_counter WHERE id=1`);
    expect(certCountAfter.rows[0].n).toBe(certCountBefore.rows[0].n);
    expect(counterAfter.rows[0].v).toBe(counterBefore.rows[0].v);

    // NO second approval was recorded on the certificate.
    const { rows } = await admin.query<{ grade_approved_by: string; grader_status: string }>(
      `SELECT grade_approved_by, grader_status FROM certificates WHERE id=$1`,
      [card.certificateId]
    );
    expect(rows[0].grade_approved_by).toBe("qa@mintvault.test");
    expect(rows[0].grader_status).toBe("approved");
  });

  it("R6: the repair is audited AS a repair, distinguishable from an ordinary QA approval", async () => {
    const card = await cardInQaReview(shop);
    await approveButDropCardJobTransition(card);
    await reconciliation.redriveQaCardJobDrift({ actor: "test:redrive" });

    const actions = await auditActions(card.cardJobId);
    // The transition itself, named as a redrive rather than as a plain approval...
    expect(actions).toContain("partner_card_job_qa_approved_redrive");
    // ...plus the explicit repair row, so "how often did this happen" is answerable later.
    expect(actions).toContain("partner_card_job_drift_repaired");
    // And NOT the ordinary approval action, which would make a repair indistinguishable in the trail.
    expect(actions).not.toContain("partner_card_job_qa_approved");

    const { rows } = await admin.query<{ reason: string; before_value: unknown; after_value: unknown }>(
      `SELECT reason, before_value, after_value FROM partner_audit_events
        WHERE record_id=$1 AND action='partner_card_job_drift_repaired'`,
      [card.cardJobId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain("test:redrive");
    expect(rows[0].before_value).toMatchObject({ status: "QA_REVIEW" });
    expect(rows[0].after_value).toMatchObject({ status: "APPROVED", certificateId: card.certificateId });
  });

  it("R7: an item whose premise no longer holds is REFUSED and left fail-closed", async () => {
    const card = await cardInQaReview(shop);
    await approveButDropCardJobTransition(card);

    // Detect while drifted...
    const scan = await reconciliation.detectQaCardJobDrift();
    expect(scan.items.map((i) => i.cardJobId)).toContain(card.cardJobId);

    // ...then the world changes underneath: the approval is withdrawn before the repair runs.
    // A redrive must NOT assert an approval that no longer exists.
    await admin.query(
      `UPDATE certificates SET grade_approved_at = NULL, grade_approved_by = NULL, grader_status='pending_review'
        WHERE id=$1`,
      [card.certificateId]
    );

    const summary = await reconciliation.redriveQaCardJobDrift({ actor: "test:redrive" });
    const result = summary.results.find((r) => r.cardJobId === card.cardJobId);
    // Either it is no longer detected at all, or it is detected and explicitly refused. Both are
    // correct; silently advancing it would not be.
    if (result) {
      expect(result.outcome).toBe("refused");
      expect(result.reason).toBeTruthy();
    }
    expect(await jobStatus(card.cardJobId)).toBe("QA_REVIEW");
    // Still fail-closed.
    const blocks = await printEligibility.getPartnerPrintEligibilityBlocks([card.mvNumber]);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("R8: the scheduled job runs the whole thing and reports honestly", async () => {
    const card = await cardInQaReview(shop);
    await approveButDropCardJobTransition(card);

    // The job the scheduler actually invokes — not the service beneath it. A reconciliation that
    // never runs proves nothing, so the entry point itself is exercised.
    const outcome = await reconciliationJob.runPartnerCardJobReconciliation();
    expect(outcome.ran).toBe(true);
    expect(outcome.drift.repaired).toBeGreaterThanOrEqual(1);
    expect(await jobStatus(card.cardJobId)).toBe("APPROVED");
    // Report-only surfaces answer rather than throwing.
    expect(typeof outcome.stuckCardJobs).toBe("number");
    expect(typeof outcome.staleLeases).toBe("number");
  });

  it("R9: stuck Card Jobs and stale leases are REPORTED, never repaired", async () => {
    /*
     * `updated_at` CANNOT BE BACK-DATED BY AN UPDATE — and that is a feature, not an obstacle.
     *
     * 0080's immutability trigger ends with `NEW.updated_at := now()`, so every UPDATE stamps the
     * current time no matter what the statement asked for. Staleness is therefore not spoofable: a
     * job cannot be made to look freshly touched, nor freshly stale, by writing to it. The fixture
     * consequently INSERTS a job that has been sitting since three days ago, which is exactly the row
     * a real abandoned card leaves behind.
     */
    const submissionId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_submissions (tenant_id, location_id, created_by, card_count, status)
         VALUES ($1,$2,$3,1,'draft') RETURNING id`,
        [shop.tenantId, shop.locationA, shop.graderOne]
      )
    ).rows[0].id;
    const cardId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, quantity)
         VALUES ($1,$2,1,'Abandoned card',1) RETURNING id`,
        [shop.tenantId, submissionId]
      )
    ).rows[0].id;
    const stuckJobId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_card_jobs
           (tenant_id, submission_id, card_id, ordinal, card_reference, location_id, created_by, status,
            created_at, updated_at)
         VALUES ($1,$2,$3,1,$4,$5,$6,'GRADING', now() - interval '72 hours', now() - interval '72 hours')
         RETURNING id`,
        [shop.tenantId, submissionId, cardId, `partner-submission-card:${cardId}:1`, shop.locationA, shop.graderOne]
      )
    ).rows[0].id;

    const stuck = await reconciliation.detectStuckCardJobs({ hours: 48 });
    const found = stuck.items.find((i) => i.cardJobId === stuckJobId);
    expect(found).toBeDefined();
    expect(found?.hoursStuck).toBeGreaterThanOrEqual(48);
    expect(found?.status).toBe("GRADING");

    // REPORTED, NOT REPAIRED — a card sitting in GRADING for three days has many possible causes
    // (an operator went home, a station broke, the customer never came back) and no single safe
    // answer, so nothing moved it.
    expect(await jobStatus(stuckJobId)).toBe("GRADING");

    const card = await cardInQaReview(shop);

    // Stale leases likewise: correctness never depended on sweeping them, because acquireLease
    // releases an expired lease inside its own transaction.
    await admin.query(
      `UPDATE partner_grading_leases
          SET acquired_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'
        WHERE card_job_id=$1 AND released_at IS NULL`,
      [card.cardJobId]
    );
    const stale = await reconciliation.detectStaleLeases();
    expect(stale.items.map((i) => i.cardJobId)).toContain(card.cardJobId);
    const { rows } = await admin.query(
      `SELECT 1 FROM partner_grading_leases WHERE card_job_id=$1 AND released_at IS NULL`,
      [card.cardJobId]
    );
    expect(rows).toHaveLength(1);
  });
});
