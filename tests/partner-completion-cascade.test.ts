/**
 * Partner completion cascade — REAL production `markCompleted` against a disposable PostgreSQL 17
 * with migration 0049 applied.
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
 * (certificate -> work item -> partner submission -> destination submission), apply 0049 so the
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
  // The composite FK targets 0049 needs on the MintVault side.
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
 * CANONICAL SETTLEMENT EVIDENCE, written exactly as production writes it.
 *
 * `transitionReservationInTransaction()` (server/partner/partner-credit-reservation-service.ts)
 * writes a consume as TWO rows, not one status flip:
 *   - `partner_credit_ledger`: amount -1, `idempotency_key = 'reservation-consume:<id>'`,
 *     `correlation_id = <id>`; and
 *   - `partner_credit_reservation_events`: `event_type='consumed'` carrying that ledger row's id
 *     (0017's `chk_partner_credit_reservation_events_ledger_link` makes the link mandatory).
 * Releases and expiries write the event ONLY — a release never debits the wallet, which is the
 * whole reason a released reservation can never be mistaken for payment.
 *
 * The fixture previously wrote a bare `status='consumed'` reservation with NEITHER row, so it
 * asserted completion against a submission that had no debit anywhere in the ledger. That is
 * exactly the shape finding H3's repaired gate must refuse, so the fixture is corrected here
 * rather than the gate weakened to accommodate it.
 */
