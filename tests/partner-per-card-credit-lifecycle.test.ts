/**
 * PER-CARD CREDIT LIFECYCLE — real PostgreSQL, real submission workflow.
 *
 * Partner grading credits are sold and consumed PER CARD (owner directive, 2026-08-03):
 * 1 card = 1 credit, so a 20-card submission reserves 20 credits. The defect this suite exists to
 * pin was that acceptance reserved exactly ONE credit per SUBMISSION using the synthetic reference
 * `partner-submission:{id}`, while connector-import priced the same submission at
 * `pricePerCardPence * cardCount` — the partner was invoiced for N cards and debited 1 credit.
 *
 * Every test here drives the REAL service entry points (createSubmissionDraft / addCard /
 * submitSubmission / cancelSubmission / settlePartnerCreditForDestinationStatus) against a real
 * cluster with real wallet, ledger and reservation rows. Nothing is mocked.
 *
 * The whole file is a mutation target: CARD1-CARD6 and LEDGER1-LEDGER2 must turn it red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  migratorUrlFrom,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let creditReservations: typeof import("../server/partner/partner-credit-reservation-service");
let submissions: typeof import("../server/partner/submission-service");
let lifecycle: typeof import("../server/partner/partner-submission-credit-lifecycle");
let sequence = 0;

const adminActor = { actorUserId: null, actorEmail: "percard-admin@example.com" };

interface TenantFixture {
  tenantId: string;
  locationId: string;
  userId: string;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  // Rich enough for updateDestinationStatus to write a real status transition — the previous
  // minimal stub lacked status_history and the timestamp columns, so settlement could not run.
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    grading_status varchar(30), assigned_grader_id varchar, scan_status varchar(30),
    scan_assigned_to varchar, shipped_at timestamptz, delivered_at timestamptz,
    completed_at timestamptz, return_tracking text, return_carrier text, return_service text,
    return_postage_cost numeric, on_receipt_photo_urls jsonb,
    status_history jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function createTenantFixture(label: string): Promise<TenantFixture> {
  const ordinal = ++sequence;
  const tenantId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name,status) VALUES ($1,'ACTIVE') RETURNING id",
      [`PerCard ${label} ${ordinal}`]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
      [tenantId, `PerCard ${label} HQ`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref,tenant_id,partner_id,email,password_hash,status,mfa_required)
       VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
      [`percard-${ordinal}`, tenantId, `percard-${ordinal}@example.test`]
    )
  ).rows[0].id;
  return { tenantId, locationId, userId };
}

function principalFor(f: TenantFixture) {
  return {
    sessionId: `percard-${f.tenantId}`,
    tenantId: f.tenantId,
    userId: f.userId,
    locationId: f.locationId,
    mfaPassed: true,
    permissions: new Set(["partner.orders.create", "partner.orders.cancel"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: true,
  };
}

async function addCredits(f: TenantFixture, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, f.tenantId);
  if (amount > 0) {
    await wallet.appendFoundationCredit(adminActor, {
      tenantId: f.tenantId,
      amount,
      entryType: "purchase",
      source: "admin",
      reason: "per-card test credits",
      idempotencyKey: key,
      actorType: "admin",
    });
  }
}

/** Create a draft with the given card rows, each `[name, quantity]`. */
async function makeDraft(f: TenantFixture, cards: Array<[string, number]>): Promise<string> {
  const id = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
       VALUES ($1,$2,$3,$4,'draft') RETURNING id`,
      [f.tenantId, f.locationId, f.userId, cards.length]
    )
  ).rows[0].id;
  let seq = 0;
  for (const [name, quantity] of cards) {
    await admin.query(
      `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name,quantity)
       VALUES ($1,$2,$3,$4,$5)`,
      [f.tenantId, id, ++seq, name, quantity]
    );
  }
  return id;
}

function nCards(n: number, prefix = "card"): Array<[string, number]> {
  return Array.from({ length: n }, (_, i) => [`${prefix}-${i + 1}`, 1] as [string, number]);
}

async function reservationsFor(f: TenantFixture, submissionId: string) {
  const r = await admin.query<{ id: string; status: string; card_reference: string; reserved_credits: number }>(
    `SELECT id, status, card_reference, reserved_credits
       FROM partner_credit_reservations
      WHERE tenant_id=$1 AND source='portal' AND submission_reference=$2
      ORDER BY created_at, id`,
    [f.tenantId, submissionId]
  );
  return r.rows;
}

async function ledgerTotal(f: TenantFixture): Promise<number> {
  const r = await admin.query<{ total: string }>(
    "SELECT COALESCE(SUM(amount),0)::text AS total FROM partner_credit_ledger WHERE tenant_id=$1",
    [f.tenantId]
  );
  return Number(r.rows[0].total);
}

async function mapImportedSubmission(f: TenantFixture, partnerSubmissionId: string): Promise<number> {
  const handoff = await admin.query<{ id: string }>(
    "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
    [partnerSubmissionId]
  );
  const connector = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state,attempt_count)
     VALUES ($1,$2,$3,'imported',1) RETURNING id`,
    [f.tenantId, partnerSubmissionId, handoff.rows[0].id]
  );
  const validation = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_validation_runs
       (connector_record_id,validation_attempt,source_submission_version,source_handoff_status,
        source_fingerprint,source_fingerprint_version,outcome,blocking_error_count,warning_count,completed_at)
     VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
    [connector.rows[0].id, "a".repeat(64)]
  );
  const destination = await admin.query<{ id: number }>(
    `INSERT INTO submissions (user_id,tracking_number,status) VALUES ('percard-customer',$1,'in_grading') RETURNING id`,
    [`MV-PC-${++sequence}`]
  );
  await admin.query(
    `INSERT INTO partner_connector_imports
       (connector_record_id,partner_organisation_id,partner_location_id,partner_submission_id,partner_handoff_id,
        validation_run_id,source_fingerprint,source_fingerprint_version,mapping_version,import_attempt,
        state,destination_submission_id,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'completed',$8,now())`,
    [
      connector.rows[0].id,
      f.tenantId,
      f.locationId,
      partnerSubmissionId,
      handoff.rows[0].id,
      validation.rows[0].id,
      "a".repeat(64),
      destination.rows[0].id,
    ]
  );
  return destination.rows[0].id;
}

