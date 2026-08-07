/**
 * Partner completion cascade — REAL production `markCompleted` against a disposable PostgreSQL 17
 * with migration 0045 applied.
 *
 * WHY THIS SUITE EXISTS.
 * ---------------------
 * `markCompleted`'s partner-submission cascade shipped an UPDATE that set
 * `partner_submissions.completed_at`. That column has never existed: 0007 creates the table without
 * it and the only later ADD COLUMN on that table (0044) adds `location_name_snapshot`. PostgreSQL
 * raises 42703 at PARSE time, which aborts the enclosing `db.transaction` — rolling back the
 * certificate `print_state` updates, the `complete` `print_events` rows AND the work-item update.
 * No Partner submission could ever complete, and the operator saw a bare 500.
 *
 * It survived every existing suite because the whole cascade sits behind
 * `to_regclass('public.partner_grading_work_items')` and NO DB-backed test had ever created that
 * table. `tests/print-workflow-service.test.ts` applies only 0022, so the guard returns NULL and
 * lines 1036-1156 of server/print-workflow.ts are skipped in their entirety. A source-text
 * assertion could not have caught it either — the SQL was syntactically perfect, it just named a
 * column that does not exist.
 *
 * So the only thing that can pin this is what this file does: build the real four-level shape
 * (certificate -> work item -> partner submission -> destination submission), apply 0045 so the
 * guard opens, and call the real production function. T2 is the mutation target: reintroducing
 * `completed_at = NOW()` must turn T1 RED with SQLSTATE 42703.
 *
 * SELF-PROVISIONING: starts its own PostgreSQL 17 cluster. Needs POSTGRES17_BIN or docker; it never
 * skips — `startPostgres17` throws rather than letting the proof go quietly missing.
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
let printWorkflow: typeof import("../server/print-workflow");

/** Incremented per fixture so every run is rerun-safe within one cluster. */
let sequence = 0;

const ACTOR = { actor: "completion-cascade-admin@example.test", role: "admin" as const };

interface PilotFixture {
  tenantId: string;
  locationId: string;
  partnerSubmissionId: string;
  destinationSubmissionId: number;
  certNumbers: string[];
  certIds: number[];
  workItemIds: string[];
  reservationIds: string[];
}

/**
 * The MintVault-side tables no partner migration creates. `submissions` carries the FULL column set
 * the completion cascade writes (status, shipped_at, completed_at, updated_at) — a trimmed stub
 * would make level 3 of the cascade fail for a reason unrelated to what is under test.
 */
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
  // The composite FK targets 0045 needs on the MintVault side.
  await admin.query("CREATE UNIQUE INDEX uq_submission_items_submission ON submission_items (submission_id, id)");
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

/**
 * 0022 is the print lifecycle: it adds `certificates.print_state` and creates `print_batches` and
 * `print_events`. It is NOT in any PARTNER_MIGRATIONS_* list, so it is applied directly here — the
 * completion path writes `print_events` and reads `print_state`, and neither exists without it.
 */