async function writeTerminalEvidence(params: {
  walletId: string;
  tenantId: string;
  reservationId: string;
  eventType: "consumed" | "released" | "expired";
  key: string;
  /**
   * `malformed` writes the consume event with a debit that is NOT the one
   * `transitionReservationInTransaction()` writes — same wallet, same amount, same correlation, but
   * a hand-made idempotency key. It is what a manual "let me just fix the balance" SQL adjustment
   * looks like, and it must NOT be accepted as settlement evidence.
   */
  ledger?: "canonical" | "malformed";
}): Promise<void> {
  const { walletId, tenantId, reservationId, eventType, key } = params;
  const ledgerShape = params.ledger ?? "canonical";
  let ledgerEntryId: string | null = null;
  if (eventType === "consumed") {
    // 0017's chk_..._ledger_link makes the link MANDATORY for a consume event, so a malformed case
    // still has to point at some ledger row — it just must not be the canonical debit.
    ledgerEntryId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_credit_ledger
           (wallet_id, tenant_id, amount, entry_type, idempotency_key, correlation_id, source, reason,
            actor_type, request_fingerprint)
         VALUES ($1,$2,-1,'admin_adjustment',$3,$4,'system','MintVault grading completed for Partner submission card.',
                 'admin',$5)
         RETURNING id`,
        [
          walletId,
          tenantId,
          ledgerShape === "canonical"
            ? `reservation-consume:${reservationId}`
            : `manual-balance-fix:${reservationId}`,
          reservationId,
          "d".repeat(64),
        ]
      )
    ).rows[0].id;
  }
  await admin.query(
    `INSERT INTO partner_credit_reservation_events
       (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key, request_fingerprint,
        source, reason, actor_type, ledger_entry_id)
     VALUES ($1,$2,$3,$4,1,$5,$6,'system','completion cascade fixture','system',$7::uuid)`,
    [reservationId, walletId, tenantId, eventType, key, "e".repeat(64), ledgerEntryId]
  );
}

/**
 * Build the exact shape production leaves behind at the moment before completion: two approved
 * certificates in `printed`, two approved work items, and two CONSUMED reservations each carrying
 * canonical debit evidence. Every row is the real table with the real constraints — 0049's
 * composite FKs reject any shortcut here.
 */
async function seedCompletionReadyPilot(opts?: {
  reservationStatus?: string;
  /**
   * FINDING H3 KNOBS.
   *
   * `evidence` controls whether a `consumed` reservation carries its canonical consumed event +
   * -1 ledger debit. `"none"` is the money-missing shape: the reservation SAYS consumed but no
   * debit exists anywhere. `"partial"` gives card one its evidence and leaves card two bare.
   *
   * `recovery` reproduces the authorised Super Admin recovery: each card's ORIGINAL reservation is
   * released (terminal, settled by cancellation) and linked by a released
   * `partner_submission_credit_holds` row to a REPLACEMENT reservation that was subsequently
   * consumed with full evidence. This is the shape the old `status <> 'consumed'` predicate
   * stranded forever.
   */
  evidence?: "canonical" | "none" | "partial" | "malformed";
  recovery?: boolean;
  /**
   * The DESTINATION submission's status. Default `ready_to_return` is the settled state. T7 needs
   * an UNsettled destination, which is the only way to exercise the batch-phase settlement gate.
   */
  destinationStatus?: string;
}): Promise<PilotFixture> {
  const n = ++sequence;
  const reservationStatus = opts?.reservationStatus ?? "consumed";
  const destinationStatus = opts?.destinationStatus ?? "ready_to_return";
  const evidence = opts?.evidence ?? "canonical";
  const recovery = opts?.recovery ?? false;
  /** 0017's chk_..._terminal_times pairs each status with exactly one timestamp column. */
  const terminalColumn = (status: string): string =>
    status === "consumed"
      ? "consumed_at"
      : status === "released"
        ? "released_at"
        : status === "expired"
          ? "expired_at"
          : "";

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

    const cardReference = `partner-submission-card:${cardIds[i]}:1`;
    const insertReservation = async (status: string, key: string): Promise<string> => {
      const col = terminalColumn(status);
      return (
        await admin.query<{ id: string }>(
          `INSERT INTO partner_credit_reservations
             (wallet_id, tenant_id, source, submission_reference, card_reference, reserved_credits,
              status,${col ? ` ${col},` : ""} idempotency_key, request_fingerprint, reason, actor_type, expires_at)
           VALUES ($1,$2,'portal',$3,$4,1,$5,${col ? " now()," : ""} $6,$7,
                   'completion cascade fixture','system', now() + interval '30 days')
           RETURNING id`,
          [walletId, tenantId, partnerSubmissionId, cardReference, status, key, "c".repeat(64)]
        )
      ).rows[0].id;
    };

    /**
     * RECOVERY SHAPE. The authorised Super Admin path releases the ORIGINAL reservation and issues a
     * REPLACEMENT for the same card, linked by a RELEASED `partner_submission_credit_holds` row. Both
     * rows keep the same `submission_reference`, which is exactly why the old
     * `r.status <> 'consumed'` predicate stranded every recovered submission forever.
     * `uq_partner_credit_reserve_card_live` permits the shared `card_reference` because the
     * predecessor is no longer live.
     */
    let reservationId: string;
    if (recovery) {
      const predecessorId = await insertReservation("released", `cc-reserve-${n}-${i}`);
      await writeTerminalEvidence({
        walletId,
        tenantId,
        reservationId: predecessorId,
        eventType: "released",
        key: `cc-ev-rel-${n}-${i}`,
      });
      reservationId = await insertReservation("consumed", `cc-recover-${n}-${i}`);
      await writeTerminalEvidence({
        walletId,
        tenantId,
        reservationId,
        eventType: "consumed",
        key: `cc-ev-con-${n}-${i}`,
      });
      await admin.query(
        `INSERT INTO partner_submission_credit_holds
           (tenant_id, partner_submission_id, destination_submission_id, reservation_id,
            connector_record_id, connector_import_id, reason_code, released_at,
            recovery_reservation_id, recovery_idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,'reservation_not_consumable', now(), $7, $8)`,
        [
          tenantId,
          partnerSubmissionId,
          destinationSubmissionId,
          predecessorId,
          connectorId,
          importId,
          reservationId,
          `cc-recovery-${n}-${i}`,
        ]
      );
      reservationIds.push(predecessorId);
    } else {
      reservationId = await insertReservation(reservationStatus, `cc-reserve-${n}-${i}`);
      if (reservationStatus === "consumed") {
        // `partial` gives card ONE its debit and leaves card TWO bare — one unpaid card in an
        // otherwise-settled set must still refuse the whole submission.
        const wantsCanonical = evidence === "canonical" || (evidence === "partial" && i === 0);
        if (wantsCanonical || evidence === "malformed") {
          await writeTerminalEvidence({
            walletId,
            tenantId,
            reservationId,
            eventType: "consumed",
            key: `cc-ev-con-${n}-${i}`,
            ledger: wantsCanonical ? "canonical" : "malformed",
          });
        }
      } else if (reservationStatus === "released" || reservationStatus === "expired") {
        // Canonical for these two: the terminal event exists, and NO ledger debit does — a release
        // never debits the wallet (0017's accounting-model note).
        await writeTerminalEvidence({
          walletId,
          tenantId,
          reservationId,
          eventType: reservationStatus,
          key: `cc-ev-term-${n}-${i}`,
        });
      }
      // `active` reservations have only their `reserved` event in production; the gate never looks
      // at it, so the fixture leaves the event log empty for that case.
    }
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

describe("Partner completion cascade — real markCompleted with migration 0049 applied", () => {
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

  it("T0: the 0049 bridge table exists, so the completion cascade is NOT skipped by its to_regclass guard", async () => {
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

  /**
   * ============================================================================================
   * FINDING H3 — the completion money gate.
   * ============================================================================================
   *
   * T9-T14 pin `partnerGradedUnitsFullySettled` in server/print-workflow.ts. The old predicate was
   * `NOT EXISTS (… r.status <> 'consumed')`, three copies. Both hostile reviewers proposed narrowing
   * it to `r.status = 'active'`; the issue register recorded that as NOT obviously safe. These six
   * cases hold both directions at once:
   *
   *   MUTATION COMPLETE-FREE1 — replace the gate with `NOT EXISTS (… r.status = 'active')`.
   *   T9 and T10 turn RED (free grading), while every other case stays green. That is the proof the
   *   one-word fix would have shipped a hole, and the reason the repair counts POSITIVE per-unit
   *   financial evidence instead of reading reservation status.
   *
   *   MUTATION COMPLETE-STRAND1 — restore `r.status <> 'consumed'`.
   *   T11 turns RED: the authorised recovery shape can never complete, which is finding H3 itself.
   */

  it("T9: COMPLETE-FREE1 — a fully CANCELLED submission must not complete for zero consumed credits", async () => {
    // Every reservation is `released`: terminal, settled, and the credit went BACK to the partner.
    // `r.status = 'active'` is satisfied by nothing here, so the one-word fix would open the gate
    // and grade, print and complete two cards that MintVault was never paid for.
    const f = await seedCompletionReadyPilot({ reservationStatus: "released" });

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='active'",
        [f.partnerSubmissionId]
      ),
      "the free-grading direction only exists when NO active reservation remains"
    ).toBe("0");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_ledger l JOIN partner_credit_reservations r ON l.correlation_id = r.id::text WHERE r.submission_reference=$1 AND l.amount=-1",
        [f.partnerSubmissionId]
      ),
      "a release never debits the wallet, so there is no money for these two cards anywhere"
    ).toBe("0");

    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(result.rejected).toEqual([]);
    expect(result.applied.sort()).toEqual([...f.certNumbers].sort());

    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "a cancelled submission with zero consumed credits must NOT reach 'completed'"
    ).toBe("submitted_to_mintvault");
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "and the destination must not be walked to completed either"
    ).toBe("ready_to_return");
  });

  it("T10: COMPLETE-FREE1 — EXPIRED reservations are terminal but unpaid, and must not complete", async () => {
    // The fourth 0017 status. Like `released` it is terminal and writes no debit, so `status =
    // 'active'` would wave it through exactly as it waves T9 through.
    const f = await seedCompletionReadyPilot({ reservationStatus: "expired" });

    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(result.applied.sort()).toEqual([...f.certNumbers].sort());

    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "an expired reservation is not payment"
    ).toBe("submitted_to_mintvault");
  });

  it("T11: COMPLETE-STRAND1 — an authorised credit recovery COMPLETES (the H3 defect itself)", async () => {
    // Each card: released predecessor + consumed replacement carrying the canonical debit, linked by
    // a released hold. The old `r.status <> 'consumed'` predicate saw the released predecessors and
    // refused forever, while cancelSubmission refused the same mixed state — no exit at all.
    const f = await seedCompletionReadyPilot({ recovery: true });

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='released'",
        [f.partnerSubmissionId]
      ),
      "the recovery shape must genuinely leave released predecessors behind, or T11 proves nothing"
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_submission_credit_holds WHERE partner_submission_id=$1 AND released_at IS NOT NULL AND recovery_reservation_id IS NOT NULL",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_ledger l JOIN partner_credit_reservations r ON l.idempotency_key = 'reservation-consume:' || r.id::text WHERE r.submission_reference=$1 AND l.amount=-1",
        [f.partnerSubmissionId]
      ),
      "two cards, two real debits — the partner DID pay for this grading"
    ).toBe("2");

    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(result.rejected).toEqual([]);

    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "a recovered, fully-paid submission must complete"
    ).toBe("completed");
    expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId])).toBe(
      "completed"
    );
  });

  it("T12: a reservation that merely SAYS consumed, with no debit anywhere, must not complete", async () => {
    const f = await seedCompletionReadyPilot({ evidence: "none" });

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservations WHERE submission_reference=$1 AND status='consumed'",
        [f.partnerSubmissionId]
      )
    ).toBe("2");
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_reservation_events e JOIN partner_credit_reservations r ON r.id=e.reservation_id WHERE r.submission_reference=$1",
        [f.partnerSubmissionId]
      ),
      "status alone: no consume event, and therefore no ledger link"
    ).toBe("0");

    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(result.applied.sort()).toEqual([...f.certNumbers].sort());
    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "a status flip with no money behind it is not settlement"
    ).toBe("submitted_to_mintvault");
  });

  it("T13: ONE unpaid card in an otherwise-settled set blocks the whole submission", async () => {
    const f = await seedCompletionReadyPilot({ evidence: "partial" });

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_ledger l JOIN partner_credit_reservations r ON l.idempotency_key = 'reservation-consume:' || r.id::text WHERE r.submission_reference=$1 AND l.amount=-1",
        [f.partnerSubmissionId]
      ),
      "exactly one of the two cards was really paid for"
    ).toBe("1");

    const result = await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });
    expect(result.applied.sort()).toEqual([...f.certNumbers].sort());
    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "1 debit for 2 graded units must refuse — the gate counts units, not submissions"
    ).toBe("submitted_to_mintvault");
  });

  it("T14: a hand-made ledger adjustment is not settlement evidence — and the canonical one is", async () => {
    // Same wallet, same -1, same correlation_id, WRONG idempotency key. This is what someone
    // patching a balance by hand produces, and it must not unlock completion.
    const bad = await seedCompletionReadyPilot({ evidence: "malformed" });
    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_credit_ledger l JOIN partner_credit_reservations r ON l.correlation_id = r.id::text WHERE r.submission_reference=$1 AND l.amount=-1",
        [bad.partnerSubmissionId]
      ),
      "the malformed debit really exists — only its idempotency key differs"
    ).toBe("2");

    await printWorkflow.markCompleted({ certIds: bad.certNumbers, identity: ACTOR });
    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [bad.partnerSubmissionId]),
      "only the debit transitionReservationInTransaction() writes counts as payment"
    ).toBe("submitted_to_mintvault");

    // POSITIVE CONTROL: the identical fixture with the canonical key completes, so T14 cannot be
    // passing because the gate refuses everything.
    const good = await seedCompletionReadyPilot();
    await printWorkflow.markCompleted({ certIds: good.certNumbers, identity: ACTOR });
    expect(await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [good.partnerSubmissionId])).toBe(
      "completed"
    );
  });
  /**
   * ============================================================================================
   * FINDING F2 — the single-certificate label render bypassed the settlement gate entirely.
   * ============================================================================================
   *
   * `requireCompletePartnerSubmissionSet(..., "batch")` refuses to render labels for a Partner
   * submission whose credits have not settled (T7). But it only ever ran on the BATCH path. Two
   * admin routes rendered the identical artefact with no partner lookup at all:
   *
   *   GET /api/admin/certificates/:id/label/:side
   *   GET /api/admin/certificates/label/:certId/:filename
   *
   * Both are `requireAdmin` and both called generateLabelPNG/generateLabelPDF directly, so an
   * admin could produce a print-ready label for a Partner card MintVault had not been paid for.
   * `partnerSettlementBlockForCert` is the shared gate that closes it.
   */
  it("T15: F2 — an UNSETTLED Partner card cannot be label-rendered through the single-certificate path", async () => {
    const unsettled = await seedCompletionReadyPilot({ destinationStatus: "in_grading" });

    for (const certNumber of unsettled.certNumbers) {
      const block = await printWorkflow.partnerSettlementBlockForCert(certNumber);
      expect(block, `an unsettled Partner card must be refused: ${certNumber}`).not.toBeNull();
      expect(block?.code).toBe("partner_settlement_required");
      expect(block?.destinationStatus).toBe("in_grading");
    }

    // POSITIVE CONTROL — a SETTLED Partner card still renders, so the gate is not refusing
    // everything. Without this half, hard-coding a refusal would pass.
    const settled = await seedCompletionReadyPilot();
    for (const certNumber of settled.certNumbers) {
      expect(
        await printWorkflow.partnerSettlementBlockForCert(certNumber),
        `a settled Partner card must still render: ${certNumber}`
      ).toBeNull();
    }

    // An HQ card — no partner work item — is never touched by the gate.
    expect(await printWorkflow.partnerSettlementBlockForCert("MV-0009999999")).toBeNull();
  });

  it("T16: F2 — BOTH bypass routes actually call the gate before rendering", async () => {
    /**
     * T15 proves the gate. This proves it is WIRED. The two routes live in server/routes.ts and
     * booting the whole Express app inside this cluster-owning suite would prove less for far more
     * moving parts, so the wiring is pinned at the source: each handler must reach
     * partnerSettlementBlockForCert BEFORE it reaches generateLabelPNG/generateLabelPDF.
     */
    const source = readFileSync(join(process.cwd(), "server", "routes.ts"), "utf8");
    const handlers = [
      '/api/admin/certificates/:id/label/:side',
      '/api/admin/certificates/label/:certId/:filename',
    ];
    for (const path of handlers) {
      // Anchor on the REGISTRATION, not the bare path: the path string also appears in a route
      // inventory earlier in the file, and anchoring there would slice the wrong handler body.
      const start = source.indexOf(`app.get("${path}"`);
      expect(start, `route ${path} not found in server/routes.ts`).toBeGreaterThan(-1);
      // The handler body up to the next route registration.
      const rest = source.slice(start);
      const end = rest.indexOf('\n  app.', 1);
      const body = end === -1 ? rest : rest.slice(0, end);
      const gate = body.indexOf('partnerSettlementBlockForCert');
      const render = Math.min(
        ...['generateLabelPNG', 'generateLabelPDF'].map((f) => {
          const i = body.indexOf(f);
          return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        })
      );
      expect(gate, `${path} does not call partnerSettlementBlockForCert`).toBeGreaterThan(-1);
      expect(render, `${path} no longer renders a label — this pin is stale`).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(gate, `${path} renders the label BEFORE consulting the settlement gate`).toBeLessThan(render);
    }
  });

  /**
   * ============================================================================================
   * FINDING F3 — the completion predicate was vacuously true at zero graded units.
   * ============================================================================================
   *
   * `partnerGradedUnitsFullySettled` gates completion on
   * `count(non-void work items) = count(reservations with canonical consumed evidence)`. At ZERO
   * non-void work items both sides are 0, the equality holds, and the gate OPENS — cascading the
   * Partner submission and its destination to `completed` for ZERO consumed credits.
   *
   * Nothing writes `void` today (it exists only in 0049's CHECK constraint and in read-side
   * `<> 'void'` predicates), so the shape is currently unreachable. It goes live the day a
   * void/withdraw path is added — which is exactly the change least likely to re-derive this
   * gate's arithmetic. This test is the pin that makes that day safe.
   */
  it("T17: F3 — ZERO non-void graded units is NOT 'fully settled', and must not complete", async () => {
    // `evidence: "none"` means the reservations SAY consumed but carry no debit anywhere, so the
    // consumed side of the equality is 0 too. Voiding every work item makes the unit side 0 as
    // well: 0 = 0, which is precisely the vacuous shape.
    const f = await seedCompletionReadyPilot({ evidence: "none" });
    await admin.query("UPDATE partner_grading_work_items SET status='void' WHERE partner_submission_id=$1", [
      f.partnerSubmissionId,
    ]);

    expect(
      await scalar<string>(
        "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status <> 'void'",
        [f.partnerSubmissionId]
      ),
      "precondition: zero live graded units"
    ).toBe("0");
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount = -1", [
        f.tenantId,
      ]),
      "precondition: zero debits — nothing was ever paid for"
    ).toBe("0");
    expect(await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId])).toBe(
      "submitted_to_mintvault"
    );

    await printWorkflow.markCompleted({ certIds: f.certNumbers, identity: ACTOR });

    expect(
      await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [f.partnerSubmissionId]),
      "zero graded units must never read as fully settled"
    ).not.toBe("completed");
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "and the destination must not cascade past settlement either"
    ).toBe("ready_to_return");
    expect(
      await scalar<string>("SELECT count(*)::text FROM partner_credit_ledger WHERE tenant_id=$1 AND amount = -1", [
        f.tenantId,
      ]),
      "and no money may have appeared"
    ).toBe("0");

    // POSITIVE CONTROL: the same call on a genuinely settled, genuinely graded set still completes,
    // so the hardening cannot be passing by refusing everything (that would be weakening H3's gate
    // in the other direction).
    const good = await seedCompletionReadyPilot();
    await printWorkflow.markCompleted({ certIds: good.certNumbers, identity: ACTOR });
    expect(await scalar<string>("SELECT status FROM partner_submissions WHERE id=$1", [good.partnerSubmissionId])).toBe(
      "completed"
    );
    expect(await scalar<string>("SELECT status FROM submissions WHERE id=$1", [good.destinationSubmissionId])).toBe(
      "completed"
    );
  });
});