async function mapTerminalConnector(f: TenantFixture, partnerSubmissionId: string, state = "ready_for_import"): Promise<string> {
  const handoff = await admin.query<{ id: string }>(
    "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
    [partnerSubmissionId]
  );
  const connector = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state,attempt_count)
     VALUES ($1,$2,$3,$4,1) RETURNING id`,
    [f.tenantId, partnerSubmissionId, handoff.rows[0].id, state]
  );
  return connector.rows[0].id;
}

async function callConnectorRelease(
  f: TenantFixture,
  connectorId: string,
  partnerSubmissionId: string,
  tenantOverride = f.tenantId
) {
  const runtimeUrl = new URL(cluster.url);
  runtimeUrl.username = "partner_0042_release_test";
  runtimeUrl.password = "synthetic";
  const runtime = new Client({ connectionString: runtimeUrl.toString() });
  await runtime.connect();
  try {
    await runtime.query("SELECT set_config('app.tenant_id', $1, false)", [f.tenantId]);
    const result = await runtime.query<{ outcome: string; reservation_id: string | null }>(
      `SELECT outcome, reservation_id
         FROM partner_connector_release_submission_credit($1::uuid,$2::uuid,$3::uuid,$4::text)`,
      [connectorId, tenantOverride, partnerSubmissionId, "connector_cancelled"]
    );
    return result.rows[0];
  } finally {
    await runtime.end();
  }
}

describe("Per-card credit lifecycle (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-per-card-credit-lifecycle");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);
    await admin.query(`DO $$ BEGIN
        CREATE ROLE partner_0042_release_test LOGIN PASSWORD 'synthetic' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query("GRANT partner_connector_runtime TO partner_0042_release_test");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    wallet = await import("../server/partner/partner-wallet-service");
    creditReservations = await import("../server/partner/partner-credit-reservation-service");
    submissions = await import("../server/partner/submission-service");
    lifecycle = await import("../server/partner/partner-submission-credit-lifecycle");
    await admin.query(
      "INSERT INTO partner_feature_flags (flag,tenant_id,location_id,enabled) VALUES ('partner_connector_enabled',NULL,NULL,true),('partner_emergency_stop',NULL,NULL,false),('partner_submission_intake_enabled',NULL,NULL,true)"
    );
  }, 120_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // ---------------------------------------------------------------- A. Draft creation

  it("A: a draft creates NO reservation and NO ledger movement", async () => {
    const f = await createTenantFixture("draft");
    await addCredits(f, 5, "pc-draft-credits");
    const before = await ledgerTotal(f);
    const draft = await makeDraft(f, nCards(3));
    expect(await reservationsFor(f, draft)).toHaveLength(0);
    expect(await ledgerTotal(f)).toBe(before);
  });

  // ---------------------------------------------------------------- B. Acceptance

  it.each([
    [1, 1],
    [2, 2],
    [20, 20],
  ])("B: a %i-card submission reserves exactly %i credits", async (cards, expected) => {
    const f = await createTenantFixture(`accept-${cards}`);
    await addCredits(f, 30, `pc-accept-${cards}`);
    const draft = await makeDraft(f, nCards(cards, `c${cards}`));
    await submissions.submitSubmission(principalFor(f), draft, `pc-submit-${cards}`);

    const rows = await reservationsFor(f, draft);
    expect(rows).toHaveLength(expected);
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect(rows.every((r) => Number(r.reserved_credits) === 1)).toBe(true);

    // Deterministic and UNIQUE per card/ordinal — this is what makes
    // uq_partner_credit_reserve_card_live a real per-card guard.
    const refs = rows.map((r) => r.card_reference);
    expect(new Set(refs).size).toBe(expected);
    expect(refs.every((r) => /^partner-submission-card:[0-9a-f-]{36}:\d+$/.test(r))).toBe(true);

    const position = await creditReservations.getCreditPosition(f.tenantId);
    expect(position.activeReserved).toBe(expected);
    expect(position.availableBalance).toBe(30 - expected);
    expect(position.ledgerBalance).toBe(30);
  });

  it("B: a card row with quantity > 1 expands to that many credits", async () => {
    const f = await createTenantFixture("qty");
    await addCredits(f, 10, "pc-qty");
    // 1 row of quantity 3 + 1 row of quantity 2 = 5 card units.
    const draft = await makeDraft(f, [
      ["bulk-a", 3],
      ["bulk-b", 2],
    ]);
    await submissions.submitSubmission(principalFor(f), draft, "pc-qty-submit");
    const rows = await reservationsFor(f, draft);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.card_reference)).size).toBe(5);
  });

  it("B: insufficient balance rolls the WHOLE acceptance back — no partial reservations", async () => {
    const f = await createTenantFixture("insufficient");
    await addCredits(f, 3, "pc-insufficient");
    const draft = await makeDraft(f, nCards(5, "short"));
    await expect(submissions.submitSubmission(principalFor(f), draft, "pc-short")).rejects.toThrow();

    expect(await reservationsFor(f, draft)).toHaveLength(0);
    const position = await creditReservations.getCreditPosition(f.tenantId);
    expect(position.activeReserved).toBe(0);
    expect(position.availableBalance).toBe(3);
    const status = await admin.query<{ status: string }>("SELECT status FROM partner_submissions WHERE id=$1", [draft]);
    expect(status.rows[0].status).toBe("draft");
  });

  it("B: a duplicate submit with the same key is idempotent — no second set of reservations", async () => {
    const f = await createTenantFixture("dup");
    await addCredits(f, 10, "pc-dup");
    const draft = await makeDraft(f, nCards(4, "dup"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-dup-key");
    await submissions.submitSubmission(principalFor(f), draft, "pc-dup-key");
    expect(await reservationsFor(f, draft)).toHaveLength(4);
    expect((await creditReservations.getCreditPosition(f.tenantId)).activeReserved).toBe(4);
  });

  it("B: concurrent submits of the same draft produce exactly one reservation set", async () => {
    const f = await createTenantFixture("concurrent");
    await addCredits(f, 20, "pc-conc");
    const draft = await makeDraft(f, nCards(3, "conc"));
    const results = await Promise.allSettled([
      submissions.submitSubmission(principalFor(f), draft, "pc-conc-key"),
      submissions.submitSubmission(principalFor(f), draft, "pc-conc-key"),
      submissions.submitSubmission(principalFor(f), draft, "pc-conc-key"),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await reservationsFor(f, draft)).toHaveLength(3);
    expect((await creditReservations.getCreditPosition(f.tenantId)).activeReserved).toBe(3);
  });

  // ---------------------------------------------------------------- C. Settlement

  it.each([[1], [2], [20]])("C: settling a %i-card submission consumes every reservation", async (cards) => {
    const f = await createTenantFixture(`settle-${cards}`);
    await addCredits(f, 40, `pc-settle-credits-${cards}`);
    const draft = await makeDraft(f, nCards(cards, `s${cards}`));
    await submissions.submitSubmission(principalFor(f), draft, `pc-settle-${cards}`);
    const destinationId = await mapImportedSubmission(f, draft);

    const settled = await lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return", {
      creditActorEmail: "admin@example.test",
    });
    expect(settled).not.toBeNull();

    const rows = await reservationsFor(f, draft);
    expect(rows).toHaveLength(cards);
    expect(rows.every((r) => r.status === "consumed")).toBe(true);

    // LEDGER RECONCILIATION: exactly one -1 debit per card unit.
    const debits = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0",
      [f.tenantId]
    );
    expect(Number(debits.rows[0].n)).toBe(cards);
    expect(await ledgerTotal(f)).toBe(40 - cards);

    const position = await creditReservations.getCreditPosition(f.tenantId);
    expect(position.activeReserved).toBe(0);
    expect(position.availableBalance).toBe(40 - cards);
  });

  it("C: repeated settlement is idempotent — no second debit", async () => {
    const f = await createTenantFixture("settle-twice");
    await addCredits(f, 10, "pc-settle-twice");
    const draft = await makeDraft(f, nCards(3, "twice"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-twice");
    const destinationId = await mapImportedSubmission(f, draft);

    await lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return", {});
    const afterFirst = await ledgerTotal(f);
    await lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "completed", {});
    expect(await ledgerTotal(f)).toBe(afterFirst);
    expect(afterFirst).toBe(7);
    const rows = await reservationsFor(f, draft);
    expect(rows.filter((r) => r.status === "consumed")).toHaveLength(3);
  });

  it("C: a wrong card count fails settlement closed with NO partial ledger write", async () => {
    const f = await createTenantFixture("mismatch");
    await addCredits(f, 20, "pc-mismatch");
    const draft = await makeDraft(f, nCards(4, "mm"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-mismatch-submit");
    const destinationId = await mapImportedSubmission(f, draft);

    // Add a 5th card AFTER acceptance: credits (4) no longer reconcile to card units (5).
    await admin.query(
      `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name,quantity)
       VALUES ($1,$2,99,'sneaked-in',1)`,
      [f.tenantId, draft]
    );

    const before = await ledgerTotal(f);
    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return", {})
    ).rejects.toThrow();
    expect(await ledgerTotal(f)).toBe(before);
    expect((await reservationsFor(f, draft)).every((r) => r.status === "active")).toBe(true);
  });

  it("C: ATOMICITY — a write-time failure on card 17 rolls back cards 1-16", async () => {
    const f = await createTenantFixture("atomic");
    await addCredits(f, 40, "pc-atomic");
    const draft = await makeDraft(f, nCards(20, "atom"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-atomic-submit");
    const destinationId = await mapImportedSubmission(f, draft);
    const rows = await reservationsFor(f, draft);
    expect(rows).toHaveLength(20);

    /**
     * The failure must occur INSIDE the consume loop, AFTER earlier cards have written.
     *
     * An earlier version of this test released card 17 through the service. That created a
     * `released` row, which made findReservationsForPartnerSubmission throw at the
     * live/historical mixing guard BEFORE the count gate and BEFORE the consume loop ever ran —
     * so it proved a linkage guard, not atomicity, and stayed green with the savepoint deleted.
     * The tell was that it asserted 19 remaining active reservations rather than 20.
     *
     * Instead, pre-write a TERMINAL event for card 17 while leaving its reservation `active`.
     * The live set is still 20 and reconciles to 20 card units, so every earlier guard passes and
     * cards 1-16 consume normally. Card 17's own event INSERT then violates
     * uq_partner_credit_reservation_events_terminal (UNIQUE(reservation_id) WHERE event_type IN
     * ('consumed','released','expired'), migration 0017) — a genuine write-time constraint
     * failure mid-loop, which is exactly the condition the savepoint exists to contain.
     * The pre-written event is 'released' rather than 'consumed' because a consumed event
     * additionally requires a ledger link (chk_partner_credit_reservation_events_ledger_link);
     * both are terminal, so either blocks the loop's own event insert identically.
     */
    const walletId = (
      await admin.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [f.tenantId])
    ).rows[0].id;
    await admin.query(
      `INSERT INTO partner_credit_reservation_events
         (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
          request_fingerprint, source, reason, actor_type)
       VALUES ($1,$2,$3,'released',1,$4,$5,'system','pre-existing terminal event','system')`,
      [rows[16].id, walletId, f.tenantId, `pre-terminal:${rows[16].id}`, "c".repeat(64)]
    );

    const before = await ledgerTotal(f);
    const statusBefore = (
      await admin.query<{ status: string }>("SELECT status FROM submissions WHERE id=$1", [destinationId])
    ).rows[0].status;

    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return", {})
    ).rejects.toThrow();

    // ALL TWENTY remain unconsumed — cards 1-16 must not survive as consumed.
    const after = await reservationsFor(f, draft);
    expect(after).toHaveLength(20);
    expect(after.filter((r) => r.status === "active")).toHaveLength(20);
    expect(after.filter((r) => r.status === "consumed")).toHaveLength(0);

    // Zero consume ledger rows committed.
    expect(await ledgerTotal(f)).toBe(before);
    const debits = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_credit_ledger WHERE tenant_id=$1 AND amount < 0",
      [f.tenantId]
    );
    expect(Number(debits.rows[0].n)).toBe(0);

    // The destination status did not advance.
    const statusAfter = (
      await admin.query<{ status: string }>("SELECT status FROM submissions WHERE id=$1", [destinationId])
    ).rows[0].status;
    expect(statusAfter).toBe(statusBefore);
  });

  it("C: a missing reservation fails settlement closed", async () => {
    const f = await createTenantFixture("missing");
    await addCredits(f, 10, "pc-missing");
    // A Partner submission that reached MintVault WITHOUT ever reserving credit. Built by
    // inserting the handoff directly rather than by mutating reservations after the fact —
    // partner_credit_reservations identity fields are immutable by trigger, which is itself a
    // protection worth not fighting.
    const draft = await makeDraft(f, nCards(2, "miss"));
    await admin.query(
      `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot)
       VALUES ($1,$2,'pending','{}'::jsonb)`,
      [f.tenantId, draft]
    );
    const destinationId = await mapImportedSubmission(f, draft);
    const before = await ledgerTotal(f);
    expect(await reservationsFor(f, draft)).toHaveLength(0);
    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return", {})
    ).rejects.toThrow();
    expect(await ledgerTotal(f)).toBe(before);
  });

  // ---------------------------------------------------------------- D. Cancellation

  it("D: cancelling releases EVERY reservation, and repeats are idempotent", async () => {
    const f = await createTenantFixture("cancel");
    await addCredits(f, 20, "pc-cancel");
    const draft = await makeDraft(f, nCards(6, "can"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-cancel-submit");
    expect((await creditReservations.getCreditPosition(f.tenantId)).activeReserved).toBe(6);

    await submissions.cancelSubmission(principalFor(f), draft, "changed my mind");
    const rows = await reservationsFor(f, draft);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.status === "released")).toBe(true);

    const position = await creditReservations.getCreditPosition(f.tenantId);
    expect(position.activeReserved).toBe(0);
    expect(position.availableBalance).toBe(20); // fully refunded, nothing consumed
    expect(await ledgerTotal(f)).toBe(20);

    // Repeat cancellation must not double-release or write more events.
    await submissions.cancelSubmission(principalFor(f), draft, "again").catch(() => undefined);
    expect((await reservationsFor(f, draft)).filter((r) => r.status === "released")).toHaveLength(6);
    expect((await creditReservations.getCreditPosition(f.tenantId)).availableBalance).toBe(20);
  });

  it("D: cancellation after consumption is refused — no partial release", async () => {
    const f = await createTenantFixture("cancel-after");
    await addCredits(f, 20, "pc-cancel-after");
    const draft = await makeDraft(f, nCards(3, "ca"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-ca-submit");
    const destinationId = await mapImportedSubmission(f, draft);
    await lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return", {});

    await expect(submissions.cancelSubmission(principalFor(f), draft, "too late")).rejects.toThrow();
    const rows = await reservationsFor(f, draft);
    expect(rows.every((r) => r.status === "consumed")).toBe(true);
    expect(rows.filter((r) => r.status === "released")).toHaveLength(0);
  });

  it.each([[2], [20]])("D: direct 0042 SQL release function releases all %i active card reservations", async (cards) => {
    const f = await createTenantFixture(`sql-release-${cards}`);
    await addCredits(f, 30, `pc-sql-release-${cards}`);
    const draft = await makeDraft(f, nCards(cards, `sqlr${cards}`));
    await submissions.submitSubmission(principalFor(f), draft, `pc-sql-release-submit-${cards}`);
    const connectorId = await mapTerminalConnector(f, draft);

    const released = await callConnectorRelease(f, connectorId, draft);
    expect(released.outcome).toBe("released");
    expect(released.reservation_id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await reservationsFor(f, draft);
    expect(rows).toHaveLength(cards);
    expect(rows.every((r) => r.status === "released")).toBe(true);
    const events = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM partner_credit_reservation_events e
         JOIN partner_credit_reservations r ON r.id=e.reservation_id
        WHERE r.tenant_id=$1 AND r.submission_reference=$2 AND e.event_type='released'`,
      [f.tenantId, draft]
    );
    expect(Number(events.rows[0].n)).toBe(cards);

    const replay = await callConnectorRelease(f, connectorId, draft);
    expect(replay.outcome).toBe("already_settled");
    expect((await reservationsFor(f, draft)).filter((r) => r.status === "released")).toHaveLength(cards);
  });

  it("D: direct 0042 SQL release fails closed for a cross-tenant call", async () => {
    const a = await createTenantFixture("sql-cross-a");
    const b = await createTenantFixture("sql-cross-b");
    await addCredits(b, 5, "pc-sql-cross-b");
    const draftB = await makeDraft(b, nCards(2, "sqlxb"));
    await submissions.submitSubmission(principalFor(b), draftB, "pc-sql-cross-submit-b");
    const connectorB = await mapTerminalConnector(b, draftB);

    const forged = await callConnectorRelease(a, connectorB, draftB, b.tenantId);
    expect(forged).toEqual({ outcome: "corrupt_linkage", reservation_id: null });
    expect((await reservationsFor(b, draftB)).filter((r) => r.status === "active")).toHaveLength(2);
  });

  it("D: direct 0042 SQL release fails closed for mixed active and terminal reservation states", async () => {
    const f = await createTenantFixture("sql-mixed");
    await addCredits(f, 10, "pc-sql-mixed");
    const draft = await makeDraft(f, nCards(3, "sqlmix"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-sql-mixed-submit");
    const connectorId = await mapTerminalConnector(f, draft);
    const rows = await reservationsFor(f, draft);
    await creditReservations.releaseReservedCredit(adminActor, {
      tenantId: f.tenantId,
      reservationId: rows[0].id,
      idempotencyKey: "pc-sql-mixed-one",
      source: "admin",
      reason: "mixed-state proof",
      actorType: "admin",
    });

    const mixed = await callConnectorRelease(f, connectorId, draft);
    expect(mixed.outcome).toBe("corrupt_linkage");
    const after = await reservationsFor(f, draft);
    expect(after.filter((r) => r.status === "released")).toHaveLength(1);
    expect(after.filter((r) => r.status === "active")).toHaveLength(2);
  });

  it("D: rollback restores 0041 single-reservation behaviour, and reapply restores 0042 multi-card release", async () => {
    const f = await createTenantFixture("rollback-reapply");
    await addCredits(f, 20, "pc-rollback-reapply");
    const draft = await makeDraft(f, nCards(2, "rbr"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-rollback-reapply-submit");
    const connectorId = await mapTerminalConnector(f, draft);

    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      await migrator.query(
        readFileSync(join(process.cwd(), "migrations", "rollback-0042-partner-per-card-credit-settlement.sql"), "utf8")
      );
      const single = await callConnectorRelease(f, connectorId, draft);
      expect(single.outcome).toBe("corrupt_linkage");
      expect((await reservationsFor(f, draft)).filter((r) => r.status === "active")).toHaveLength(2);

      await migrator.query(
        readFileSync(join(process.cwd(), "migrations", "0042_partner_per_card_credit_settlement.sql"), "utf8")
      );
      const multi = await callConnectorRelease(f, connectorId, draft);
      expect(multi.outcome).toBe("released");
      expect((await reservationsFor(f, draft)).filter((r) => r.status === "released")).toHaveLength(2);
    } finally {
      await migrator.end();
    }
  }, 60_000);

  // ---------------------------------------------------------------- E. Isolation

  it("E: tenant A cannot see, settle or release tenant B's reservations", async () => {
    const a = await createTenantFixture("iso-a");
    const b = await createTenantFixture("iso-b");
    await addCredits(a, 10, "pc-iso-a");
    await addCredits(b, 10, "pc-iso-b");
    const draftA = await makeDraft(a, nCards(2, "isoa"));
    const draftB = await makeDraft(b, nCards(3, "isob"));
    await submissions.submitSubmission(principalFor(a), draftA, "pc-iso-a-submit");
    await submissions.submitSubmission(principalFor(b), draftB, "pc-iso-b-submit");

    // A's view never contains B's rows.
    expect(await reservationsFor(a, draftB)).toHaveLength(0);
    expect(await reservationsFor(b, draftA)).toHaveLength(0);

    // A cannot cancel B's submission.
    await expect(submissions.cancelSubmission(principalFor(a), draftB, "cross-tenant")).rejects.toThrow();
    expect((await reservationsFor(b, draftB)).every((r) => r.status === "active")).toBe(true);

    // A forged reservation id from another tenant is refused by the reservation service.
    const bRows = await reservationsFor(b, draftB);
    await expect(
      creditReservations.releaseReservedCredit(adminActor, {
        tenantId: a.tenantId,
        reservationId: bRows[0].id,
        idempotencyKey: "pc-forged",
        source: "admin",
        reason: "forged",
        actorType: "admin",
      })
    ).rejects.toThrow();
    expect((await reservationsFor(b, draftB)).every((r) => r.status === "active")).toBe(true);
    expect((await creditReservations.getCreditPosition(b.tenantId)).activeReserved).toBe(3);
  });

  // ---------------------------------------------------------------- F. Ledger invariants

  it("F: the credit ledger is append-only — UPDATE and DELETE are refused by the database", async () => {
    const f = await createTenantFixture("append-only");
    await addCredits(f, 5, "pc-append");
    // The append-only triggers raise restrict_violation (23001), asserted explicitly so this
    // stays a real database-level proof rather than "some error happened".
    await expect(
      admin.query("UPDATE partner_credit_ledger SET amount = amount + 100 WHERE tenant_id=$1", [f.tenantId])
    ).rejects.toMatchObject({ code: "23001" });
    await expect(
      admin.query("DELETE FROM partner_credit_ledger WHERE tenant_id=$1", [f.tenantId])
    ).rejects.toMatchObject({ code: "23001" });
    expect(await ledgerTotal(f)).toBe(5);
  });

  it("F: balance is DERIVED from the ledger, not stored on the wallet", async () => {
    const f = await createTenantFixture("derived");
    await addCredits(f, 12, "pc-derived");
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='partner_wallets' AND column_name ~* 'balance|credits'`
    );
    expect(columns.rows).toEqual([]);
    expect((await creditReservations.getCreditPosition(f.tenantId)).ledgerBalance).toBe(await ledgerTotal(f));
  });

  it("F: a debit that would breach active reservations is refused by the database trigger", async () => {
    const f = await createTenantFixture("no-negative");
    await addCredits(f, 4, "pc-neg");
    const draft = await makeDraft(f, nCards(4, "neg"));
    await submissions.submitSubmission(principalFor(f), draft, "pc-neg-submit");
    // All 4 credits are now reserved; removing any would leave balance < active_reserved.
    await expect(
      admin.query(
        `INSERT INTO partner_credit_ledger (tenant_id,wallet_id,amount,entry_type,source,reason,idempotency_key,actor_type,request_fingerprint)
         SELECT $1, id, -1, 'adjustment','admin','forced negative','pc-neg-force','admin',repeat('a',64)
           FROM partner_wallets WHERE tenant_id=$1`,
        [f.tenantId]
      )
    ).rejects.toThrow();
    expect(await ledgerTotal(f)).toBe(4);
    expect((await creditReservations.getCreditPosition(f.tenantId)).availableBalance).toBe(0);
  });
});
