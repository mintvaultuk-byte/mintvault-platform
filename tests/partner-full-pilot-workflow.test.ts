/**
 * FULL-PILOT-LOCAL-01 — the stitched Partner pilot lifecycle, on a real PostgreSQL 17 with
 * migration 0049 applied, driven through PRODUCTION services end to end.
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
  alignTableToDrizzleModel,
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
let lifecycle: typeof import("../server/partner/partner-submission-credit-lifecycle");
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
  {
    const schema = await import("../shared/schema");
    await alignTableToDrizzleModel(admin, "label_prints", schema.labelPrints);
    // The Drizzle model marks cert_id .unique(); createBatchAtomic relies on it for its
    // ON CONFLICT (cert_id) upsert, which is what makes a replayed batch idempotent rather than
    // duplicating label rows. Column alignment adds columns, not constraints, so pin it here.
    await admin.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_label_prints_cert_id ON label_prints (cert_id)");
    // requestReprint appends to reprint_log; no partner migration creates it.
    await admin.query(
      `CREATE TABLE IF NOT EXISTS reprint_log (
         id serial PRIMARY KEY, cert_id text NOT NULL, reprint_time timestamptz NOT NULL DEFAULT now()
       )`
    );
    await admin.query("ALTER TABLE reprint_log OWNER TO pn_migrator");
  }

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

type MirrorOutcome = { kind: string; allApproved?: boolean };

/**
 * FORCED OVERLAP — how P16/P18 stop being a coin flip.
 *
 * Two `mirrorPartnerApproval` calls fired with `Promise.all` on a fast local cluster routinely
 * finish one after the other; a test built that way would pass on the broken code most runs and
 * prove nothing. So the interleaving is FORCED, not hoped for:
 *
 *   1. A third connection opens a transaction and takes `FOR UPDATE` on every work item of the one
 *      destination under test. Nothing in production is changed by this — it is the test holding a
 *      row lock, exactly as a slow concurrent actor would.
 *   2. Both approvals are launched. Each one runs to the FIRST statement that needs one of those
 *      rows and stops there, inside its own open transaction.
 *   3. We WAIT until PostgreSQL itself reports both backends parked on `wait_event_type = 'Lock'`.
 *      That is the non-vacuity evidence: the overlap is observed in `pg_stat_activity`, not assumed.
 *   4. The blocker rolls back. Both actors wake in the same instant, maximally overlapped.
 *
 * Crucially the barrier is chosen so it works on BOTH the fixed code and the mutant. The fixed
 * mirror parks on its own destination-scoped `FOR UPDATE`; the mutant (which has no such lock) parks
 * on its per-card `UPDATE ... WHERE certificate_id = $1`. Either way both actors are provably
 * in-flight together before either can proceed — so when the mutant settles zero times, that is the
 * real defect and not a scheduling artefact.
 */
async function runWithForcedOverlap(
  destinationSubmissionId: number,
  actors: Array<() => Promise<MirrorOutcome>>
): Promise<{ outcomes: MirrorOutcome[]; observedBlocked: number }> {
  const blocker = new Client({ connectionString: cluster.url });
  const watcher = new Client({ connectionString: cluster.url });
  await blocker.connect();
  await watcher.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM partner_grading_work_items WHERE destination_submission_id = $1 ORDER BY id FOR UPDATE",
      [destinationSubmissionId]
    );

    const inflight = actors.map((actor) => actor());
    // Never let an early rejection surface as an unhandled rejection while we are still polling.
    const settled = Promise.allSettled(inflight);

    let observedBlocked = 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const r = await watcher.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'`
      );
      observedBlocked = Math.max(observedBlocked, Number(r.rows[0].n));
      if (observedBlocked >= actors.length) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Release the barrier only once every actor is provably parked, so they resume together.
    await blocker.query("ROLLBACK");

    const results = await settled;
    const outcomes = results.map((r) => {
      if (r.status === "rejected") throw r.reason;
      return r.value;
    });
    return { outcomes, observedBlocked };
  } finally {
    await blocker.end().catch(() => {});
    await watcher.end().catch(() => {});
  }
}