async function applyPrintLifecycle(): Promise<void> {
  const sql = readFileSync(join(process.cwd(), "migrations", "0022_print_workflow_lifecycle.sql"), "utf8");
  await admin.query(sql);
  for (const t of ["print_batches", "print_events"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/**
 * Build the exact shape production leaves behind at the moment before completion: two approved
 * certificates in `printed`, two approved work items, and two CONSUMED reservations. Every row is
 * the real table with the real constraints — 0045's composite FKs reject any shortcut here.
 */
async function seedCompletionReadyPilot(opts?: {
  reservationStatus?: string;
  /**
   * The DESTINATION submission's status. Default `ready_to_return` is the settled state. T7 needs
   * an UNsettled destination, which is the only way to exercise the batch-phase settlement gate.
   */
  destinationStatus?: string;
}): Promise<PilotFixture> {
  const n = ++sequence;
  const reservationStatus = opts?.reservationStatus ?? "consumed";
  const destinationStatus = opts?.destinationStatus ?? "ready_to_return";

  const tenantId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id",
      [`cc-org-${n}`, `Completion Cascade ${n} Ltd`]
    )
  ).rows[0].id;

  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id, partner_id, public_ref, name, status) VALUES ($1,$1,$2,$3,'ACTIVE') RETURNING id",
      [tenantId, `cc-loc-${n}`, `Completion Cascade ${n} HQ`]
    )
  ).rows[0].id;

  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required)
       VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
      [`cc-user-${n}`, tenantId, `cc-user-${n}@example.test`]
    )
  ).rows[0].id;

  const customerId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,$2) RETURNING id",
      [tenantId, `Completion Customer ${n}`]
    )
  ).rows[0].id;

  await admin.query(
    `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active)
     VALUES ($1,$2,'Cascade Tier',1500,20,true)`,
    [tenantId, `cc-tier-${n}`]
  );

  // Partner submission at the post-handover lifecycle state 0044 widened the CHECK to allow.
  const partnerSubmissionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions
         (tenant_id, location_id, created_by, card_count, status, customer_id, service_tier_code, submitted_at)
       VALUES ($1,$2,$3,2,'submitted_to_mintvault',$4,$5, now()) RETURNING id`,
      [tenantId, locationId, userId, customerId, `cc-tier-${n}`]
    )
  ).rows[0].id;

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
        `Cascade Card ${i}`,
        // The image-key CHECK constraints on partner_grading_work_items pin this exact prefix.
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/front-cc.jpg`,
        `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/back-cc.jpg`,
      ]
    );
    cardIds.push(cardId);
  }

  const handoffId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot)
       VALUES ($1,$2,'pending',$3::jsonb) RETURNING id`,
      [tenantId, partnerSubmissionId, JSON.stringify({ cards: 2, fixture: "completion-cascade" })]
    )
  ).rows[0].id;

  const connectorId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_connector_records (tenant_id, partner_submission_id, handoff_id, state, attempt_count)
       VALUES ($1,$2,$3,'imported',1) RETURNING id`,
      [tenantId, partnerSubmissionId, handoffId]
    )
  ).rows[0].id;

  const validationRunId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_connector_validation_runs
         (connector_record_id, validation_attempt, source_submission_version, source_handoff_status,
          source_fingerprint, source_fingerprint_version, outcome, blocking_error_count, warning_count, completed_at)
       VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
      [connectorId, "a".repeat(64)]
    )
  ).rows[0].id;

  // The destination sits at ready_to_return — the state settlement leaves it in, and the state the
  // completion cascade's level 3 advances from.
  const destinationSubmissionId = (
    await admin.query<{ id: number }>(
      `INSERT INTO submissions (user_id, tracking_number, status) VALUES ('cc-owner',$1,$2) RETURNING id`,
      [`MV-CC-${n}`, destinationStatus]
    )
  ).rows[0].id;

  const importId = (
    await admin.query<{ id: string }>(
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
    )
  ).rows[0].id;

  // Wallet + ledger so the reservations reference a real funded wallet.
  const walletId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_wallets (tenant_id, status) VALUES ($1,'active') RETURNING id",
      [tenantId]
    )
  ).rows[0].id;
  await admin.query(
    `INSERT INTO partner_credit_ledger
       (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
     VALUES ($1,$2,10,'purchase',$3,'admin','cascade fixture','admin',$4)`,
    [walletId, tenantId, `cc-fund-${n}`, "b".repeat(64)]
  );

  const certNumbers: string[] = [];
  const certIds: number[] = [];
  const workItemIds: string[] = [];
  const reservationIds: string[] = [];

  for (let i = 0; i < 2; i++) {
    const itemId = (
      await admin.query<{ id: number }>("INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id", [
        destinationSubmissionId,
      ])
    ).rows[0].id;

    const certNumber = `MV${9000 + n * 10 + i}`;
    const certId = (
      await admin.query<{ id: number }>(
        // The 0035 origin constraints are paired: a PARTNER certificate must carry the full
        // immutable origin snapshot AND its capture metadata, or the row is rejected outright.
        `INSERT INTO certificates
           (certificate_number, submission_id, submission_item_id, status, grade_type, grader_status,
            print_state, grade_approved_at, created_by, issued_at, updated_at,
            origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
            origin_location_id, origin_location_public_ref, origin_location_name,
            origin_captured_at, origin_snapshot_version)
         VALUES ($1,$2,$3,'active','numeric','approved','printed', now(),'partner_connector', now(), now(),
                 'PARTNER',$4,$5,$6,$7,$8,$9, now(), 1)
         RETURNING id`,
        [
          certNumber,
          destinationSubmissionId,
          itemId,
          tenantId,
          `cc-org-${n}`,
          `Completion Cascade ${n} Ltd`,
          locationId,
          `cc-loc-${n}`,
          `Completion Cascade ${n} HQ`,
        ]
      )
    ).rows[0].id;
    certNumbers.push(certNumber);
    certIds.push(certId);

    const reservationId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_credit_reservations
           (wallet_id, tenant_id, source, submission_reference, card_reference, reserved_credits,
            status, consumed_at, idempotency_key, request_fingerprint, reason, actor_type, expires_at)
         VALUES ($1,$2,'portal',$3,$4,1,$5, CASE WHEN $5 = 'consumed' THEN now() ELSE NULL END,$6,$7,
                 'completion cascade fixture','system', now() + interval '30 days')
         RETURNING id`,
        [
          walletId,
          tenantId,
          partnerSubmissionId,
          `partner-submission-card:${cardIds[i]}:1`,
          reservationStatus,
          `cc-reserve-${n}-${i}`,
          "c".repeat(64),
        ]
      )
    ).rows[0].id;
    reservationIds.push(reservationId);

    const workItemId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_grading_work_items
           (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_submission_card_id,
            partner_handoff_id, connector_import_id, connector_record_id, validation_run_id,
            destination_submission_id, submission_item_id, card_ordinal, status, certificate_id, certificate_linked_at,
            front_image_key, back_image_key, source_fingerprint, source_fingerprint_version)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'approved',$11, now(),$12,$13,$14,1) RETURNING id`,
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
          certId,
          `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardIds[i]}/front-cc.jpg`,
          `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardIds[i]}/back-cc.jpg`,
          "a".repeat(64),
        ]
      )
    ).rows[0].id;
    workItemIds.push(workItemId);
  }

  return {
    tenantId,
    locationId,
    partnerSubmissionId,
    destinationSubmissionId,
    certNumbers,
    certIds,
    workItemIds,
    reservationIds,
  };
}

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const r = await admin.query(sql, params);
  return Object.values(r.rows[0])[0] as T;
}

