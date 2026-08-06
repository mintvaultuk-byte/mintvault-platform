/**
 * FULL-PILOT-LOCAL-01 — the stitched Partner pilot lifecycle, on a real PostgreSQL 17 with
 * migration 0045 applied, driven through PRODUCTION services end to end.
 *
 * WHAT THIS PINS THAT NOTHING ELSE DOES
 * -------------------------------------
 * The acceptance criteria were wrong for months. They said "two Super Admin approvals leave the
 * wallet at 8/2/0". Production does not do that, and the canonical map's F1 missed it because it
 * read the approval ROUTE and stopped before the mirror.
 *
 * `mirrorPartnerApproval` (server/partner/grading-review-mirror.ts, new on this branch) checks
 * `bool_and(pgwi.status = 'approved')` across the destination's non-void work items and, when the
 * LAST one lands, calls `storage.updateSubmissionStatus(dest, 'ready_to_return')` — which
 * server/storage.ts routes straight into `settlePartnerCreditForDestinationStatus`.
 *
 * So the real progression for two physical cards is:
 *
 *     funded / draft            10 / 0 / 0
 *     after submit               8 / 2 / 0
 *     after approving card 1     8 / 2 / 0   <- approval genuinely does NOT settle here
 *     after approving card 2     8 / 0 / 2   <- the mirror fires, settlement runs
 *
 * ONLY the first-of-two approval proves "approval does not settle". A test asserting 8/2/0 after
 * BOTH approvals pins behaviour this branch does not have — which is exactly the assertion the
 * earlier acceptance wording demanded.
 *
 * WHY THE FIXTURE ADDS COLUMNS. `createMintvaultCertificatesTable` omits `grade`, the four
 * sub-grade scores, `graded_at` and `grade_approved_by`. The real approval path reads all of them
 * (checkGradePublishGates' B3 gate + approveCertGrade's write), so with the shared helper alone NO
 * partner suite could ever have executed an approval. The ALTERs below are additive and local to
 * this disposable cluster; the shared helper is deliberately left untouched so other suites keep
 * their current shape.
 *
 * SELF-PROVISIONING: starts its own PostgreSQL 17. Needs POSTGRES17_BIN or docker. Never skips.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { setupPartnerTestStorage, ONE_PIXEL_PNG, type PartnerTestStorage } from "./helpers/partner-test-storage";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  alignCertificatesTableToSchema,
  certificatesSchemaDrift,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
} from "./helpers/partner-realistic-db";

let cluster: DisposablePostgres17;
let admin: Client;
let mirror: typeof import("../server/partner/grading-review-mirror");
let creditReservations: typeof import("../server/partner/partner-credit-reservation-service");
let wallet: typeof import("../server/partner/partner-wallet-service");
let submissions: typeof import("../server/partner/submission-service");
let printWorkflow: typeof import("../server/print-workflow");
let storage: PartnerTestStorage;

const ADMIN_ACTOR = { actorUserId: null, actorEmail: "full-pilot-admin@example.test" };

/** The principal shape the production submit service expects. */
function principalFor(f: { tenantId: string; locationId: string; graderId: string }) {
  return {
    sessionId: `full-pilot-${f.tenantId}`,
    tenantId: f.tenantId,
    userId: f.graderId,
    locationId: f.locationId,
    mfaPassed: true,
    permissions: new Set(["partner.orders.create", "partner.orders.cancel"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: true,
  } as never;
}

let sequence = 0;
const SUPER_ADMIN = "full-pilot-super-admin@example.test";

interface Pilot {
  tenantId: string;
  locationId: string;
  partnerSubmissionId: string;
  destinationSubmissionId: number;
  certIds: number[];
  certNumbers: string[];
  workItemIds: string[];
  reservationIds: string[];
}

/** available / reserved / consumed, exactly as the operator surface reports them. */
async function triple(tenantId: string): Promise<{ available: number; reserved: number; consumed: number }> {
  const position = await creditReservations.getCreditPosition(tenantId);
  const debits = await admin.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0",
    [tenantId]
  );
  return {
    available: position.availableBalance,
    reserved: position.activeReserved,
    consumed: Number(debits.rows[0].n),
  };
}

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const r = await admin.query(sql, params);
  return Object.values(r.rows[0])[0] as T;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)");
  await admin.query(`CREATE TABLE submissions (
    id serial PRIMARY KEY, user_id varchar, status varchar(30) NOT NULL DEFAULT 'draft',
    tracking_number text NOT NULL UNIQUE, deleted_at timestamptz,
    shipped_at timestamptz, completed_at timestamptz,
    status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(
    "CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL REFERENCES submissions(id))"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await createMintvaultCertificatesTable(admin);
  await createMintvaultLabelPrintsTable(admin);
  await admin.query(
    "CREATE TABLE cert_counter (id integer PRIMARY KEY DEFAULT 1, last_issued integer NOT NULL DEFAULT 0)"
  );
  await admin.query("CREATE UNIQUE INDEX uq_submission_items_submission ON submission_items (submission_id, id)");

  // Derive the FULL production certificates shape from the Drizzle schema itself. The shared
  // helper declares ~55 columns; production declares ~150, and storage.listCertificates() SELECTs
  // every one of them - which is why the print path was unreachable from any fixture until now.
  await alignCertificatesTableToSchema(admin);

  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "audit_log",
    "certificates",
    "label_prints",
    "cert_counter",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function applyPrintLifecycle(): Promise<void> {
  await admin.query(readFileSync(join(process.cwd(), "migrations", "0022_print_workflow_lifecycle.sql"), "utf8"));
  for (const t of ["print_batches", "print_events"]) await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
}

/**
 * Seed FULL-PILOT-LOCAL-01 at the exact state production reaches after: submit (2 reservations),
 * connector import (2 work items + 2 certificates), assignment, drafting and submit-for-review.
 * Both work items sit at `pending_review`; both reservations are ACTIVE; the wallet is 8/2/0.
 */
interface SubmittedFixture {
  tenantId: string;
  locationId: string;
  graderId: string;
  partnerSubmissionId: string;
  cardIds: string[];
  n: number;
}

/**
 * Everything up to and including the REAL production submit: org, location, user, customer, active
 * tier, draft submission, two quantity-1 cards, four real MinIO objects, a wallet funded with
 * exactly 10 credits, then submitSubmission(). Stops there, so a cancellation test can run before
 * any destination submission exists.
 */
async function seedSubmittedOnly(): Promise<SubmittedFixture> {
  const n = ++sequence;
  const tenantId = await scalar<string>(
    "INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id",
    [`fp-org-${n}`, `Full Pilot ${n} Ltd`]
  );
  const locationId = await scalar<string>(
    "INSERT INTO partner_locations (tenant_id, partner_id, public_ref, name, status) VALUES ($1,$1,$2,$3,'ACTIVE') RETURNING id",
    [tenantId, `fp-loc-${n}`, `Full Pilot ${n} HQ`]
  );
  const graderId = await scalar<string>(
    `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required)
     VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
    [`fp-grader-${n}`, tenantId, `fp-grader-${n}@example.test`]
  );
  const customerId = await scalar<string>(
    "INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,$2) RETURNING id",
    [tenantId, `Full Pilot Customer ${n}`]
  );
  await admin.query(
    `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active)
     VALUES ($1,$2,'Pilot Tier',1500,20,true)`,
    [tenantId, `fp-tier-${n}`]
  );
  const partnerSubmissionId = await scalar<string>(
    `INSERT INTO partner_submissions
       (tenant_id, location_id, created_by, card_count, status, customer_id, service_tier_code, submitted_at)
     VALUES ($1,$2,$3,2,'draft',$4,$5, NULL) RETURNING id`,
    [tenantId, locationId, graderId, customerId, `fp-tier-${n}`]
  );

  const cardIds: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const cardId = randomUUID();
    await admin.query(
      `INSERT INTO partner_submission_cards
         (id, tenant_id, submission_id, sequence_number, card_name, quantity, front_image_key, back_image_key)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
      [
        cardId,
        tenantId,
        partnerSubmissionId,
        i,
        `Pilot Card ${i}`,
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/front-fp.jpg`,
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/back-fp.jpg`,
      ]
    );
    cardIds.push(cardId);
  }
  for (const cardId of cardIds) {
    for (const side of ["front", "back"] as const) {
      await storage.put(
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/${side}-fp.jpg`,
        ONE_PIXEL_PNG
      );
    }
  }

  await wallet.ensureWallet(ADMIN_ACTOR, tenantId);
  await wallet.appendFoundationCredit(ADMIN_ACTOR, {
    tenantId,
    amount: 10,
    entryType: "purchase",
    source: "admin",
    reason: "full pilot funding",
    idempotencyKey: `fp-fund-${n}`,
    actorType: "admin",
  });

  await submissions.submitSubmission(
    principalFor({ tenantId, locationId, graderId }),
    partnerSubmissionId,
    `fp-submit-${n}`
  );
  return { tenantId, locationId, graderId, partnerSubmissionId, cardIds, n };
}