/** The complete settled end state: 2 approved cards, ready_to_return, 2/2/2, wallet 8/0/2. */
async function expectSettledExactlyOnce(f: Pilot): Promise<void> {
  expect(
    await scalar<string>(
      "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
      [f.partnerSubmissionId]
    ),
    "both cards must end approved"
  ).toBe("2");
  expect(
    await scalar<string>(
      "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND grade_approved_at IS NOT NULL",
      [f.destinationSubmissionId]
    ),
    "both certificates must end published"
  ).toBe("2");
  expect(
    await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
    "the destination must have transitioned — a fully graded, unbilled submission stuck in in_grading is the defect"
  ).toBe("ready_to_return");
  expect(
    await scalar<string>(
      "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='consumed'",
      [f.partnerSubmissionId]
    ),
    "exactly two consumed reservations"
  ).toBe("2");
  expect(
    await scalar<string>(
      "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='active'",
      [f.partnerSubmissionId]
    ),
    "no reservation may be left active"
  ).toBe("0");
  expect(
    await scalar<string>(
      "SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='consumed'",
      [f.tenantId]
    ),
    "exactly one terminal consumed event per physical card — two, never four"
  ).toBe("2");
  expect(
    await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount = -1", [
      f.tenantId,
    ]),
    "exactly one -1 debit per physical card — double settlement would show as four"
  ).toBe("2");
  expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });
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
    /**
     * P9/P10 drive the REAL createBatchAtomic, which uploads four rendered assets per batch under
     * `print-batches/<batchId>-...` from inside server/print-batch.ts. This suite never sees those
     * keys, so `track()` cannot cover them and `cleanup()` used to miss all of them: an independent
     * A/B storage audit measured exactly 16 orphaned objects left behind after every run, in both
     * matrices. Registering the prefix is what makes this suite clean up after itself.
     */
    storage.trackPrefix("print-batches/");

    mirror = await import("../server/partner/grading-review-mirror");
    creditReservations = await import("../server/partner/partner-credit-reservation-service");
    wallet = await import("../server/partner/partner-wallet-service");
    submissions = await import("../server/partner/submission-service");
    printWorkflow = await import("../server/print-workflow");
    lifecycle = await import("../server/partner/partner-submission-credit-lifecycle");
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
    // F1: the replay of an already-settled destination is now NAMED, not collapsed into the same
    // `not_partner` an ordinary HQ card returns. That indistinguishability WAS the finding.
    expect(replay.kind).toBe("already_settled");

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

  it("P9: after settlement the real print workflow batches, prints and completes both cards", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    await approveAsSuperAdmin(f.certIds[1]);

    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='needs_printing'",
        [f.destinationSubmissionId]
      ),
      "approval moves both certificates awaiting_approval -> needs_printing"
    ).toBe("2");

    const actor = { actor: SUPER_ADMIN, role: "admin" as const };

    // A PARTIAL selection must be refused before anything is written.
    const partial = await printWorkflow.createBatchAtomic({ certIds: [f.certNumbers[0]], identity: actor });
    expect(partial.applied, "a one-card Partner batch must write nothing").toEqual([]);
    expect(partial.rejected.map((r) => r.code)).toContain("partner_submission_incomplete");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='needs_printing'",
        [f.destinationSubmissionId]
      ),
      "the refused partial batch leaves both cards retryable"
    ).toBe("2");

    const batch = await printWorkflow.createBatchAtomic({ certIds: f.certNumbers, identity: actor });
    expect(batch.rejected, JSON.stringify(batch.rejected)).toEqual([]);
    expect(batch.applied.sort()).toEqual([...f.certNumbers].sort());
    expect(batch.batchId).toBeTruthy();
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='printing'",
        [f.destinationSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>("SELECT count(*)::text FROM label_prints WHERE cert_id = ANY($1::text[])", [f.certNumbers]),
      "exactly one label_prints row per certificate"
    ).toBe("2");

    const printed = await printWorkflow.markBatchPrinted(batch.batchId as string, actor);
    expect(printed.rejected).toEqual([]);
    expect(
      await scalar<string>("SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='printed'", [
        f.destinationSubmissionId,
      ])
    ).toBe("2");
    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId])
    ).not.toBe("completed");

    const completed = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: actor });
    expect(completed.rejected, JSON.stringify(completed.rejected)).toEqual([]);
    expect(completed.applied.sort()).toEqual([...f.certNumbers].sort());

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM print_events WHERE cert_id = ANY($1::text[]) AND action='complete' AND actor=$2",
        [f.certNumbers, SUPER_ADMIN]
      ),
      "print_events is the authoritative completion trail"
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='completed'",
        [f.destinationSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='completed'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId])).toBe(
      "completed"
    );

    // Printing must not disturb settled money.
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });

    // Replay: no duplicate completion evidence.
    const replay = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: actor });
    expect(replay.applied).toEqual([]);
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM print_events WHERE cert_id = ANY($1::text[]) AND action='complete'",
        [f.certNumbers]
      )
    ).toBe("2");
    expect(
      await scalar<string>("SELECT count(*)::text FROM label_prints WHERE cert_id = ANY($1::text[])", [f.certNumbers])
    ).toBe("2");
  }, 120_000);

  it("P10: reprint requires a real reason and writes audited evidence", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    await approveAsSuperAdmin(f.certIds[1]);
    const actor = { actor: SUPER_ADMIN, role: "admin" as const };
    const batch = await printWorkflow.createBatchAtomic({ certIds: f.certNumbers, identity: actor });
    await printWorkflow.markBatchPrinted(batch.batchId as string, actor);

    expect(
      await scalar<string>("SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='printed'", [
        f.destinationSubmissionId,
      ]),
      "precondition: both cards printed, so reprint has a legitimate source state"
    ).toBe("2");

    // A reason below the 10-character floor must be refused, and must write NOTHING.
    const tooShort = await printWorkflow.requestReprint({
      certIds: f.certNumbers,
      reason: "too short",
      reasonCategory: "damaged_label",
      identity: actor,
    });
    expect(tooShort.applied, "a sub-minimum reason must not reprint anything").toEqual([]);
    expect(tooShort.rejected.map((r) => r.code)).toEqual(["reason_required", "reason_required"]);
    expect(
      await scalar<string>("SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='printed'", [
        f.destinationSubmissionId,
      ]),
      "the refused reprint must leave print_state untouched"
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM print_events WHERE cert_id = ANY($1::text[]) AND action='reprint'",
        [f.certNumbers]
      )
    ).toBe("0");
    expect(
      await scalar<string>("SELECT count(*)::text FROM reprint_log WHERE cert_id = ANY($1::text[])", [f.certNumbers])
    ).toBe("0");

    // A valid reason reprints, and the reason itself is persisted as audit evidence.
    const reason = "Label peeled off in transit and must be reprinted for the customer.";
    const ok = await printWorkflow.requestReprint({
      certIds: f.certNumbers,
      reason,
      reasonCategory: "damaged_label",
      identity: actor,
    });
    expect(ok.rejected, JSON.stringify(ok.rejected)).toEqual([]);
    expect(ok.applied.sort()).toEqual([...f.certNumbers].sort());

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='reprint_required'",
        [f.destinationSubmissionId]
      )
    ).toBe("2");
    // The audited actor trail carries the actor AND the verbatim reason — not just a state change.
    expect(
      await scalar<string>(
        `SELECT count(*)::text FROM print_events
          WHERE cert_id = ANY($1::text[]) AND action='reprint' AND actor=$2
            AND from_state='printed' AND to_state='reprint_required' AND reason=$3`,
        [f.certNumbers, SUPER_ADMIN, reason]
      ),
      "every reprint must be attributable to an actor and carry its reason"
    ).toBe("2");
    expect(
      await scalar<string>("SELECT count(*)::text FROM reprint_log WHERE cert_id = ANY($1::text[])", [f.certNumbers])
    ).toBe("2");

    // Settled money is untouched by a reprint.
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });
  }, 120_000);

  it("P11: a failure AFTER card one has settled rolls the whole transaction back — no partial consume", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });

    // Deterministic failure INSIDE the settlement transaction, after card one has already been
    // consumed. CREDIT1 proves refusal BEFORE any money moves; this proves rollback once it has.
    //
    // The consume loop runs in reservation (created_at, id) order and writes one ledger row per
    // card with correlation_id = that reservation's id. A CHECK constraint rejecting card TWO's
    // correlation_id therefore fires only on the second iteration — card one's UPDATE, ledger row
    // and consumed event are already written when it raises. This is a database-level condition,
    // not a production code path, so nothing client-reachable is added.
    await admin.query(
      `ALTER TABLE partner_credit_ledger
         ADD CONSTRAINT tmp_settle2_block_card_two
         CHECK (correlation_id IS NULL OR correlation_id <> '${f.reservationIds[1]}')`
    );
    try {
      await expect(approveAsSuperAdmin(f.certIds[1])).rejects.toThrow();

      // The whole transaction must have rolled back — including card one's already-written work.
      expect(
        await scalar<string>(
          "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='active'",
          [f.partnerSubmissionId]
        ),
        "BOTH reservations must still be active; card one's consume must have been undone"
      ).toBe("2");
      expect(
        await scalar<string>(
          "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='consumed'",
          [f.partnerSubmissionId]
        ),
        "a one-card consumed state is the exact corruption this guard exists to prevent"
      ).toBe("0");
      expect(
        await scalar<string>(
          "SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='consumed'",
          [f.tenantId]
        )
      ).toBe("0");
      expect(
        await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0", [
          f.tenantId,
        ]),
        "not one debit may survive a rolled-back settlement"
      ).toBe("0");
      expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });
      expect(
        await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
        "the destination must stay retryable, not stranded mid-settlement"
      ).toBe("in_grading");
    } finally {
      await admin.query("ALTER TABLE partner_credit_ledger DROP CONSTRAINT tmp_settle2_block_card_two");
    }

    // RECOVERY IS NOT THROUGH RE-APPROVAL, and asserting that it was would have been wrong.
    // approveAsSuperAdmin's certificate publish and mirrorPartnerApproval's work-item update each
    // COMMIT before settlement runs on a separate pool. So after the injected failure the cards are
    // already approved: a replayed approval matches no pending_review work item, the mirror returns
    // not_partner, and updateSubmissionStatus is never reached. The submission would sit unsettled
    // forever if approval were the only route.
    const replay = await approveAsSuperAdmin(f.certIds[1]);
    expect(replay.kind, "the approval route cannot re-drive a failed settlement").toBe("not_partner");
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });

    // The real recovery is the destination status transition — the same entry point the mirror
    // would have used. With the injected failure gone it settles cleanly, which is what proves the
    // rollback left recoverable state rather than a stranded submission.
    const settled = await lifecycle.settlePartnerCreditForDestinationStatus(
      f.destinationSubmissionId,
      "ready_to_return",
      {}
    );
    expect(settled, "the documented operator recovery must actually settle").not.toBeNull();
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });
  });

  it("P12: SETTLE2 — a JS throw after card ONE has settled still rolls both cards back", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });

    // P11 injects a CHECK violation, which proves rollback at the DATABASE layer: once Postgres
    // aborts, nothing else can run, so no application-level mutation can produce a partial commit.
    // A plain JS throw leaves the transaction healthy, so this is the only injection that actually
    // exercises the SAVEPOINT/rollback CODE.
    let fired = 0;
    lifecycle.__setSettlementFailPointForTest(({ index }) => {
      fired += 1;
      if (index === 0) throw new Error("SETTLE2 injected failure after card one");
    });
    try {
      await expect(approveAsSuperAdmin(f.certIds[1])).rejects.toThrow();
      expect(fired, "the failpoint must have fired exactly once, on card one").toBe(1);

      expect(
        await scalar<string>(
          "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='active'",
          [f.partnerSubmissionId]
        ),
        "card one's consume must be undone even though it had already succeeded"
      ).toBe("2");
      expect(
        await scalar<string>(
          "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='consumed'",
          [f.partnerSubmissionId]
        )
      ).toBe("0");
      expect(
        await scalar<string>(
          "SELECT count(*)::text FROM partner_credit_reservation_events WHERE tenant_id=$1 AND event_type='consumed'",
          [f.tenantId]
        )
      ).toBe("0");
      expect(
        await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0", [
          f.tenantId,
        ]),
        "a partial one-card debit is the exact corruption SETTLE2 guards against"
      ).toBe("0");
      expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });
      expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId])).toBe(
        "in_grading"
      );
    } finally {
      lifecycle.__clearSettlementFailPointForTest();
    }

    // Recoverable, not stranded: with the failpoint cleared the documented operator route settles.
    const settled = await lifecycle.settlePartnerCreditForDestinationStatus(
      f.destinationSubmissionId,
      "ready_to_return",
      {}
    );
    expect(settled).not.toBeNull();
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });
  }, 120_000);

  /**
   * P14 / P15 — the SETTLEMENT-SIDE grading approval gate.
   *
   * MUTATION TARGETS (PR #288 mutation matrix, WORKITEM1 and CERT1). Both survived behaviourally:
   *
   *   • WORKITEM1 disabled `assertPartnerGradingApprovedForSettlement`'s cardinality comparison
   *     (`n !== expectedUnits` made unreachable) — 104/104 green.
   *   • CERT1 stripped its two certificate predicates (`cert.grader_status = 'approved'` and
   *     `cert.grade_approved_at IS NOT NULL`) — caught ONLY by a source-string pin; re-running
   *     without that pin gave 78/78 green.
   *
   * This is a genuine SECOND layer behind the mirror's `bool_and` completeness check (which P2
   * already proves), so the product was not at risk — but the layer itself carried no evidence, so
   * it could be deleted silently. These two tests are that evidence, and they are behavioural: they
   * drive the real `settlePartnerCreditForDestinationStatus` and assert the money does not move.
   */
  it("P14: settlement REFUSES while any work item is still pending_review (WORKITEM1)", async () => {
    const f = await seedPilotAtPendingReview();
    // No approval at all: both work items are pending_review, so the approved count is 0 and the
    // expected count is 2. This is the comparison WORKITEM1 disabled.
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
        [f.partnerSubmissionId]
      ),
      "precondition: nothing is approved yet"
    ).toBe("0");
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });

    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(f.destinationSubmissionId, "ready_to_return", {}),
      "unreviewed grading must never settle credits"
    ).rejects.toThrow(/reconciliation/i);

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_accounting_exceptions WHERE destination_submission_id=$1 AND reason_code='partner_grading_approval_missing'",
        [f.destinationSubmissionId]
      ),
      "the refusal must leave durable evidence naming the reason"
    ).toBe("1");
    expect(await triple(f.tenantId), "not one credit may move").toEqual({ available: 8, reserved: 2, consumed: 0 });
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "the destination must stay where it was, not advance on a refused settlement"
    ).toBe("in_grading");
  });

  it("P15: settlement REFUSES when work items are approved but the CERTIFICATES are not published (CERT1)", async () => {
    const f = await seedPilotAtPendingReview();

    /**
     * The exact state CERT1's two predicates exist for: the partner-facing work items say
     * "approved", but no Super Admin ever published the certificate — `grader_status` is still
     * pending_review and `grade_approved_at` is NULL. Set directly rather than through the approval
     * route, because the approval route would (correctly) publish the certificates too; the point is
     * to reach the gate with work-item state and certificate state DISAGREEING.
     */
    await admin.query("UPDATE partner_grading_work_items SET status='approved' WHERE partner_submission_id=$1", [
      f.partnerSubmissionId,
    ]);
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
        [f.partnerSubmissionId]
      ),
      "precondition: the cardinality check ALONE would now be satisfied — only the certificate predicates can refuse"
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE id = ANY($1::int[]) AND grader_status='approved' AND grade_approved_at IS NOT NULL",
        [f.certIds]
      ),
      "precondition: neither certificate is published"
    ).toBe("0");

    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(f.destinationSubmissionId, "ready_to_return", {}),
      "an unpublished certificate must never settle credits, however the work item is labelled"
    ).rejects.toThrow(/reconciliation/i);

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_accounting_exceptions WHERE destination_submission_id=$1 AND reason_code='partner_grading_approval_missing'",
        [f.destinationSubmissionId]
      )
    ).toBe("1");
    expect(await triple(f.tenantId), "not one credit may move").toEqual({ available: 8, reserved: 2, consumed: 0 });

    // POSITIVE CONTROL: publish both certificates and the SAME call settles. Without this, both
    // tests above would still pass if the gate simply refused everything.
    await approveAsSuperAdmin(f.certIds[0]);
    await approveAsSuperAdmin(f.certIds[1]);
    const settled = await lifecycle.settlePartnerCreditForDestinationStatus(
      f.destinationSubmissionId,
      "ready_to_return",
      {}
    );
    expect(settled, "with the certificates genuinely published, settlement proceeds").not.toBeNull();
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 0, consumed: 2 });
  }, 120_000);

  /**
   * P16 / P17 / P18 — APPROVAL-CROSSCARD1, the cross-card write skew.
   *
   * THE DEFECT. The mirror's completeness test is a SUBMISSION-level decision assembled from
   * PER-CARD writes. Two Super Admins approving two DIFFERENT cards of the same submission update
   * two different rows, so under READ COMMITTED they never block each other and each reads the
   * other's card as still `pending_review`. Both return `mirrored` with `allApproved: false`, every
   * card ends approved, and NOBODY settles: the submission is fully graded, unbilled, and stranded
   * in `in_grading` with two credits reserved forever. Textbook write skew — no row is written
   * twice, yet the invariant "the complete approved set settles exactly once" is broken.
   *
   * THE FIX. A destination-scoped `SELECT ... ORDER BY id FOR UPDATE` taken BEFORE the per-card
   * UPDATE. It serialises the two actors onto the one submission they share, so exactly one of them
   * observes the complete approved set and exactly one settles.
   */
  it("P16: FORCED OVERLAP — two Super Admins approving DIFFERENT cards settle exactly once (APPROVAL-CROSSCARD1)", async () => {
    const f = await seedPilotAtPendingReview();
    expect(await triple(f.tenantId), "precondition: nothing settled").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });

    const { outcomes, observedBlocked } = await runWithForcedOverlap(f.destinationSubmissionId, [
      () => approveAsSuperAdmin(f.certIds[0]),
      () => approveAsSuperAdmin(f.certIds[1]),
    ]);

    // NON-VACUITY OF THE OVERLAP ITSELF. If this is not 2, the two approvals did not actually
    // overlap and every assertion below would be a sequential run wearing a concurrency costume.
    expect(
      observedBlocked,
      "PostgreSQL must have reported BOTH approval backends parked on a lock at the same instant"
    ).toBe(2);

    // Both actors succeed — neither is asked to retry — but only one sees the complete set.
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["mirrored", "mirrored"]);
    expect(
      outcomes.filter((o) => o.allApproved === true),
      "EXACTLY ONE actor may observe the complete approved set; two = double settlement, zero = the stranded-submission defect"
    ).toHaveLength(1);

    await expectSettledExactlyOnce(f);
  }, 120_000);

  it("P17: SEQUENTIAL CONTROL — the same two approvals, un-overlapped, reach the identical end state", async () => {
    // The control that makes P16 falsifiable in the other direction. If the barrier machinery
    // itself (the third connection, the row lock, the rollback) were what produced the single
    // settlement, this run — which uses none of it — would settle a different number of times.
    const f = await seedPilotAtPendingReview();

    const first = await approveAsSuperAdmin(f.certIds[0]);
    expect(first.kind).toBe("mirrored");
    expect(first.allApproved, "card one of two is not the complete set").toBe(false);
    expect(await triple(f.tenantId), "still unsettled between the two approvals").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });

    const second = await approveAsSuperAdmin(f.certIds[1]);
    expect(second.kind).toBe("mirrored");
    expect(second.allApproved).toBe(true);

    await expectSettledExactlyOnce(f);
  }, 120_000);

  it("P18: FORCED OVERLAP — the SAME card approved twice at once still cannot double-settle", async () => {
    // The same-card race, re-proved against the new lock. Card one is already approved, so this is
    // the final approval — the one that settles — being driven twice simultaneously.
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    expect(await triple(f.tenantId)).toEqual({ available: 8, reserved: 2, consumed: 0 });

    const { outcomes, observedBlocked } = await runWithForcedOverlap(f.destinationSubmissionId, [
      () => approveAsSuperAdmin(f.certIds[1]),
      () => approveAsSuperAdmin(f.certIds[1]),
    ]);

    expect(observedBlocked, "both same-card actors must have been provably in flight together").toBe(2);

    // One wins the row; the loser finds its card already `approved` under the lock and reports the
    // final state as success WITHOUT settling again. Neither is a 409 — the card genuinely IS
    // approved, and the route only converts `conflict` into 409.
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["already_approved", "mirrored"]);
    expect(
      outcomes.filter((o) => o.allApproved === true),
      "the winner settles; the loser must not"
    ).toHaveLength(1);
    expect(
      outcomes.some((o) => o.kind === "conflict"),
      "a genuinely approved card must never be reported to the operator as a conflict"
    ).toBe(false);

    await expectSettledExactlyOnce(f);
  }, 120_000);

  /**
   * P19 / P20 / P21 / P22 — FINDING F1, the commit-then-act window.
   *
   * THE DEFECT. `mirrorPartnerApproval` mirrors the work item to `approved` in a transaction, that
   * transaction COMMITS, and only then is settlement driven — deliberately outside it, because
   * pulling settlement inside would give this module the lock order
   * `partner_grading_work_items -> submissions -> partner_credit_*` against settlement's and
   * `markCompleted`'s opposite order, i.e. an ABBA deadlock cycle. That design is correct and is
   * NOT changed here.
   *
   * What was broken is what happens when the window is interrupted. The entry gate was
   * `pgwi.status = 'pending_review'`, which is PRE-commit state: once the mirror committed it was
   * false forever, so every retry returned `not_partner` and the route reported HTTP 200. A
   * submission whose settlement had thrown was left with every work item approved, every
   * certificate published, the destination stuck in `in_grading`, N credits reserved and ZERO
   * debits — held for the full 365-day reservation TTL — and no retry could tell anyone.
   *
   * THE FIX. The gate now keys on POST-COMMIT state, and the re-drive takes NO lock of its own:
   * three read-committed SELECTs, then the SAME settlement entry point on its own connection with
   * its own unchanged lock order. No new edge in the wait-for graph.
   */
  it("P19: F1 — an interrupted settlement strands the submission, and the retry RE-DRIVES it instead of reporting 200", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);
    expect(await triple(f.tenantId), "precondition: card one mirrored, nothing settled").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });

    /**
     * Open the window. Any fail-closed settlement condition does this; a crash, a pod restart or a
     * transient DB loss between the mirror COMMIT and the settlement call opens the identical
     * window with no injection at all. `reconciliation_required` is a real operational state of
     * partner_connector_imports (0010), so this is production-shaped, not a synthetic poke.
     */
    await admin.query(
      "UPDATE partner_connector_imports SET state='reconciliation_required' WHERE destination_submission_id=$1",
      [f.destinationSubmissionId]
    );

    // The final approval commits the work item, then settlement refuses.
    await expect(approveAsSuperAdmin(f.certIds[1])).rejects.toThrow(/reconciliation/i);

    // ── THE STRANDED STATE, exactly as the hostile review reproduced it ──────────────────────
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
        [f.partnerSubmissionId]
      ),
      "both work items committed approved"
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND grade_approved_at IS NOT NULL",
        [f.destinationSubmissionId]
      ),
      "both certificates published"
    ).toBe("2");
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "the destination is stuck short of settlement"
    ).toBe("in_grading");
    expect(await triple(f.tenantId), "2 credits still reserved, 0 debits").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount = -1", [
        f.tenantId,
      ]),
      "zero debits"
    ).toBe("0");

    /**
     * RETRY WITH THE CAUSE STILL PRESENT. This is the assertion the whole finding turns on: the
     * OLD code answered `not_partner` here and the route turned that into 200 {ok:true} over money
     * that had not moved. It must now name the condition instead.
     */
    const blocked = (await mirror.mirrorPartnerApproval(f.certIds[1], SUPER_ADMIN)) as {
      kind: string;
      reasonCode?: string;
      destinationSubmissionId?: number | null;
    };
    expect(blocked.kind, "a retry over unmoved money must never read as success").toBe("settlement_failed");
    expect(blocked.reasonCode, "the refusal names the fail-closed condition").toBe("credit_settlement_required");
    expect(blocked.destinationSubmissionId).toBe(f.destinationSubmissionId);
    expect(await triple(f.tenantId), "a refused retry moves nothing").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_accounting_exceptions WHERE destination_submission_id=$1 AND reason_code='partner_mapping_not_completed'",
        [f.destinationSubmissionId]
      ),
      "the refused retry leaves durable evidence naming the reason"
    ).toBe("1");

    // ── OPERATOR FIXES THE CAUSE AND RETRIES ────────────────────────────────────────────────
    await admin.query("UPDATE partner_connector_imports SET state='completed' WHERE destination_submission_id=$1", [
      f.destinationSubmissionId,
    ]);
    const redriven = (await mirror.mirrorPartnerApproval(f.certIds[1], SUPER_ADMIN)) as { kind: string };
    expect(redriven.kind, "the same retry now DRIVES settlement to completion").toBe("settled_on_retry");

    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "the destination is settled"
    ).toBe("ready_to_return");
    await expectSettledExactlyOnce(f);

    // And a THIRD call is a no-op that still does not claim to have settled anything new.
    const replay = (await mirror.mirrorPartnerApproval(f.certIds[1], SUPER_ADMIN)) as { kind: string };
    expect(replay.kind).toBe("already_settled");
    await expectSettledExactlyOnce(f);
  }, 180_000);

  it("P20: F1 — the stranded submission is VISIBLE to an operator, and disappears once it settles", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);

    // Not stranded yet: card two is still pending_review, so there is nothing to settle.
    expect(
      (await mirror.findStrandedPartnerSettlements()).map((s) => s.destinationSubmissionId),
      "a half-graded submission is not stranded — it is simply not finished"
    ).not.toContain(f.destinationSubmissionId);

    await admin.query(
      "UPDATE partner_connector_imports SET state='reconciliation_required' WHERE destination_submission_id=$1",
      [f.destinationSubmissionId]
    );
    await expect(approveAsSuperAdmin(f.certIds[1])).rejects.toThrow();

    const stranded = await mirror.findStrandedPartnerSettlements();
    const row = stranded.find((s) => s.destinationSubmissionId === f.destinationSubmissionId);
    expect(row, "an approved-but-unsettled destination must be nameable by a query").toBeDefined();
    expect(row?.destinationStatus).toBe("in_grading");
    expect(row?.liveUnits).toBe(2);
    expect(row?.tenantId).toBe(f.tenantId);
    expect(row?.partnerSubmissionId).toBe(f.partnerSubmissionId);

    await admin.query("UPDATE partner_connector_imports SET state='completed' WHERE destination_submission_id=$1", [
      f.destinationSubmissionId,
    ]);
    expect((await mirror.mirrorPartnerApproval(f.certIds[1], SUPER_ADMIN)).kind).toBe("settled_on_retry");
    expect(
      (await mirror.findStrandedPartnerSettlements()).map((s) => s.destinationSubmissionId),
      "once settled it must leave the stranded list"
    ).not.toContain(f.destinationSubmissionId);
  }, 180_000);

  it("P21: F1 — a card whose SIBLINGS are still outstanding is reported as such, never as settled", async () => {
    const f = await seedPilotAtPendingReview();
    await approveAsSuperAdmin(f.certIds[0]);

    const outcome = (await mirror.mirrorPartnerApproval(f.certIds[0], SUPER_ADMIN)) as {
      kind: string;
      outstandingUnits?: number;
    };
    expect(outcome.kind).toBe("settlement_pending_other_cards");
    expect(outcome.outstandingUnits, "card two is still pending_review").toBe(1);
    expect(await triple(f.tenantId), "re-approving a done card must not settle a half-graded set").toEqual({
      available: 8,
      reserved: 2,
      consumed: 0,
    });
    expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId])).toBe(
      "in_grading"
    );
  }, 120_000);

  it("P22: F1 — a certificate with no partner work item is still an ordinary HQ card", async () => {
    // NEGATIVE CONTROL. The re-drive must not turn every non-partner approval into partner work.
    expect((await mirror.mirrorPartnerApproval(2_147_000_001, SUPER_ADMIN)).kind).toBe("not_partner");
  });

  it("P13: the settlement failpoint is refused outside the test runner", async () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => lifecycle.__setSettlementFailPointForTest(() => {})).toThrow(/only available under the test runner/);
    } finally {
      process.env.NODE_ENV = prior;
    }
  });
});
