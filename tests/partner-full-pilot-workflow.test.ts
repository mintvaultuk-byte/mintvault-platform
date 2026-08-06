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
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
} from "./helpers/partner-realistic-db";

let cluster: DisposablePostgres17;
let admin: Client;
let mirror: typeof import("../server/partner/grading-review-mirror");
let creditReservations: typeof import("../server/partner/partner-credit-reservation-service");

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

  // The grading columns the real approval path reads and writes, absent from the shared helper.
  for (const col of [
    "grade numeric",
    "centering_score numeric",
    "corners_score numeric",
    "edges_score numeric",
    "surface_score numeric",
    "graded_at timestamptz",
    "grade_approved_by text",
    "assigned_grader_id text",
    "rejection_reason text",
    "redo_count integer NOT NULL DEFAULT 0",
    "review_required boolean NOT NULL DEFAULT false",
  ]) {
    await admin.query(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS ${col}`);
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
     VALUES ($1,$2,$3,2,'submitted_to_mintvault',$4,$5, now()) RETURNING id`,
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

  const handoffId = await scalar<string>(
    `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot)
     VALUES ($1,$2,'pending',$3::jsonb) RETURNING id`,
    [tenantId, partnerSubmissionId, JSON.stringify({ cards: 2, fixture: "FULL-PILOT-LOCAL-01" })]
  );
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
  // in_grading — NOT ready_to_return. Reaching ready_to_return is what the final approval must do.
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

  // Wallet funded with exactly 10 credits.
  const walletId = await scalar<string>(
    "INSERT INTO partner_wallets (tenant_id, status) VALUES ($1,'active') RETURNING id",
    [tenantId]
  );
  await admin.query(
    `INSERT INTO partner_credit_ledger
       (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
     VALUES ($1,$2,10,'purchase',$3,'admin','full pilot funding','admin',$4)`,
    [walletId, tenantId, `fp-fund-${n}`, "b".repeat(64)]
  );

  const certIds: number[] = [];
  const certNumbers: string[] = [];
  const workItemIds: string[] = [];
  const reservationIds: string[] = [];

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
          print_state, grade, centering_score, corners_score, edges_score, surface_score,
          assigned_grader_id, review_required, graded_at, created_by, issued_at, updated_at,
          origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
          origin_location_id, origin_location_public_ref, origin_location_name,
          origin_captured_at, origin_snapshot_version)
       VALUES ($1,$2,$3,'active','numeric','pending_review','awaiting_approval',
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

    const reservationId = await scalar<string>(
      `INSERT INTO partner_credit_reservations
         (wallet_id, tenant_id, source, submission_reference, card_reference, reserved_credits,
          status, idempotency_key, request_fingerprint, reason, actor_type, expires_at)
       VALUES ($1,$2,'portal',$3,$4,1,'active',$5,$6,'full pilot reservation','system', now() + interval '30 days')
       RETURNING id`,
      [
        walletId,
        tenantId,
        partnerSubmissionId,
        `partner-submission-card:${cardIds[i]}:1`,
        `fp-res-${n}-${i}`,
        "c".repeat(64),
      ]
    );
    // Production writes a 'reserved' event at creation; the fixture matches it.
    await admin.query(
      `INSERT INTO partner_credit_reservation_events
         (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
          request_fingerprint, source, reason, actor_type)
       VALUES ($1,$2,$3,'reserved',1,$4,$5,'portal','full pilot reservation','system')`,
      [reservationId, walletId, tenantId, `fp-res-evt-${n}-${i}`, "c".repeat(64)]
    );
    reservationIds.push(reservationId);

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

    mirror = await import("../server/partner/grading-review-mirror");
    creditReservations = await import("../server/partner/partner-credit-reservation-service");
  }, 180_000);

  afterAll(async () => {
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
});