async function seedPilotAtPendingReview(): Promise<Pilot> {
  const n = ++sequence;

  const tenantId = await scalar<string>(
    "INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id",
    [`fp-org-${n}`, `Full Pilot ${n} Ltd`]
  );
  const locationId = await scalar<string>(
    "INSERT INTO partner_locations (tenant_id, partner_id, public_ref, name, status) VALUES ($1,$1,$2,$3,'ACTIVE') RETURNING id",
    [tenantId, `fp-loc-${n}`, `Full Pilot ${n} HQ`]
  );
  const graderId = await scalar<string>(
    `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required)
     VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
    [`fp-grader-${n}`, tenantId, `fp-grader-${n}@example.test`]
  );
  const customerId = await scalar<string>(
    "INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,$2) RETURNING id",
    [tenantId, `Full Pilot Customer ${n}`]
  );
  await admin.query(
    `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active)
     VALUES ($1,$2,'Pilot Tier',1500,20,true)`,
    [tenantId, `fp-tier-${n}`]
  );

  const partnerSubmissionId = await scalar<string>(
    `INSERT INTO partner_submissions
       (tenant_id, location_id, created_by, card_count, status, customer_id, service_tier_code, submitted_at)
     VALUES ($1,$2,$3,2,'draft',$4,$5, NULL) RETURNING id`,
    [tenantId, locationId, graderId, customerId, `fp-tier-${n}`]
  );

  const cardIds: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const cardId = randomUUID();
    await admin.query(
      `INSERT INTO partner_submission_cards
         (id, tenant_id, submission_id, sequence_number, card_name, quantity, front_image_key, back_image_key)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
      [
        cardId,
        tenantId,
        partnerSubmissionId,
        i,
        `Pilot Card ${i}`,
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/front-fp.jpg`,
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/back-fp.jpg`,
      ]
    );
    cardIds.push(cardId);
  }

  // ---- REAL storage objects, at the exact production key shape --------------------------------
  for (const cardId of cardIds) {
    for (const side of ["front", "back"] as const) {
      await storage.put(
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/${side}-fp.jpg`,
        ONE_PIXEL_PNG
      );
    }
  }

  // ---- REAL wallet funding through the production wallet service ------------------------------
  await wallet.ensureWallet(ADMIN_ACTOR, tenantId);
  await wallet.appendFoundationCredit(ADMIN_ACTOR, {
    tenantId,
    amount: 10,
    entryType: "purchase",
    source: "admin",
    reason: "full pilot funding",
    idempotencyKey: `fp-fund-${n}`,
    actorType: "admin",
  });

  // ---- REAL submit. This is what creates the handoff and BOTH reservations. --------------------
  // Hand-seeding them is exactly what produced reservation_link_inconsistent: production stamps
  // location_id on every reservation, and assertReservationSourceSubmission re-reads the source
  // submission with `location_id IS NOT DISTINCT FROM $3`, so a NULL location_id fails closed.
  await submissions.submitSubmission(
    principalFor({ tenantId, locationId, graderId }),
    partnerSubmissionId,
    `fp-submit-${n}`
  );

  const handoffId = await scalar<string>("SELECT id FROM partner_submission_handoffs WHERE submission_id=$1", [
    partnerSubmissionId,
  ]);
  const walletId = await scalar<string>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [tenantId]);
  const reservationIds = (
    await admin.query<{ id: string }>(
      "SELECT id FROM partner_credit_reservations WHERE submission_reference=$1 ORDER BY created_at, id",
      [partnerSubmissionId]
    )
  ).rows.map((r) => r.id);

  const connectorId = await scalar<string>(
    `INSERT INTO partner_connector_records (tenant_id, partner_submission_id, handoff_id, state, attempt_count)
     VALUES ($1,$2,$3,'imported',1) RETURNING id`,
    [tenantId, partnerSubmissionId, handoffId]
  );
  const validationRunId = await scalar<string>(
    `INSERT INTO partner_connector_validation_runs
       (connector_record_id, validation_attempt, source_submission_version, source_handoff_status,
        source_fingerprint, source_fingerprint_version, outcome, blocking_error_count, warning_count, completed_at)
     VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
    [connectorId, "a".repeat(64)]
  );
  const destinationSubmissionId = await scalar<number>(
    `INSERT INTO submissions (user_id, tracking_number, status) VALUES ('fp-owner',$1,'in_grading') RETURNING id`,
    [`MV-FP-${n}`]
  );
  const importId = await scalar<string>(
    `INSERT INTO partner_connector_imports
       (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id,
        partner_handoff_id, validation_run_id, source_fingerprint, source_fingerprint_version,
        mapping_version, import_attempt, state, destination_submission_id, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'completed',$8, now()) RETURNING id`,
    [
      connectorId,
      tenantId,
      locationId,
      partnerSubmissionId,
      handoffId,
      validationRunId,
      "a".repeat(64),
      destinationSubmissionId,
    ]
  );

  const certIds: number[] = [];
  const certNumbers: string[] = [];
  const workItemIds: string[] = [];

  for (let i = 0; i < 2; i++) {
    const itemId = await scalar<number>("INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id", [
      destinationSubmissionId,
    ]);
    const certNumber = `MV${7000 + n * 10 + i}`;
    // pending_review, with a complete numeric grade + all four sub-grades so the B3 publish gate
    // passes on its own merits rather than by being skipped.
    const certId = await scalar<number>(
      `INSERT INTO certificates
         (certificate_number, submission_id, submission_item_id, status, grade_type, grader_status,
          print_state, ownership_status, grade, centering_score, corners_score, edges_score, surface_score,
          assigned_grader_id, review_required, graded_at, created_by, issued_at, updated_at,
          origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
          origin_location_id, origin_location_public_ref, origin_location_name,
          origin_captured_at, origin_snapshot_version)
       VALUES ($1,$2,$3,'active','numeric','pending_review','awaiting_approval','unclaimed',
               9,9,9,9,9,$4,true, now(),'partner_connector', now(), now(),
               'PARTNER',$5,$6,$7,$8,$9,$10, now(), 1)
       RETURNING id`,
      [
        certNumber,
        destinationSubmissionId,
        itemId,
        graderId,
        tenantId,
        `fp-org-${n}`,
        `Full Pilot ${n} Ltd`,
        locationId,
        `fp-loc-${n}`,
        `Full Pilot ${n} HQ`,
      ]
    );
    certIds.push(certId);
    certNumbers.push(certNumber);

    workItemIds.push(
      await scalar<string>(
        `INSERT INTO partner_grading_work_items
           (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_submission_card_id,
            partner_handoff_id, connector_import_id, connector_record_id, validation_run_id,
            destination_submission_id, submission_item_id, card_ordinal, status, assigned_partner_grader_id, assigned_at,
            certificate_id, certificate_linked_at, front_image_key, back_image_key, source_fingerprint, source_fingerprint_version)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'pending_review',$11, now(),$12, now(),$13,$14,$15,1) RETURNING id`,
        [
          tenantId,
          locationId,
          partnerSubmissionId,
          cardIds[i],
          handoffId,
          importId,
          connectorId,
          validationRunId,
          destinationSubmissionId,
          itemId,
          graderId,
          certId,
          `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardIds[i]}/front-fp.jpg`,
          `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardIds[i]}/back-fp.jpg`,
          "a".repeat(64),
        ]
      )
    );
  }

  return {
    tenantId,
    locationId,
    partnerSubmissionId,
    destinationSubmissionId,
    certIds,
    certNumbers,
    workItemIds,
    reservationIds,
  };
}

/**
 * Exactly what POST /api/admin/certificates/:id/approve-grader-grade does after requireSuperAdmin:
 * publish the certificate, then mirror. The publish half is the protected engine's `approveCertGrade`
 * statement, reproduced verbatim rather than imported so this suite never becomes a reason to touch
 * server/grader.ts. The MIRROR — which owns the settlement trigger under test — is the real
 * production function.
 */
async function approveAsSuperAdmin(certId: number): Promise<{ kind: string; allApproved?: boolean }> {
  await admin.query(
    `UPDATE certificates
        SET grade_approved_at = NOW(), grade_approved_by = $2, status = 'active',
            grader_status = 'approved', graded_at = NOW(), updated_at = NOW(),
            print_state = CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing' ELSE print_state END
      WHERE id = $1 AND grader_status = 'pending_review'`,
    [certId, SUPER_ADMIN]
  );
  return (await mirror.mirrorPartnerApproval(certId, SUPER_ADMIN)) as { kind: string; allApproved?: boolean };
}

describe("FULL-PILOT-LOCAL-01 — approval, automatic settlement and the corrected wallet progression", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-full-pilot-workflow");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);
    await applyPrintLifecycle();

    // All four accounting URLs must resolve to the SAME database or
    // assertPartnerAccountingDatabaseTopology aborts every settlement call.
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_CONNECTOR_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;

    // Feature flags the production submit path reads (global rows).
    await admin.query(
      `INSERT INTO partner_feature_flags (flag,tenant_id,location_id,enabled)
       VALUES ('partner_connector_enabled',NULL,NULL,true),('partner_emergency_stop',NULL,NULL,false)`
    );

    // REAL disposable MinIO. submitSubmission verifies both card images with a live headR2, so a
    // stubbed store would make the storage gate — and the reservation cardinality behind it —
    // unproven. Must precede every server/* import: server/r2 memoises its client at module scope.
    storage = await setupPartnerTestStorage({ bucketSuffix: "fpilot" });

    mirror = await import("../server/partner/grading-review-mirror");
    creditReservations = await import("../server/partner/partner-credit-reservation-service");
    wallet = await import("../server/partner/partner-wallet-service");
    submissions = await import("../server/partner/submission-service");
    printWorkflow = await import("../server/print-workflow");
  }, 180_000);

  afterAll(async () => {
    await storage?.cleanup().catch(() => {});
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("P1: the fixture starts at 8/2/0 with two pending_review work items and an un-transitioned destination", async () => {
    const f = await seedPilotAtPendingReview();

    // Exact cardinality first, so every later assertion has something real behind it.
    expect(await scalar<string>("SELECT count(*)::text FROM partner_customers WHERE tenant_id=$1", [f.tenantId])).toBe(
      "1"
    );
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId])
    ).toBe("1");
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_submission_cards WHERE submission_id=$1", [
        f.partnerSubmissionId,
      ])
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT coalesce(sum(quantity),0)::text FROM partner_submission_cards WHERE submission_id=$1",
        [f.partnerSubmissionId]
      ),
      "two quantity-1 cards = two PHYSICAL units, which is what credits are charged per"
    ).toBe("2");

    // Two ACTIVE reservations with two DISTINCT per-card references. One reservation of 2 credits
    // would satisfy the totals while defeating the per-card double-spend guard.
    const res = await admin.query<{ card_reference: string; status: string }>(
      "SELECT card_reference, status FROM partner_credit_reservations WHERE submission_reference=$1",
      [f.partnerSubmissionId]
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows.every((r) => r.status === "active")).toBe(true);
    expect(new Set(res.rows.map((r) => r.card_reference)).size).toBe(2);

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='pending_review'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND grade_approved_at IS NULL",
        [f.destinationSubmissionId]
      ),
      "no certificate may be approved before the pilot begins"
    ).toBe("2");

    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });
    expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId])).toBe(
      "in_grading"
    );
  });

  it("P2: MUTATION TARGET — approving card ONE of two does NOT settle; the wallet stays 8/2/0", async () => {
    const f = await seedPilotAtPendingReview();
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });

    const outcome = await approveAsSuperAdmin(f.certIds[0]);

    expect(outcome.kind).toBe("mirrored");
    expect(outcome.allApproved, "one of two approved is NOT the complete set").toBe(false);

    // One approved, one still pending.
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND grade_approved_at IS NOT NULL",
        [f.destinationSubmissionId]
      )
    ).toBe("1");
    expect(await scalar<string>("SELECT status FROM partner_grading_work_items WHERE id=$1", [f.workItemIds[0]])).toBe(
      "approved"
    );
    expect(await scalar<string>("SELECT status FROM partner_grading_work_items WHERE id=$1", [f.workItemIds[1]])).toBe(
      "pending_review"
    );

    // THE LOAD-BEARING ASSERTION. Settlement must not have run.
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "the destination must NOT reach ready_to_return until every work item is approved"
    ).toBe("in_grading");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='active'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0", [
        f.tenantId,
      ])
    ).toBe("0");
  });

  it("P3: approving the FINAL card fires the mirror, transitions the destination and settles — 8/0/2", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    expect(await triple(f.tenantId), "precondition: unsettled after card one").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });

    const outcome = await approveAsSuperAdmin(f.certIds[1]);

    expect(outcome.kind).toBe("mirrored");
    expect(outcome.allApproved, "the COMPLETE approved set is what triggers the transition").toBe(true);

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND grade_approved_at IS NOT NULL",
        [f.destinationSubmissionId]
      )
    ).toBe("2");

    // mirror -> updateSubmissionStatus('ready_to_return') -> settlePartnerCreditForDestinationStatus
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "the final approval must transition the destination"
    ).toBe("ready_to_return");

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='active'",
        [f.partnerSubmissionId]
      )
    ).toBe("0");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='consumed'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='consumed'",
        [f.tenantId]
      ),
      "exactly one terminal consumed event per physical card"
    ).toBe("2");
    // Read one leg by raw SQL, so both legs of the triple are not from getCreditPosition alone.
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount = -1", [
        f.tenantId,
      ]),
      "exactly one -1 debit per physical card"
    ).toBe("2");

    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });
  });

  it("P4: replaying the final approval settles nothing twice — one consumed event and one debit per card, forever", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    await approveAsSuperAdmin(f.certIds[1]);
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });

    // The certificate is already approved, so the mirror finds no pending_review work item.
    const replay = await approveAsSuperAdmin(f.certIds[1]);
    expect(replay.kind).toBe("not_partner");

    expect(await triple(f.tenantId), "a replayed approval must not move money").toEqual({
      available: 8,
      reserved: 0,
      consumed: 2,
    });
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount = -1", [
        f.tenantId,
      ])
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='consumed'",
        [f.tenantId]
      )
    ).toBe("2");
    expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId])).toBe(
      "ready_to_return"
    );
  });

  it("P5: settlement REFUSES when card two's reservation is invalidated — no partial consume", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });

    // Deliberate corruption of REAL production-created state: card two's reservation is moved to a
    // release-terminal status with no authorised replacement hold. The reservation row cannot be
    // deleted (its events are append-only and FK-RESTRICT it), so this is the safest invalidation
    // that leaves everything else production-made.
    await admin.query("UPDATE partner_credit_reservations SET status='released', released_at=now() WHERE id=$1", [
      f.reservationIds[1],
    ]);

    // The final approval must now fail rather than settle card one alone.
    await expect(approveAsSuperAdmin(f.certIds[1])).rejects.toThrow();

    expect(
      await scalar<string>("SELECT status FROM partner_credit_reservations WHERE id=$1", [f.reservationIds[0]]),
      "card one's reservation must survive untouched"
    ).toBe("active");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='consumed'",
        [f.partnerSubmissionId]
      ),
      "a refused settlement must consume nothing"
    ).toBe("0");
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0", [
        f.tenantId,
      ]),
      "a refused settlement must move no money"
    ).toBe("0");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='consumed'",
        [f.tenantId]
      )
    ).toBe("0");
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "the destination must not advance on a refused settlement"
    ).toBe("in_grading");
    expect(
      await scalar<string>("SELECT count(*)::text FROM print_events WHERE cert_id = ANY($1::text[])", [f.certNumbers]),
      "nothing may print when settlement was refused"
    ).toBe("0");
  });

  it("P6: cancelling a submitted two-card submission releases exactly two and returns the wallet to 10/0/0", async () => {
    const f = await seedSubmittedOnly();
    expect(await triple(f.tenantId), "funded and reserved before cancelling").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });

    await submissions.cancelSubmission(
      principalFor({ tenantId: f.tenantId, locationId: f.locationId, graderId: f.graderId }),
      f.partnerSubmissionId,
      "full pilot cancellation"
    );

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='active'",
        [f.partnerSubmissionId]
      )
    ).toBe("0");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='released'",
        [f.partnerSubmissionId]
      ),
      "exactly one release per physical card"
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='released'",
        [f.tenantId]
      )
    ).toBe("2");
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0", [
        f.tenantId,
      ]),
      "a release returns credit by leaving the active filter, NOT by writing a debit"
    ).toBe("0");

    // Credit is fully returned: nothing reserved, nothing consumed.
    expect(await triple(f.tenantId)).toEqual({ available: 10, reserved: 0, consumed: 0 });
  });

  it("P8: the fixture certificates table matches the production Drizzle model — no schema drift", async () => {
    // A column added to shared/schema.ts must surface here as a red test, not as an opaque 42703
    // from deep inside storage.listCertificates() the next time someone touches the print path.
    const drift = await certificatesSchemaDrift(admin);
    expect(drift, `fixture certificates table is missing production columns: ${drift.join(", ")}`).toEqual([]);
    // Non-vacuity: the model really does declare the approval columns this suite depends on.
    const declared = await scalar<string>(
      `SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema='public' AND table_name='certificates'
          AND column_name IN ('grade','centering_score','corners_score','edges_score','surface_score',
                              'graded_at','grade_approved_by','grade_approved_at','print_state','nfc_uid')`,
      []
    );
    expect(Number(declared)).toBe(10);
  });
});