describe("Partner completion cascade — real markCompleted with migration 0045 applied", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-completion-cascade");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);
    await applyPrintLifecycle();

    // server/db.ts resolves its URL at MODULE LOAD, so the pin must precede the first import of
    // anything that reaches it. print-workflow imports server/db transitively.
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    printWorkflow = await import("../server/print-workflow");
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("T0: the 0045 bridge table exists, so the completion cascade is NOT skipped by its to_regclass guard", async () => {
    // Without this, every assertion below would pass against a cascade that never executed — which
    // is precisely how the completed_at defect survived the existing print-workflow suite.
    const rel = await scalar<string | null>("SELECT to_regclass('public.partner_grading_work_items')::text", []);
    expect(rel).toBe("partner_grading_work_items");
    const printEvents = await scalar<string | null>("SELECT to_regclass('public.print_events')::text", []);
    expect(printEvents).toBe("print_events");
  });

  it("T1: partner_submissions has NO completed_at column — the schema fact the defect contradicted", async () => {
    const n = await scalar<string>(
      `SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema='public' AND table_name='partner_submissions' AND column_name='completed_at'`,
      []
    );
    expect(
      Number(n),
      "0007 creates partner_submissions without completed_at; 0044 adds only location_name_snapshot"
    ).toBe(0);
    // Positive control: the read path works and the table really is present with its real columns.
    const present = await scalar<string>(
      `SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema='public' AND table_name='partner_submissions' AND column_name IN ('status','updated_at','cancelled_at','submitted_at')`,
      []
    );
    expect(Number(present)).toBe(4);
  });

  it("T2: MUTATION TARGET — the full four-level cascade completes for a two-card Partner submission", async () => {
    const f = await seedCompletionReadyPilot();

    // Preconditions, asserted so no assertion below can pass vacuously.
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>("SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='printed'", [
        f.destinationSubmissionId,
      ])
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='consumed'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId])).toBe(
      "submitted_to_mintvault"
    );

    // THE REAL PRODUCTION CALL. Before the fix this threw 42703 and rolled everything back.
    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });

    expect(result.rejected, `markCompleted rejected: ${JSON.stringify(result.rejected)}`).toEqual([]);
    expect(result.applied.sort()).toEqual([...f.certNumbers].sort());

    // Level 0 — certificates
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='completed'",
        [f.destinationSubmissionId]
      )
    ).toBe("2");

    // print_events is the authoritative audit trail, with the real actor.
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM print_events WHERE cert_id = ANY($1::text[]) AND action='complete' AND actor=$2 AND from_state='printed' AND to_state='completed'",
        [f.certNumbers, ACTOR.actor]
      )
    ).toBe("2");

    // Level 1 — work items
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='completed'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");

    // Level 2 — the Partner submission. This is the level the defect aborted.
    expect(await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId])).toBe(
      "completed"
    );

    // Level 3 — the destination submission walks ready_to_return -> shipped -> completed.
    expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId])).toBe(
      "completed"
    );
  });

  it("T3: replaying markCompleted is idempotent — no duplicate print_events, no second cascade", async () => {
    const f = await seedCompletionReadyPilot();
    await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });

    const eventsAfterFirst = await scalar<string>(
      "SELECT count(*)::text FROM print_events WHERE cert_id = ANY($1::text[]) AND action='complete'",
      [f.certNumbers]
    );
    expect(eventsAfterFirst).toBe("2");

    const replay = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(replay.applied).toEqual([]);
    expect(replay.rejected.map((r) => r.code)).toEqual(["already_completed", "already_completed"]);

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM print_events WHERE cert_id = ANY($1::text[]) AND action='complete'",
        [f.certNumbers]
      )
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='completed'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
  });

  it("T4: an UNCONSUMED reservation blocks Partner-submission completion — the second NOT EXISTS guard", async () => {
    // The cards still complete; the SUBMISSION must not, because a live reservation means the money
    // has not settled. This is the guard that makes settlement-before-completion structural.
    const f = await seedCompletionReadyPilot({ reservationStatus: "active" });

    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(result.rejected).toEqual([]);
    expect(result.applied.sort()).toEqual([...f.certNumbers].sort());

    // Work items DO complete...
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='completed'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    // ...but the Partner submission does NOT.
    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "an active reservation must keep the Partner submission out of 'completed'"
    ).toBe("submitted_to_mintvault");
    // And neither does the destination submission.
    expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId])).toBe(
      "ready_to_return"
    );
  });

  it("T5: a PARTIAL certificate selection is refused before anything is written", async () => {
    const f = await seedCompletionReadyPilot();

    const result = await printWorkflow.markCompleted({ certIds: [f.certNumbers[0]], identity: ACTOR });

    expect(result.applied).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected.map((r) => r.code)).toContain("partner_submission_incomplete");

    // Nothing moved: not the selected certificate, not the work items, not the submission.
    expect(
      await scalar<string>("SELECT count(*)::text FROM certificates WHERE submission_id=$1 AND print_state='printed'", [
        f.destinationSubmissionId,
      ])
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId])).toBe(
      "submitted_to_mintvault"
    );
    expect(
      await scalar<string>("SELECT count(*)::text FROM print_events WHERE cert_id=$1 AND action='complete'", [
        f.certNumbers[0],
      ])
    ).toBe("0");
  });

  it("T6: a work item not yet approved blocks its own completion and the submission's", async () => {
    const f = await seedCompletionReadyPilot();
    // Card two is still with the reviewer. The cascade's level-1 predicate is `pgwi.status='approved'`.
    await admin.query("UPDATE partner_grading_work_items SET status='pending_review' WHERE id=$1", [f.workItemIds[1]]);

    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(result.applied.sort()).toEqual([...f.certNumbers].sort());

    expect(
      await scalar<string>("SELECT status FROM partner_grading_work_items WHERE id=$1", [f.workItemIds[0]]),
      "card one was approved, so its work item completes"
    ).toBe("completed");
    expect(
      await scalar<string>("SELECT status FROM partner_grading_work_items WHERE id=$1", [f.workItemIds[1]]),
      "card two was never approved, so it must NOT complete"
    ).toBe("pending_review");
    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "one outstanding work item must keep the submission incomplete"
    ).toBe("submitted_to_mintvault");
  });

  /**
   * T7 — `partner_settlement_required`.
   *
   * MUTATION TARGET (PR #288 mutation matrix, PRINT2). Widening the batch-phase destination-status
   * allow-list to admit `in_grading` / `received` SURVIVED the whole suite: 73/73 green. Searching
   * `tests/` for the rejection code returned nothing — only `partner_submission_incomplete` had a
   * test. This is the gate that stops labels being rendered for a Partner submission whose credits
   * have not settled, i.e. printing work the partner has not paid for.
   */
  it("T7: labels cannot be BATCHED for a Partner submission whose credits have not settled", async () => {
    const f = await seedCompletionReadyPilot({ destinationStatus: "in_grading" });

    const rejected = await printWorkflow.requireCompletePartnerSubmissionSet(f.certNumbers, "batch");
    expect(
      rejected.map((r) => r.code).sort(),
      "every certificate in an unsettled Partner submission must be refused at the batch phase"
    ).toEqual(["partner_settlement_required", "partner_settlement_required"]);
    expect(rejected.map((r) => r.certId).sort()).toEqual([...f.certNumbers].sort());

    // PHASE-SPECIFIC, and deliberately so: completion runs AFTER settlement, so the same set must
    // not be refused there for this reason. Without this half, widening the gate to every phase
    // would still pass.
    const atComplete = await printWorkflow.requireCompletePartnerSubmissionSet(f.certNumbers, "complete");
    expect(atComplete.map((r) => r.code)).not.toContain("partner_settlement_required");

    // POSITIVE CONTROL: the identical selection on a SETTLED destination is accepted, so the
    // assertion above cannot be passing because the gate refuses everything.
    const settled = await seedCompletionReadyPilot();
    expect(
      await printWorkflow.requireCompletePartnerSubmissionSet(settled.certNumbers, "batch"),
      "a settled Partner submission must batch cleanly"
    ).toEqual([]);
  });

  /**
   * T8 — `cross_tenant_partner_batch`.
   *
   * MUTATION TARGET (PR #288 mutation matrix, CERT2). Changing the guard from `size > 1` to
   * `size > 99` SURVIVED: 45/45 green, and the code appeared nowhere in `tests/`. Two partners'
   * cards on one print sheet is a physical mis-shipment risk, not a cosmetic one.
   */
  it("T8: two tenants' certificates cannot be printed in one batch", async () => {
    const one = await seedCompletionReadyPilot();
    const two = await seedCompletionReadyPilot();
    expect(one.tenantId, "the two fixtures must be genuinely different tenants").not.toBe(two.tenantId);

    const mixed = [...one.certNumbers, ...two.certNumbers];
    const rejected = await printWorkflow.requireCompletePartnerSubmissionSet(mixed, "batch");
    const codes = rejected.map((r) => r.code);
    expect(codes, "a mixed-tenant batch must be refused").toContain("cross_tenant_partner_batch");
    expect(
      rejected.filter((r) => r.code === "cross_tenant_partner_batch").map((r) => r.certId).sort(),
      "the refusal must cover EVERY certificate in the batch, not just the intruders"
    ).toEqual([...mixed].sort());

    // POSITIVE CONTROL: each tenant's own complete set alone is accepted.
    for (const f of [one, two]) {
      expect(
        await printWorkflow.requireCompletePartnerSubmissionSet(f.certNumbers, "batch"),
        "a single-tenant complete set must not trip the cross-tenant guard"
      ).toEqual([]);
    }
  });
});
