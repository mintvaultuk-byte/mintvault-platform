/** G6D: real PostgreSQL coverage for Partner submission credit lifecycle integration. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import type { Express } from "express";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { migratorUrlFrom, provisionRealisticRoles } from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let creditReservations: typeof import("../server/partner/partner-credit-reservation-service");
let submissions: typeof import("../server/partner/submission-service");
let lifecycle: typeof import("../server/partner/partner-submission-credit-lifecycle");
let connectorAdmin: typeof import("../server/partner/connector-admin-service");
let mintVaultStorage: Pick<typeof import("../server/storage").storage, "updateSubmissionStatus">;
let connectorService: typeof import("../server/partner/connector-service");
let tenantId: string;
let locationId: string;
let partnerUserId: string;
let sequence = 0;

const adminActor = { actorUserId: null, actorEmail: "g6d-admin@example.com" };

interface TenantFixture {
  tenantId: string;
  locationId: string;
  userId: string;
}

async function configureConnectorRuntime(): Promise<void> {
  await admin.query("CREATE ROLE g6d_connector_test LOGIN PASSWORD 'synthetic'");
  await admin.query("GRANT partner_connector_runtime TO g6d_connector_test");
  await admin.query("CREATE ROLE g6d_partner_test LOGIN PASSWORD 'synthetic'");
  await admin.query("GRANT partner_runtime TO g6d_partner_test");
  const connectorUrl = new URL(cluster.url);
  connectorUrl.username = "g6d_connector_test";
  connectorUrl.password = "synthetic";
  process.env.PARTNER_CONNECTOR_DATABASE_URL = connectorUrl.toString();
  const partnerUrl = new URL(cluster.url);
  partnerUrl.username = "g6d_partner_test";
  partnerUrl.password = "synthetic";
  process.env.PARTNER_DATABASE_URL = partnerUrl.toString();
}

function principal() {
  return {
    sessionId: "g6d-session",
    tenantId,
    userId: partnerUserId,
    locationId,
    mfaPassed: true,
    permissions: new Set(["partner.orders.create", "partner.orders.cancel"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: true,
  };
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar not null, status varchar(30) not null default 'draft',
    tracking_number text not null unique, card_count integer not null default 0,
    total_price decimal(10,2) not null default 0, total_declared_value integer not null default 0,
    payment_status varchar(20) not null default 'unpaid', payment_intent_id text,
    service_type text, service_tier text, grading_cost integer default 0,
    customer_email text, customer_first_name text, customer_last_name text,
    return_tracking text, return_carrier text, return_service text, return_postage_cost integer,
    on_receipt_photo_urls jsonb, delivered_at timestamptz, shipped_at timestamptz, completed_at timestamptz,
    deleted_at timestamptz, status_history jsonb, updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function createTenant(): Promise<void> {
  tenantId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name,status) VALUES ('G6D Partner','ACTIVE') RETURNING id"
    )
  ).rows[0].id;
  locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,'G6D HQ','ACTIVE') RETURNING id",
      [tenantId]
    )
  ).rows[0].id;
  partnerUserId = "a1000000-0000-4000-8000-000000000001";
  await admin.query(
    `INSERT INTO partner_users (id,public_ref,tenant_id,partner_id,email,password_hash,status,mfa_required)
     VALUES ($1,'g6d-user',$2,$2,'partner@g6d.example','x','ACTIVE',false)`,
    [partnerUserId, tenantId]
  );
}

async function addCredits(amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, tenantId);
  if (amount > 0) {
    await wallet.appendFoundationCredit(adminActor, {
      tenantId,
      amount,
      entryType: "purchase",
      source: "admin",
      reason: "G6D test credits",
      idempotencyKey: key,
      actorType: "admin",
    });
  }
}

function principalFor(fixture: TenantFixture, orgWide = false) {
  return {
    sessionId: `g6d-${fixture.tenantId}`,
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    locationId: fixture.locationId,
    mfaPassed: true,
    permissions: new Set(["partner.orders.create", "partner.orders.cancel"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide,
  };
}

async function createTenantFixture(label: string): Promise<TenantFixture> {
  const ordinal = ++sequence;
  const tenantId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name,status) VALUES ($1,'ACTIVE') RETURNING id",
      [`G6D Isolation ${label} ${ordinal}`]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
      [tenantId, `G6D Isolation ${label} HQ`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id,partner_id,email,password_hash,status,mfa_required)
       VALUES ($1,$1,$2,'x','ACTIVE',false) RETURNING id`,
      [tenantId, `g6d-isolation-${label.toLowerCase()}-${ordinal}@example.com`]
    )
  ).rows[0].id;
  await admin.query("INSERT INTO partner_user_locations (tenant_id,user_id,location_id) VALUES ($1,$2,$3)", [
    tenantId,
    userId,
    locationId,
  ]);
  return { tenantId, locationId, userId };
}

async function addCreditsFor(fixture: TenantFixture, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, fixture.tenantId);
  await wallet.appendFoundationCredit(adminActor, {
    tenantId: fixture.tenantId,
    amount,
    entryType: "purchase",
    source: "admin",
    reason: "G6D isolation test credits",
    idempotencyKey: key,
    actorType: "admin",
  });
}

async function makeDraftFor(fixture: TenantFixture): Promise<string> {
  const id = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
       VALUES ($1,$2,$3,1,'draft') RETURNING id`,
      [fixture.tenantId, fixture.locationId, fixture.userId]
    )
  ).rows[0].id;
  await admin.query(
    `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name,quantity)
     VALUES ($1,$2,1,$3,1)`,
    [fixture.tenantId, id, `G6D isolation card ${++sequence}`]
  );
  return id;
}

async function submitDraftFor(fixture: TenantFixture, submissionId: string, key: string) {
  return submissions.submitSubmission(principalFor(fixture), submissionId, key);
}

async function createConnectorRecordFor(
  fixture: TenantFixture,
  submissionId: string,
  state: "validating" | "imported" = "validating"
): Promise<{ id: string; handoffId: string; version: number }> {
  const handoff = await admin.query<{ id: string }>(
    "SELECT id FROM partner_submission_handoffs WHERE tenant_id=$1 AND submission_id=$2",
    [fixture.tenantId, submissionId]
  );
  const connector = await admin.query<{ id: string; version: number }>(
    `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state,attempt_count)
     VALUES ($1,$2,$3,$4,1) RETURNING id, version`,
    [fixture.tenantId, submissionId, handoff.rows[0].id, state]
  );
  return { ...connector.rows[0], handoffId: handoff.rows[0].id };
}

async function makeDraft(): Promise<string> {
  sequence += 1;
  const id = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
       VALUES ($1,$2,$3,1,'draft') RETURNING id`,
      [tenantId, locationId, partnerUserId]
    )
  ).rows[0].id;
  await admin.query(
    `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name,quantity)
     VALUES ($1,$2,1,$3,1)`,
    [tenantId, id, `G6D Card ${sequence}`]
  );
  return id;
}

async function submitDraft(id: string, key = `submit-${id}`) {
  return submissions.submitSubmission(principal(), id, key);
}

async function mapImportedSubmission(partnerSubmissionId: string): Promise<number> {
  const handoff = await admin.query<{ id: string }>(
    "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
    [partnerSubmissionId]
  );
  const connector = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records
       (tenant_id,partner_submission_id,handoff_id,state,attempt_count)
     VALUES ($1,$2,$3,'imported',1) RETURNING id`,
    [tenantId, partnerSubmissionId, handoff.rows[0].id]
  );
  const validation = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_validation_runs
       (connector_record_id,validation_attempt,source_submission_version,source_handoff_status,
        source_fingerprint,source_fingerprint_version,outcome,blocking_error_count,warning_count,completed_at)
     VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
    [connector.rows[0].id, "a".repeat(64)]
  );
  const destination = await admin.query<{ id: number }>(
    `INSERT INTO submissions (user_id,tracking_number,status) VALUES ('g6d-customer',$1,'in_grading') RETURNING id`,
    [`MV-G6D-${sequence}`]
  );
  await admin.query(
    `INSERT INTO partner_connector_imports
       (connector_record_id,partner_organisation_id,partner_location_id,partner_submission_id,partner_handoff_id,
        validation_run_id,source_fingerprint,source_fingerprint_version,mapping_version,import_attempt,
        state,destination_submission_id,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'completed',$8,now())`,
    [
      connector.rows[0].id,
      tenantId,
      locationId,
      partnerSubmissionId,
      handoff.rows[0].id,
      validation.rows[0].id,
      "a".repeat(64),
      destination.rows[0].id,
    ]
  );
  return destination.rows[0].id;
}

describe("G6D Partner submission credit lifecycle on PostgreSQL 17.10", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-submission-credit-lifecycle");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      const files = listMigrationFiles();
      await applyMigrations(
        migrator,
        files.filter((file) => file.number < 19)
      );
      /*
       * Submission acceptance now writes a canonical Card Job in the SAME transaction as the credit
       * reservation, so this table must exist or every reserve-on-accept assertion below fails with
       * "relation partner_card_jobs does not exist".
       *
       * It is applied as RAW SQL rather than through applyMigrations() ON PURPOSE. This suite also
       * exercises rollback-0041, whose guard refuses to run while a HIGHER-NUMBERED migration is
       * recorded in the journal — a correct guard that must not be weakened. Routing 0080 through
       * applyMigrations() would journal migration 80 and make that rollback test fail for a reason
       * that has nothing to do with what it is testing. Executing the file directly creates the
       * table the reserve tests need while leaving the journal at the state the rollback test
       * requires. The file is idempotent (IF NOT EXISTS throughout), so this is safe.
       */
      await migrator.query(readFileSync("migrations/0080_partner_card_jobs.sql", "utf8"));
      // PG17 records role-membership grantors. The deployment owner must execute
      // 0041 so it can revoke the temporary definer membership it grants itself.
      await applyMigrations(
        admin,
        files.filter((file) => file.filename === "0041_partner_submission_credit_lifecycle.sql")
      );
    } finally {
      await migrator.end();
    }
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    wallet = await import("../server/partner/partner-wallet-service");
    creditReservations = await import("../server/partner/partner-credit-reservation-service");
    submissions = await import("../server/partner/submission-service");
    lifecycle = await import("../server/partner/partner-submission-credit-lifecycle");
    connectorAdmin = await import("../server/partner/connector-admin-service");
    mintVaultStorage = (await import("../server/storage")).storage;
    connectorService = await import("../server/partner/connector-service");
    await configureConnectorRuntime();
    await admin.query(
      "INSERT INTO partner_feature_flags (flag,tenant_id,location_id,enabled) VALUES ('partner_connector_enabled',NULL,NULL,true),('partner_emergency_stop',NULL,NULL,false),('partner_submission_intake_enabled',NULL,NULL,true)"
    );
    await createTenant();
  }, 90_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    const connectorDb = await import("../server/partner/connector-db");
    await db.closePartnerPools().catch(() => {});
    await connectorDb.closeConnectorPool().catch(() => {});
    delete process.env.PARTNER_CONNECTOR_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("grants the connector only the narrow release function, with no direct accounting-table access", async () => {
    expect((await admin.query("SHOW server_version")).rows[0].server_version).toMatch(/^17\.10(?:\s|$)/);
    const roles = await admin.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolname, rolbypassrls, rolsuper, rolcanlogin
         FROM pg_roles
        WHERE rolname IN ('partner_runtime','partner_connector_runtime','partner_credit_lifecycle_definer')
        ORDER BY rolname`
    );
    expect(roles.rows).toEqual([
      { rolname: "partner_connector_runtime", rolbypassrls: false, rolsuper: false, rolcanlogin: false },
      { rolname: "partner_credit_lifecycle_definer", rolbypassrls: true, rolsuper: false, rolcanlogin: false },
      { rolname: "partner_runtime", rolbypassrls: false, rolsuper: false, rolcanlogin: false },
    ]);
    const grants = await admin.query<{
      wallet_select: boolean;
      reservation_table_update: boolean;
      reservation_status_update: boolean;
      reservation_released_at_update: boolean;
      reservation_expired_at_update: boolean;
      reservation_reason_update: boolean;
      reservation_insert: boolean;
      reservation_delete: boolean;
      event_select: boolean;
      event_table_insert: boolean;
      event_insert: boolean;
      event_id_insert: boolean;
      event_update: boolean;
      event_delete: boolean;
      wallet_update: boolean;
      ledger_insert: boolean;
      ledger_select: boolean;
      source_submission_select: boolean;
      source_submission_update: boolean;
      partner_wallet_update: boolean;
      partner_ledger_insert: boolean;
      public_reservation_select: boolean;
      public_event_insert: boolean;
      connector_release_execute: boolean;
      public_release_execute: boolean;
      definer_connector_select: boolean;
      definer_reservation_update: boolean;
      definer_event_insert: boolean;
    }>(
      `SELECT
        has_table_privilege('partner_connector_runtime','partner_wallets','SELECT') AS wallet_select,
        has_table_privilege('partner_connector_runtime','partner_credit_reservations','UPDATE') AS reservation_table_update,
        has_column_privilege('partner_connector_runtime','partner_credit_reservations','status','UPDATE') AS reservation_status_update,
        has_column_privilege('partner_connector_runtime','partner_credit_reservations','released_at','UPDATE') AS reservation_released_at_update,
        has_column_privilege('partner_connector_runtime','partner_credit_reservations','expired_at','UPDATE') AS reservation_expired_at_update,
        has_column_privilege('partner_connector_runtime','partner_credit_reservations','reason','UPDATE') AS reservation_reason_update,
        has_table_privilege('partner_connector_runtime','partner_credit_reservations','INSERT') AS reservation_insert,
        has_table_privilege('partner_connector_runtime','partner_credit_reservations','DELETE') AS reservation_delete,
        has_table_privilege('partner_connector_runtime','partner_credit_reservation_events','SELECT') AS event_select,
        has_table_privilege('partner_connector_runtime','partner_credit_reservation_events','INSERT') AS event_table_insert,
        has_column_privilege('partner_connector_runtime','partner_credit_reservation_events','event_type','INSERT') AS event_insert,
        has_column_privilege('partner_connector_runtime','partner_credit_reservation_events','id','INSERT') AS event_id_insert,
        has_table_privilege('partner_connector_runtime','partner_credit_reservation_events','UPDATE') AS event_update,
        has_table_privilege('partner_connector_runtime','partner_credit_reservation_events','DELETE') AS event_delete,
        has_table_privilege('partner_connector_runtime','partner_wallets','UPDATE') AS wallet_update,
        has_table_privilege('partner_connector_runtime','partner_credit_ledger','INSERT') AS ledger_insert,
        has_table_privilege('partner_connector_runtime','partner_credit_ledger','SELECT') AS ledger_select,
        has_table_privilege('partner_connector_runtime','partner_submissions','SELECT') AS source_submission_select,
        has_table_privilege('partner_connector_runtime','partner_submissions','UPDATE') AS source_submission_update,
        has_table_privilege('partner_runtime','partner_wallets','UPDATE') AS partner_wallet_update,
        has_table_privilege('partner_runtime','partner_credit_ledger','INSERT') AS partner_ledger_insert,
        has_table_privilege('public','partner_credit_reservations','SELECT') AS public_reservation_select,
        has_table_privilege('public','partner_credit_reservation_events','INSERT') AS public_event_insert,
        has_function_privilege('partner_connector_runtime','partner_connector_release_submission_credit(uuid,uuid,uuid,text)','EXECUTE') AS connector_release_execute,
        has_function_privilege('public','partner_connector_release_submission_credit(uuid,uuid,uuid,text)','EXECUTE') AS public_release_execute,
        has_table_privilege('partner_credit_lifecycle_definer','partner_connector_records','SELECT') AS definer_connector_select,
        has_column_privilege('partner_credit_lifecycle_definer','partner_credit_reservations','status','UPDATE') AS definer_reservation_update,
        has_table_privilege('partner_credit_lifecycle_definer','partner_credit_reservation_events','INSERT') AS definer_event_insert`
    );
    expect(grants.rows[0]).toEqual({
      wallet_select: false,
      reservation_table_update: false,
      reservation_status_update: false,
      reservation_released_at_update: false,
      reservation_expired_at_update: false,
      reservation_reason_update: false,
      reservation_insert: false,
      reservation_delete: false,
      event_select: false,
      event_table_insert: false,
      event_insert: false,
      event_id_insert: false,
      event_update: false,
      event_delete: false,
      wallet_update: false,
      ledger_insert: false,
      ledger_select: false,
      source_submission_select: true,
      source_submission_update: false,
      partner_wallet_update: false,
      partner_ledger_insert: false,
      public_reservation_select: false,
      public_event_insert: false,
      connector_release_execute: true,
      public_release_execute: false,
      definer_connector_select: true,
      definer_reservation_update: true,
      definer_event_insert: false,
    });
    const functionOwner = await admin.query<{ owner: string; security_definer: boolean }>(
      `SELECT r.rolname AS owner, p.prosecdef AS security_definer
         FROM pg_proc p
         JOIN pg_roles r ON r.oid=p.proowner
        WHERE p.oid='partner_connector_release_submission_credit(uuid,uuid,uuid,text)'::regprocedure`
    );
    expect(functionOwner.rows).toEqual([{ owner: "partner_credit_lifecycle_definer", security_definer: true }]);
  });

  it("reserves one credit atomically when an authenticated Partner accepts a submission", async () => {
    await addCredits(3, "g6d-success-credit");
    const source = await makeDraft();
    const accepted = await submitDraft(source, "g6d-success-submit");
    expect(accepted.submission.status).toBe("submitted_to_mintvault");

    const reservation = await admin.query<{
      status: string;
      submission_reference: string;
      reserved_credits: string;
      actor_user_id: string;
    }>(
      `SELECT status, submission_reference, reserved_credits, actor_user_id
         FROM partner_credit_reservations WHERE tenant_id=$1 AND submission_reference=$2`,
      [tenantId, source]
    );
    expect(reservation.rows).toEqual([
      expect.objectContaining({
        status: "active",
        submission_reference: source,
        reserved_credits: "1",
        actor_user_id: partnerUserId,
      }),
    ]);
    const position = await creditReservations.getCreditPosition(tenantId);
    expect(position).toMatchObject({ ledgerBalance: 3, activeReserved: 1, availableBalance: 2 });
  });

  it("is idempotent on duplicate submission requests and never double-reserves", async () => {
    const source = await makeDraft();
    const first = await submitDraft(source, "g6d-duplicate-submit");
    const retry = await submitDraft(source, "g6d-duplicate-submit");
    expect(retry.submission.id).toBe(first.submission.id);
    const rows = await admin.query<{ n: string }>(
      "SELECT count(*)::bigint n FROM partner_credit_reservations WHERE submission_reference=$1",
      [source]
    );
    expect(rows.rows[0].n).toBe("1");
  });

  it("projects the automatic reservation, wallet status, and Partner for Super Admin", async () => {
    await addCredits(1, "g6d-admin-projection-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-admin-projection");

    const before = await admin.query<{ events: string; ledger: string }>(
      `SELECT
         (SELECT count(*)::bigint FROM partner_credit_reservation_events WHERE tenant_id=$1) AS events,
         (SELECT count(*)::bigint FROM partner_credit_ledger WHERE tenant_id=$1) AS ledger`,
      [tenantId]
    );
    const projection = await connectorAdmin.getPartnerSubmissionCreditProjection(tenantId, source);
    const after = await admin.query<{ events: string; ledger: string }>(
      `SELECT
         (SELECT count(*)::bigint FROM partner_credit_reservation_events WHERE tenant_id=$1) AS events,
         (SELECT count(*)::bigint FROM partner_credit_ledger WHERE tenant_id=$1) AS ledger`,
      [tenantId]
    );
    expect(projection).toEqual(
      expect.objectContaining({
        reservation_status: "active",
        wallet_status: "active",
        partner_id: tenantId,
        partner_legal_name: "G6D Partner",
      })
    );
    expect(projection?.reservation_id).toEqual(expect.any(String));
    expect(after.rows).toEqual(before.rows); // the Super Admin projection is strictly read-only
  });

  it("fails closed for cross-tenant location, membership, submission, reserve, and cancellation attempts", async () => {
    const tenantA = await createTenantFixture("A");
    const tenantB = await createTenantFixture("B");
    await addCreditsFor(tenantA, 2, "g6d-isolation-a-credit");
    await addCreditsFor(tenantB, 2, "g6d-isolation-b-credit");
    const submissionB = await makeDraftFor(tenantB);
    await submitDraftFor(tenantB, submissionB, "g6d-isolation-b-submit");

    // This corrupt-but-schema-permitted association proves the application predicate does not
    // mistake user_id alone for a tenant-safe location assignment.
    await admin.query("INSERT INTO partner_user_locations (tenant_id,user_id,location_id) VALUES ($1,$2,$3)", [
      tenantA.tenantId,
      tenantA.userId,
      tenantB.locationId,
    ]);
    const aPrincipal = principalFor(tenantA);
    const before = await admin.query<{ submissions: string; reservations: string; events: string }>(
      `SELECT
         (SELECT count(*)::bigint FROM partner_submissions WHERE tenant_id=$1) AS submissions,
         (SELECT count(*)::bigint FROM partner_credit_reservations WHERE tenant_id=$1) AS reservations,
         (SELECT count(*)::bigint FROM partner_credit_reservation_events WHERE tenant_id=$1) AS events`,
      [tenantA.tenantId]
    );

    await expect(
      submissions.createSubmissionDraft(aPrincipal, { locationId: tenantB.locationId })
    ).rejects.toMatchObject({
      code: "validation",
    });
    await expect(submissions.getSubmissionDetail(aPrincipal, submissionB)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      submissions.submitSubmission(aPrincipal, submissionB, "g6d-cross-tenant-submit")
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      creditReservations.reserveCredit(adminActor, {
        tenantId: tenantA.tenantId,
        locationId: tenantB.locationId,
        cardReference: "g6d-cross-tenant-card",
        submissionReference: submissionB,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "g6d-cross-tenant-reserve",
        source: "portal",
        reason: "Must fail before a cross-tenant reservation can be created.",
        actorType: "admin",
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      submissions.cancelSubmission(aPrincipal, submissionB, "Cross-tenant cancellation.")
    ).rejects.toMatchObject({
      code: "not_found",
    });

    const after = await admin.query<{ submissions: string; reservations: string; events: string }>(
      `SELECT
         (SELECT count(*)::bigint FROM partner_submissions WHERE tenant_id=$1) AS submissions,
         (SELECT count(*)::bigint FROM partner_credit_reservations WHERE tenant_id=$1) AS reservations,
         (SELECT count(*)::bigint FROM partner_credit_reservation_events WHERE tenant_id=$1) AS events`,
      [tenantA.tenantId]
    );
    expect(after.rows).toEqual(before.rows);
    const bReservation = await admin.query<{ status: string; releases: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='released') AS releases
         FROM partner_credit_reservations r
        WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
      [tenantB.tenantId, submissionB]
    );
    expect(bReservation.rows).toEqual([{ status: "active", releases: "0" }]);
  });

  it("keeps tenant-local idempotency and concurrent wallet reservations independent", async () => {
    const tenantA = await createTenantFixture("Concurrent A");
    const tenantB = await createTenantFixture("Concurrent B");
    await addCreditsFor(tenantA, 1, "g6d-isolation-concurrent-a-credit");
    await addCreditsFor(tenantB, 1, "g6d-isolation-concurrent-b-credit");
    const submissionA = await makeDraftFor(tenantA);
    const submissionB = await makeDraftFor(tenantB);

    const results = await Promise.allSettled([
      submitDraftFor(tenantA, submissionA, "g6d-shared-cross-tenant-idempotency-key"),
      submitDraftFor(tenantB, submissionB, "g6d-shared-cross-tenant-idempotency-key"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(
      submitDraftFor(tenantA, submissionA, "g6d-shared-cross-tenant-idempotency-key")
    ).resolves.toMatchObject({
      submission: { id: submissionA },
    });

    await expect(creditReservations.getCreditPosition(tenantA.tenantId)).resolves.toMatchObject({
      ledgerBalance: 1,
      activeReserved: 1,
      availableBalance: 0,
    });
    await expect(creditReservations.getCreditPosition(tenantB.tenantId)).resolves.toMatchObject({
      ledgerBalance: 1,
      activeReserved: 1,
      availableBalance: 0,
    });
  });

  it("does not release a reservation when connector tenant or submission linkage is wrong", async () => {
    const tenantA = await createTenantFixture("Connector A");
    const tenantB = await createTenantFixture("Connector B");
    await addCreditsFor(tenantA, 1, "g6d-isolation-connector-a-credit");
    await addCreditsFor(tenantB, 1, "g6d-isolation-connector-b-credit");
    const submissionA = await makeDraftFor(tenantA);
    const submissionB = await makeDraftFor(tenantB);
    await submitDraftFor(tenantA, submissionA, "g6d-isolation-connector-a-submit");
    await submitDraftFor(tenantB, submissionB, "g6d-isolation-connector-b-submit");
    const connectorA = await createConnectorRecordFor(tenantA, submissionA);

    const connectorDb = await import("../server/partner/connector-db");
    await expect(
      connectorDb.withConnectorTx((client) =>
        lifecycle.releasePartnerReservationForConnectorTerminalState(
          client,
          { id: connectorA.id, tenantId: tenantA.tenantId, partnerSubmissionId: submissionB },
          "validation_rejected"
        )
      )
    ).rejects.toMatchObject({ code: "connector_link_inconsistent" });
    await expect(
      connectorDb.withConnectorTx((client) =>
        lifecycle.releasePartnerReservationForConnectorTerminalState(
          client,
          { id: connectorA.id, tenantId: tenantB.tenantId, partnerSubmissionId: submissionA },
          "validation_rejected"
        )
      )
    ).rejects.toMatchObject({ code: "connector_link_inconsistent" });
    await expect(
      connectorService.transitionConnectorState({
        connectorId: connectorA.id,
        tenantId: tenantB.tenantId,
        expectedVersion: connectorA.version,
        toState: "rejected",
        eventType: "cross_tenant_rejection",
      })
    ).rejects.toMatchObject({ code: "unauthorised" });

    const state = await admin.query<{ status: string; releases: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='released') AS releases
         FROM partner_credit_reservations r
        WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
      [tenantA.tenantId, submissionA]
    );
    expect(state.rows).toEqual([{ status: "active", releases: "0" }]);
  });

  it("does not consume a credit through a destination mapping whose Partner organisation is wrong", async () => {
    const tenantA = await createTenantFixture("Settlement A");
    const tenantB = await createTenantFixture("Settlement B");
    await addCreditsFor(tenantA, 1, "g6d-isolation-settlement-a-credit");
    const submissionA = await makeDraftFor(tenantA);
    await submitDraftFor(tenantA, submissionA, "g6d-isolation-settlement-a-submit");
    const connector = await createConnectorRecordFor(tenantA, submissionA, "imported");
    const validation = await admin.query<{ id: string }>(
      `INSERT INTO partner_connector_validation_runs
         (connector_record_id,validation_attempt,source_submission_version,source_handoff_status,
          source_fingerprint,source_fingerprint_version,outcome,blocking_error_count,warning_count,completed_at)
       VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
      [connector.id, "b".repeat(64)]
    );
    const destination = await admin.query<{ id: number }>(
      "INSERT INTO submissions (user_id,tracking_number,status) VALUES ('g6d-customer',$1,'in_grading') RETURNING id",
      [`MV-G6D-CROSS-${++sequence}`]
    );
    // The original connector record and submission are Tenant A, but the mapping is deliberately
    // corrupt and says Tenant B. Separate FKs permit this historical-corruption fixture; the G6D
    // settlement join must reject it rather than consume Tenant A's reservation.
    await admin.query(
      `INSERT INTO partner_connector_imports
         (connector_record_id,partner_organisation_id,partner_location_id,partner_submission_id,partner_handoff_id,
          validation_run_id,source_fingerprint,source_fingerprint_version,mapping_version,import_attempt,
          state,destination_submission_id,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'completed',$8,now())`,
      [
        connector.id,
        tenantB.tenantId,
        tenantB.locationId,
        submissionA,
        connector.handoffId,
        validation.rows[0].id,
        "b".repeat(64),
        destination.rows[0].id,
      ]
    );

    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(destination.rows[0].id, "ready_to_return")
    ).rejects.toMatchObject({ code: "credit_settlement_required" });
    const evidence = await admin.query<{
      status: string;
      consumed: string;
      destination_status: string;
      exceptions: string;
    }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='consumed') AS consumed,
              (SELECT status FROM submissions WHERE id=$3) AS destination_status,
              (SELECT count(*)::bigint FROM partner_credit_accounting_exceptions
                WHERE destination_submission_id=$3 AND reason_code='connector_import_identity_mismatch') AS exceptions
         FROM partner_credit_reservations r
        WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
      [tenantA.tenantId, submissionA, destination.rows[0].id]
    );
    expect(evidence.rows).toEqual([
      { status: "active", consumed: "0", destination_status: "in_grading", exceptions: "1" },
    ]);
  });

  it("rolls back the submission handoff when no credit is available", async () => {
    // The preceding happy-path + retry cases have left one available credit. Consume that final
    // slot through the normal acceptance path, then prove the next request leaves no partial rows.
    const finalAvailable = await makeDraft();
    await submitDraft(finalAvailable, "g6d-final-available-submit");
    const source = await makeDraft();
    await expect(submitDraft(source, "g6d-insufficient-submit")).rejects.toMatchObject({ code: "credit_unavailable" });
    const state = await admin.query<{ status: string; handoffs: string; reservations: string }>(
      `SELECT s.status,
              (SELECT count(*)::bigint FROM partner_submission_handoffs h WHERE h.submission_id=s.id) AS handoffs,
              (SELECT count(*)::bigint FROM partner_credit_reservations r WHERE r.submission_reference=s.id::text) AS reservations
         FROM partner_submissions s WHERE s.id=$1`,
      [source]
    );
    expect(state.rows[0]).toEqual({ status: "draft", handoffs: "0", reservations: "0" });
  });

  it("rejects submission acceptance for suspended and closed wallets without partial handoffs", async () => {
    for (const status of ["suspended", "closed"] as const) {
      await admin.query(
        `UPDATE partner_wallets
            SET status=$1, suspended_at=CASE WHEN $1='suspended' THEN now() ELSE NULL END,
                closed_at=CASE WHEN $1='closed' THEN now() ELSE NULL END
          WHERE tenant_id=$2`,
        [status, tenantId]
      );
      const source = await makeDraft();
      await expect(submitDraft(source, `g6d-${status}-submit`)).rejects.toMatchObject({ code: "credit_unavailable" });
      const rows = await admin.query<{ status: string; handoffs: string; reservations: string }>(
        `SELECT s.status,
                (SELECT count(*)::bigint FROM partner_submission_handoffs h WHERE h.submission_id=s.id) AS handoffs,
                (SELECT count(*)::bigint FROM partner_credit_reservations r WHERE r.submission_reference=s.id::text) AS reservations
           FROM partner_submissions s WHERE s.id=$1`,
        [source]
      );
      expect(rows.rows[0]).toEqual({ status: "draft", handoffs: "0", reservations: "0" });
    }
    await admin.query(
      "UPDATE partner_wallets SET status='active', suspended_at=NULL, closed_at=NULL WHERE tenant_id=$1",
      [tenantId]
    );
  });

  it("serializes concurrent submissions so only available credit can be reserved", async () => {
    await addCredits(1, "g6d-concurrent-credit");
    const available = await creditReservations.getCreditPosition(tenantId);
    const sourceA = await makeDraft();
    const sourceB = await makeDraft();
    const settled = await Promise.allSettled([
      submitDraft(sourceA, "g6d-concurrent-a"),
      submitDraft(sourceB, "g6d-concurrent-b"),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
      Math.min(available.availableBalance, 2)
    );
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(
      Math.max(0, 2 - available.availableBalance)
    );
    const linked = await admin.query<{ n: string }>(
      "SELECT count(*)::bigint n FROM partner_credit_reservations WHERE submission_reference = ANY($1::text[])",
      [[sourceA, sourceB]]
    );
    expect(Number(linked.rows[0].n)).toBe(Math.min(available.availableBalance, 2));
  });

  it("consumes exactly once at the existing grading-complete status", async () => {
    // Add enough headroom regardless of the concurrency test's outcome.
    await addCredits(5, "g6d-completion-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-completion-submit");
    const destinationId = await mapImportedSubmission(source);

    const first = await mintVaultStorage.updateSubmissionStatus(destinationId, "ready_to_return", {
      creditActorEmail: "super-admin@g6d.example",
    });
    const retry = await mintVaultStorage.updateSubmissionStatus(destinationId, "completed", {
      creditActorEmail: "super-admin@g6d.example",
    });
    expect(first?.status).toBe("ready_to_return");
    expect(retry?.status).toBe("completed");

    const evidence = await admin.query<{ status: string; events: string; debits: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e WHERE e.reservation_id=r.id AND e.event_type='consumed') AS events,
              (SELECT count(*)::bigint FROM partner_credit_ledger l WHERE l.correlation_id=r.id::text AND l.amount=-1) AS debits
         FROM partner_credit_reservations r WHERE r.submission_reference=$1`,
      [source]
    );
    expect(evidence.rows[0]).toEqual({ status: "consumed", events: "1", debits: "1" });
  });

  it("fails closed at completion for released, expired and suspended-credit accounting states", async () => {
    for (const state of ["released", "expired", "suspended_wallet"] as const) {
      await addCredits(1, `g6d-fail-closed-${state}-credit`);
      const source = await makeDraft();
      await submitDraft(source, `g6d-fail-closed-${state}-submit`);
      const destinationId = await mapImportedSubmission(source);
      if (state === "suspended_wallet") {
        await admin.query(
          `UPDATE partner_wallets
              SET status='suspended'
            WHERE tenant_id=$1`,
          [tenantId]
        );
      } else {
        await admin.query(
          `UPDATE partner_credit_reservations
              SET status=$3,
                  released_at=CASE WHEN $3='released' THEN now() ELSE NULL END,
                  expired_at=CASE WHEN $3='expired' THEN now() ELSE NULL END
            WHERE tenant_id=$1 AND submission_reference=$2`,
          [tenantId, source, state]
        );
      }

      await expect(
        lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return")
      ).rejects.toMatchObject({ code: "credit_settlement_required" });
      const outcome = await admin.query<{ status: string; destination_status: string; exceptions: string }>(
        `SELECT r.status,
                (SELECT status FROM submissions WHERE id=$3) AS destination_status,
                (SELECT count(*)::bigint FROM partner_credit_accounting_exceptions
                  WHERE destination_submission_id=$3) AS exceptions
           FROM partner_credit_reservations r
          WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
        [tenantId, source, destinationId]
      );
      expect(outcome.rows).toEqual([
        {
          status: state === "suspended_wallet" ? "active" : state,
          destination_status: "in_grading",
          exceptions: "1",
        },
      ]);
      if (state === "suspended_wallet") {
        await admin.query("UPDATE partner_wallets SET status='active' WHERE tenant_id=$1", [tenantId]);
      }
    }
  });

  it("releases an active reservation on cancellation before grading and cannot release it twice", async () => {
    await addCredits(1, "g6d-cancel-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-cancel-submit");
    const cancelled = await submissions.cancelSubmission(principal(), source, "Customer cancelled before grading.");
    expect(cancelled.status).toBe("cancelled");
    const state = await admin.query<{ status: string; releases: string; ledger_rows: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e WHERE e.reservation_id=r.id AND e.event_type='released') AS releases,
              (SELECT count(*)::bigint FROM partner_credit_ledger l WHERE l.correlation_id=r.id::text) AS ledger_rows
         FROM partner_credit_reservations r WHERE r.submission_reference=$1`,
      [source]
    );
    expect(state.rows[0]).toEqual({ status: "released", releases: "1", ledger_rows: "0" });
    await expect(submissions.cancelSubmission(principal(), source, "Duplicate cancellation.")).rejects.toMatchObject({
      code: "not_draft",
    });
  });

  it("holds a cancelled pre-grading destination until an authorised re-reservation succeeds", async () => {
    await addCredits(1, "g6d-cancel-hold-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-cancel-hold-submit");
    const destinationId = await mapImportedSubmission(source);
    await admin.query("UPDATE submissions SET status='paid' WHERE id=$1", [destinationId]);

    await submissions.cancelSubmission(principal(), source, "Customer cancelled before MintVault receipt.");

    const blocked = await admin.query<{
      reservation_status: string;
      active_holds: string;
      destination_status: string;
    }>(
      `SELECT r.status AS reservation_status,
              (SELECT count(*)::bigint FROM partner_submission_credit_holds h
                WHERE h.destination_submission_id=$3 AND h.released_at IS NULL) AS active_holds,
              (SELECT status FROM submissions WHERE id=$3) AS destination_status
         FROM partner_credit_reservations r
        WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
      [tenantId, source, destinationId]
    );
    expect(blocked.rows).toEqual([{ reservation_status: "released", active_holds: "1", destination_status: "paid" }]);

    // The database trigger protects all status writers, including any bypass of
    // the TypeScript lifecycle service.
    await expect(
      admin.query("UPDATE submissions SET status='in_grading' WHERE id=$1", [destinationId])
    ).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return")
    ).rejects.toMatchObject({
      code: "credit_settlement_required",
    });
    expect((await admin.query("SELECT status FROM submissions WHERE id=$1", [destinationId])).rows[0].status).toBe(
      "paid"
    );

    const recovery = await lifecycle.recoverPartnerDestinationCreditHold({
      tenantId,
      partnerSubmissionId: source,
      actorUserId: partnerUserId,
      actorEmail: adminActor.actorEmail,
      idempotencyKey: `g6d-hold-recovery-${++sequence}`,
      reason: "Verified replacement grading request.",
    });
    expect(recovery.destinationSubmissionId).toBe(destinationId);
    expect(recovery.alreadyRecovered).toBe(false);
    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return")
    ).resolves.toMatchObject({
      status: "ready_to_return",
    });
    const recovered = await admin.query<{ released_holds: string; status: string; recovery_evidence: string }>(
      `SELECT (SELECT count(*)::bigint FROM partner_submission_credit_holds h
                 WHERE h.destination_submission_id=$1 AND h.released_at IS NOT NULL) AS released_holds,
              (SELECT status FROM submissions WHERE id=$1) AS status,
              (SELECT count(*)::bigint FROM partner_credit_accounting_exceptions
                WHERE destination_submission_id=$1 AND event_type='destination_credit_recovery') AS recovery_evidence`,
      [destinationId]
    );
    expect(recovered.rows).toEqual([{ released_holds: "1", status: "ready_to_return", recovery_evidence: "1" }]);
  });

  it("never releases a reservation once MintVault has physically received the cards", async () => {
    await addCredits(1, "g6d-received-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-received-submit");
    const destinationId = await mapImportedSubmission(source);
    await admin.query("UPDATE submissions SET status='received' WHERE id=$1", [destinationId]);

    await expect(
      submissions.cancelSubmission(principal(), source, "Cards are already at MintVault.")
    ).rejects.toMatchObject({
      code: "credit_settlement_required",
    });
    const state = await admin.query<{ reservation_status: string; destination_status: string; releases: string }>(
      `SELECT r.status AS reservation_status,
              (SELECT status FROM submissions WHERE id=$3) AS destination_status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='released') AS releases
         FROM partner_credit_reservations r
        WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
      [tenantId, source, destinationId]
    );
    expect(state.rows).toEqual([{ reservation_status: "active", destination_status: "received", releases: "0" }]);
  });

  it("settles parallel completion requests exactly once", async () => {
    await addCredits(1, "g6d-parallel-consume-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-parallel-consume-submit");
    const destinationId = await mapImportedSubmission(source);

    const results = await Promise.all([
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return"),
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return"),
    ]);
    expect(results.every((row) => row?.status === "ready_to_return")).toBe(true);
    const state = await admin.query<{ status: string; events: string; debits: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='consumed') AS events,
              (SELECT count(*)::bigint FROM partner_credit_ledger l
                WHERE l.correlation_id=r.id::text AND l.amount=-1) AS debits
         FROM partner_credit_reservations r WHERE r.submission_reference=$1`,
      [source]
    );
    expect(state.rows).toEqual([{ status: "consumed", events: "1", debits: "1" }]);
  });

  it("keeps fulfilment moving through a release-versus-consume race with one terminal accounting fact", async () => {
    await addCredits(1, "g6d-release-consume-race-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-release-consume-race-submit");
    const destinationId = await mapImportedSubmission(source);
    // `paid` is an allowed pre-receipt state for a historical imported row; the two paths now race
    // on the same reservation rather than relying on a status shortcut.
    await admin.query("UPDATE submissions SET status='paid' WHERE id=$1", [destinationId]);

    const results = await Promise.allSettled([
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return"),
      submissions.cancelSubmission(principal(), source, "Concurrent cancellation before receipt."),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const state = await admin.query<{
      status: string;
      terminal_events: string;
      debits: string;
      destination_status: string;
    }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type IN ('consumed','released','expired')) AS terminal_events,
              (SELECT count(*)::bigint FROM partner_credit_ledger l
                WHERE l.correlation_id=r.id::text AND l.amount=-1) AS debits,
              (SELECT status FROM submissions WHERE id=$2) AS destination_status
         FROM partner_credit_reservations r WHERE r.submission_reference=$1`,
      [source, destinationId]
    );
    expect(state.rows[0].terminal_events).toBe("1");
    expect(state.rows[0].status).toMatch(/^(consumed|released)$/);
    expect(state.rows[0].debits).toBe(state.rows[0].status === "consumed" ? "1" : "0");
    if (state.rows[0].status === "released") expect(state.rows[0].destination_status).toBe("paid");
  });

  it("expires due reservations automatically and only once", async () => {
    await addCredits(1, "g6d-expiry-credit");
    const now = new Date();
    const reserved = await creditReservations.reserveCredit(adminActor, {
      tenantId,
      locationId,
      cardReference: `g6d-expiry-card-${++sequence}`,
      expiresAt: new Date(now.getTime() + 1_000),
      idempotencyKey: `g6d-expiry-reserve-${sequence}`,
      source: "system",
      reason: "Expiry scheduler coverage",
      actorType: "system",
      now,
    });
    const first = await creditReservations.expireExpiredReservations({ now: new Date(now.getTime() + 2_000) });
    const retry = await creditReservations.expireExpiredReservations({ now: new Date(now.getTime() + 3_000) });
    expect(first.expired).toContain(reserved.reservation.id);
    expect(retry.expired).not.toContain(reserved.reservation.id);
    const state = await admin.query<{ status: string; events: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='expired') AS events
         FROM partner_credit_reservations r WHERE r.id=$1`,
      [reserved.reservation.id]
    );
    expect(state.rows).toEqual([{ status: "expired", events: "1" }]);
  });

  it("fails closed for an imported Partner submission with no reservation and preserves evidence", async () => {
    const source = await makeDraft();
    await admin.query(
      `INSERT INTO partner_submission_handoffs (tenant_id,submission_id,status,snapshot)
       VALUES ($1,$2,'pending','{}'::jsonb)`,
      [tenantId, source]
    );
    const destinationId = await mapImportedSubmission(source);

    await expect(
      lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return")
    ).rejects.toMatchObject({ code: "credit_settlement_required" });
    const audit = await admin.query<{ n: string }>(
      `SELECT count(*)::bigint n FROM partner_credit_accounting_exceptions
        WHERE reason_code='missing_partner_credit_reservation'
          AND destination_submission_id=$1`,
      [destinationId]
    );
    expect(audit.rows[0].n).toBe("1");
    expect((await admin.query("SELECT status FROM submissions WHERE id=$1", [destinationId])).rows[0].status).toBe(
      "in_grading"
    );
  });

  it("lets the trusted connector release an active credit on pre-grading rejection", async () => {
    await addCredits(1, "g6d-connector-release-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-connector-release-submit");
    const handoff = await admin.query<{ id: string }>(
      "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
      [source]
    );
    const connector = await admin.query<{ id: string }>(
      `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state)
       VALUES ($1,$2,$3,'validating') RETURNING id`,
      [tenantId, source, handoff.rows[0].id]
    );

    const connectorDb = await import("../server/partner/connector-db");
    try {
      const released = await connectorDb.withConnectorTx((client) =>
        lifecycle.releasePartnerReservationForConnectorTerminalState(
          client,
          { id: connector.rows[0].id, tenantId, partnerSubmissionId: source },
          "validation_rejected"
        )
      );
      expect(released).toMatchObject({ outcome: "released" });
      const replay = await connectorDb.withConnectorTx((client) =>
        lifecycle.releasePartnerReservationForConnectorTerminalState(
          client,
          { id: connector.rows[0].id, tenantId, partnerSubmissionId: source },
          "validation_rejected"
        )
      );
      expect(replay).toMatchObject({ outcome: "already_settled", reservationId: released.reservationId });
    } finally {
      await connectorDb.closeConnectorPool();
    }

    const state = await admin.query<{ status: string; releases: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e WHERE e.reservation_id=r.id AND e.event_type='released') AS releases
         FROM partner_credit_reservations r WHERE r.submission_reference=$1`,
      [source]
    );
    expect(state.rows[0]).toEqual({ status: "released", releases: "1" });
  });

  it("releases the reservation in the same connector rejection transition", async () => {
    await addCredits(1, "g6d-connector-transition-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-connector-transition-submit");
    const handoff = await admin.query<{ id: string }>(
      "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
      [source]
    );
    const connector = await admin.query<{ id: string; version: number }>(
      `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state)
       VALUES ($1,$2,$3,'validating') RETURNING id, version`,
      [tenantId, source, handoff.rows[0].id]
    );

    const rejected = await connectorService.transitionConnectorState({
      connectorId: connector.rows[0].id,
      tenantId,
      expectedVersion: connector.rows[0].version,
      toState: "rejected",
      eventType: "validation_rejected",
    });
    expect(rejected.state).toBe("rejected");
    const state = await admin.query<{ status: string; releases: string }>(
      `SELECT r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e WHERE e.reservation_id=r.id AND e.event_type='released') AS releases
         FROM partner_credit_reservations r WHERE r.submission_reference=$1`,
      [source]
    );
    expect(state.rows[0]).toEqual({ status: "released", releases: "1" });
  });

  it("allows a legacy connector terminal transition with no reservation and records that outcome", async () => {
    const source = await makeDraft();
    const handoff = await admin.query<{ id: string }>(
      `INSERT INTO partner_submission_handoffs (tenant_id,submission_id,status,snapshot)
       VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id`,
      [tenantId, source]
    );
    const connector = await admin.query<{ id: string; version: number }>(
      `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state)
       VALUES ($1,$2,$3,'validating') RETURNING id, version`,
      [tenantId, source, handoff.rows[0].id]
    );

    await expect(
      connectorService.transitionConnectorState({
        connectorId: connector.rows[0].id,
        tenantId,
        expectedVersion: connector.rows[0].version,
        toState: "rejected",
        eventType: "legacy_rejection",
      })
    ).resolves.toMatchObject({ state: "rejected" });
    const evidence = await admin.query<{ outcome: string }>(
      `SELECT metadata->'credit_settlement'->>'outcome' AS outcome
         FROM partner_connector_events
        WHERE connector_record_id=$1 AND event_type='legacy_rejection'`,
      [connector.rows[0].id]
    );
    expect(evidence.rows).toEqual([{ outcome: "legacy_no_reservation" }]);
  });

  it("runs permanent-failure acknowledgement through G6D release atomically and exactly once", async () => {
    await addCredits(1, "g6d-permanent-failure-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-permanent-failure-submit");
    const destinationId = await mapImportedSubmission(source);
    await admin.query("UPDATE submissions SET status='paid' WHERE id=$1", [destinationId]);
    const connector = await admin.query<{ id: string; version: number }>(
      `UPDATE partner_connector_records
          SET state='failed'
        WHERE tenant_id=$1 AND partner_submission_id=$2
      RETURNING id, version`,
      [tenantId, source]
    );
    const reconciliation = await import("../server/partner/connector-reconciliation-service");
    await reconciliation.acknowledgePermanentFailure({
      connectorId: connector.rows[0].id,
      actorId: partnerUserId,
      reason: "Permanent upstream import failure confirmed.",
      tenantId,
      expectedVersion: connector.rows[0].version,
    });
    const state = await admin.query<{
      connector_state: string;
      reservation_status: string;
      releases: string;
      holds: string;
    }>(
      `SELECT (SELECT state FROM partner_connector_records WHERE id=$3) AS connector_state,
              r.status AS reservation_status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='released') AS releases,
              (SELECT count(*)::bigint FROM partner_submission_credit_holds h
                WHERE h.destination_submission_id=$4 AND h.released_at IS NULL) AS holds
         FROM partner_credit_reservations r
        WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
      [tenantId, source, connector.rows[0].id, destinationId]
    );
    expect(state.rows).toEqual([
      { connector_state: "cancelled", reservation_status: "released", releases: "1", holds: "1" },
    ]);
    await expect(
      reconciliation.acknowledgePermanentFailure({
        connectorId: connector.rows[0].id,
        actorId: partnerUserId,
        reason: "Retry acknowledgement.",
        tenantId,
        expectedVersion: connector.rows[0].version + 1,
      })
    ).rejects.toMatchObject({ code: "invalid_state_transition" });
  });

  it("denies direct connector credit reads, mutations, terminal evidence and early expiry", async () => {
    await addCredits(1, "g6d-direct-denial-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-direct-denial-submit");
    const reservation = await admin.query<{ id: string; wallet_id: string }>(
      `SELECT id, wallet_id FROM partner_credit_reservations WHERE tenant_id=$1 AND submission_reference=$2`,
      [tenantId, source]
    );
    const connectorDb = await import("../server/partner/connector-db");
    await expect(
      connectorDb.withConnectorTx((client) => client.query("SELECT * FROM partner_credit_reservations LIMIT 1"))
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connectorDb.withConnectorTx((client) =>
        client.query(
          "UPDATE partner_credit_reservations SET status='expired', expired_at=now(), updated_at=now() WHERE id=$1",
          [reservation.rows[0].id]
        )
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connectorDb.withConnectorTx((client) =>
        client.query(
          `INSERT INTO partner_credit_reservation_events
             (reservation_id,wallet_id,tenant_id,event_type,amount,idempotency_key,request_fingerprint,source,reason,actor_type)
           VALUES ($1,$2,$3,'consumed',1,'g6d-forged-consumed',$4,'connector','forged evidence','system')`,
          [reservation.rows[0].id, reservation.rows[0].wallet_id, tenantId, "f".repeat(64)]
        )
      )
    ).rejects.toMatchObject({ code: "42501" });
    const state = await admin.query<{ status: string; terminal_events: string }>(
      `SELECT status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type IN ('consumed','released','expired')) AS terminal_events
         FROM partner_credit_reservations r WHERE id=$1`,
      [reservation.rows[0].id]
    );
    expect(state.rows).toEqual([{ status: "active", terminal_events: "0" }]);
  });

  it("runs validation-terminal and reconciliation-terminal release paths through the G6D definer", async () => {
    await addCredits(2, "g6d-validation-reconciliation-credit");

    const validationSource = await makeDraft();
    await submitDraft(validationSource, "g6d-validation-terminal-submit");
    const validationHandoff = await admin.query<{ id: string }>(
      "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
      [validationSource]
    );
    const validationConnector = await admin.query<{ id: string; version: number }>(
      `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state,claimed_by,attempt_count)
       VALUES ($1,$2,$3,'validating','g6d-worker',1) RETURNING id, version`,
      [tenantId, validationSource, validationHandoff.rows[0].id]
    );
    const validation = await import("../server/partner/connector-validation-service");
    const validationResult = await validation.validateConnectorRecord({
      connectorId: validationConnector.rows[0].id,
      claimant: "g6d-worker",
      expectedVersion: validationConnector.rows[0].version,
      tenantId,
    });
    expect(validationResult.outcome).toBe("invalid");

    const reconciliationSource = await makeDraft();
    await submitDraft(reconciliationSource, "g6d-reconciliation-terminal-submit");
    const reconciliationHandoff = await admin.query<{ id: string }>(
      "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
      [reconciliationSource]
    );
    const reconciliationConnector = await admin.query<{ id: string; version: number }>(
      `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state,attempt_count)
       VALUES ($1,$2,$3,'manual_review',1) RETURNING id, version`,
      [tenantId, reconciliationSource, reconciliationHandoff.rows[0].id]
    );
    const reconciliation = await import("../server/partner/connector-reconciliation-service");
    await reconciliation.resolveManualReview({
      connectorId: reconciliationConnector.rows[0].id,
      actorId: "g6d-operator",
      reason: "G6D terminal cancellation coverage.",
      resolution: "cancel",
      tenantId,
      expectedVersion: reconciliationConnector.rows[0].version,
    });
    const terminalStates = await admin.query<{ submission_reference: string; status: string; terminal_events: string }>(
      `SELECT r.submission_reference, r.status,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='released') AS terminal_events
         FROM partner_credit_reservations r
        WHERE r.submission_reference = ANY($1::text[])
        ORDER BY r.submission_reference`,
      [[validationSource, reconciliationSource]]
    );
    expect(terminalStates.rows).toEqual(
      [
        { submission_reference: validationSource, status: "released", terminal_events: "1" },
        { submission_reference: reconciliationSource, status: "released", terminal_events: "1" },
      ].sort((a, b) => a.submission_reference.localeCompare(b.submission_reference))
    );
  });

  it("treats reconciliation-required and soft-deleted mappings as Partner evidence, never generic submissions", async () => {
    for (const mode of ["reconciliation_required", "soft_deleted"] as const) {
      await addCredits(1, `g6d-mapping-${mode}-credit`);
      const source = await makeDraft();
      await submitDraft(source, `g6d-mapping-${mode}-submit`);
      const destinationId = await mapImportedSubmission(source);
      if (mode === "reconciliation_required") {
        await admin.query(
          "UPDATE partner_connector_imports SET state='reconciliation_required' WHERE destination_submission_id=$1",
          [destinationId]
        );
      } else {
        await admin.query("UPDATE partner_connector_imports SET deleted_at=now() WHERE destination_submission_id=$1", [
          destinationId,
        ]);
      }
      await expect(
        lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "ready_to_return")
      ).rejects.toMatchObject({ code: "credit_settlement_required" });
      const evidence = await admin.query<{ status: string; destination_status: string; exceptions: string }>(
        `SELECT r.status,
                (SELECT status FROM submissions WHERE id=$3) AS destination_status,
                (SELECT count(*)::bigint FROM partner_credit_accounting_exceptions e
                  WHERE e.destination_submission_id=$3
                    AND e.reason_code=$4) AS exceptions
           FROM partner_credit_reservations r
          WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
        [
          tenantId,
          source,
          destinationId,
          mode === "reconciliation_required" ? "partner_mapping_not_completed" : "partner_mapping_deleted",
        ]
      );
      expect(evidence.rows).toEqual([{ status: "active", destination_status: "in_grading", exceptions: "1" }]);
    }
  });

  it("never refunds an active reservation for received-or-later soft-deleted destinations", async () => {
    for (const physicalStatus of ["received", "in_grading", "ready_to_return"]) {
      await addCredits(1, `g6d-soft-deleted-${physicalStatus}-credit`);
      const source = await makeDraft();
      await submitDraft(source, `g6d-soft-deleted-${physicalStatus}-submit`);
      const destinationId = await mapImportedSubmission(source);
      await admin.query("UPDATE submissions SET status=$1, deleted_at=now() WHERE id=$2", [
        physicalStatus,
        destinationId,
      ]);
      const before = await admin.query<{ ledger_rows: string; terminal_events: string }>(
        `SELECT (SELECT count(*)::bigint FROM partner_credit_ledger l WHERE l.tenant_id=$1) AS ledger_rows,
                (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                  JOIN partner_credit_reservations r ON r.id=e.reservation_id
                 WHERE r.submission_reference=$2 AND e.event_type IN ('consumed','released','expired')) AS terminal_events`,
        [tenantId, source]
      );
      await expect(
        submissions.cancelSubmission(principal(), source, "Physical receipt requires reconciliation.")
      ).rejects.toMatchObject({
        code: "credit_settlement_required",
      });
      const after = await admin.query<{ status: string; ledger_rows: string; terminal_events: string }>(
        `SELECT r.status,
                (SELECT count(*)::bigint FROM partner_credit_ledger l WHERE l.tenant_id=$1) AS ledger_rows,
                (SELECT count(*)::bigint FROM partner_credit_reservation_events e
                  WHERE e.reservation_id=r.id AND e.event_type IN ('consumed','released','expired')) AS terminal_events
           FROM partner_credit_reservations r WHERE r.tenant_id=$1 AND r.submission_reference=$2`,
        [tenantId, source]
      );
      expect(after.rows).toEqual([{ status: "active", ...before.rows[0] }]);
    }
  });

  it("writes immutable evidence when a connector terminal release is blocked", async () => {
    await addCredits(1, "g6d-terminal-blocked-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-terminal-blocked-submit");
    const destinationId = await mapImportedSubmission(source);
    await admin.query(
      "UPDATE partner_connector_records SET state='reconciliation_required' WHERE partner_submission_id=$1",
      [source]
    );
    await admin.query(
      "UPDATE partner_connector_imports SET state='reconciliation_required' WHERE destination_submission_id=$1",
      [destinationId]
    );
    const connector = await admin.query<{ id: string; version: number }>(
      "SELECT id, version FROM partner_connector_records WHERE partner_submission_id=$1",
      [source]
    );
    await expect(
      connectorService.transitionConnectorState({
        connectorId: connector.rows[0].id,
        tenantId,
        expectedVersion: connector.rows[0].version,
        toState: "cancelled",
        eventType: "blocked_credit_cancel",
      })
    ).rejects.toMatchObject({ code: "credit_lifecycle_invariant" });
    const evidence = await admin.query<{ id: string; event_type: string; reason_code: string }>(
      `SELECT id, event_type, reason_code FROM partner_credit_accounting_exceptions
        WHERE connector_record_id=$1 AND event_type='connector_terminal_blocked'`,
      [connector.rows[0].id]
    );
    expect(evidence.rows).toEqual([
      { id: expect.any(String), event_type: "connector_terminal_blocked", reason_code: "credit_lifecycle_invariant" },
    ]);
    await expect(
      admin.query("UPDATE partner_credit_accounting_exceptions SET reason_code='tampered' WHERE id=$1", [
        evidence.rows[0].id,
      ])
    ).rejects.toMatchObject({ code: "23001" });
    await expect(
      admin.query("DELETE FROM partner_credit_accounting_exceptions WHERE id=$1", [evidence.rows[0].id])
    ).rejects.toMatchObject({
      code: "23001",
    });
  });

  it("blocks admin step-back for every Partner mapping state before any submission or audit write", async () => {
    await addCredits(1, "g6d-step-back-credit");
    const source = await makeDraft();
    await submitDraft(source, "g6d-step-back-submit");
    const destinationId = await mapImportedSubmission(source);
    await admin.query(
      "UPDATE submissions SET status='completed', completed_at=now(), status_history='[]'::jsonb WHERE id=$1",
      [destinationId]
    );
    await admin.query(
      "UPDATE partner_connector_imports SET state='reconciliation_required' WHERE destination_submission_id=$1",
      [destinationId]
    );
    const tracking = (
      await admin.query<{ tracking_number: string }>("SELECT tracking_number FROM submissions WHERE id=$1", [
        destinationId,
      ])
    ).rows[0].tracking_number;
    const before = await admin.query<{ status: string; completed_at: string | null; audit_rows: string }>(
      `SELECT status, completed_at,
              (SELECT count(*)::bigint FROM audit_log WHERE entity_id=$2 AND action='submission_status_step_back') AS audit_rows
         FROM submissions WHERE id=$1`,
      [destinationId, tracking]
    );

    type StepBackHandler = (
      req: { params: { id: string }; session: { adminEmail: string } },
      res: StepBackResponse
    ) => Promise<void>;
    interface StepBackResponse {
      statusCode?: number;
      body?: unknown;
      status: (code: number) => StepBackResponse;
      json: (body: unknown) => void;
    }
    let stepBackHandler: StepBackHandler | undefined;
    const captureApp = {
      get: () => undefined,
      post: (path: string, ...handlers: unknown[]) => {
        if (path === "/api/admin/submissions/:id/step-back") stepBackHandler = handlers.at(-1) as StepBackHandler;
      },
      put: () => undefined,
      patch: () => undefined,
      delete: () => undefined,
    } as unknown as Express;
    const storageModule = await import("../server/storage");
    const dbModule = await import("../server/db");
    const originalLookup = storageModule.storage.getSubmissionBySubmissionId;
    const dbWithExecute = dbModule.db as unknown as {
      execute: (query: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
    const originalExecute = dbWithExecute.execute;
    storageModule.storage.getSubmissionBySubmissionId = async () => ({
      id: String(destinationId),
      submissionId: tracking,
      status: "completed",
    });
    let mappingReads = 0;
    dbWithExecute.execute = async () => {
      mappingReads += 1;
      return mappingReads === 1 ? { rows: [{ relation: "partner_connector_imports" }] } : { rows: [{ matched: 1 }] };
    };
    const { registerAdminSubmissionRoutes } = await import("../server/routes/admin-submissions");
    registerAdminSubmissionRoutes(captureApp);
    expect(stepBackHandler).toBeTypeOf("function");
    const response: StepBackResponse = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
      },
    };
    try {
      await stepBackHandler!({ params: { id: tracking }, session: { adminEmail: "g6d-admin@example.com" } }, response);
    } finally {
      storageModule.storage.getSubmissionBySubmissionId = originalLookup;
      dbWithExecute.execute = originalExecute;
    }
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: "partner_credit_lifecycle_conflict" });
    expect(mappingReads).toBe(2);
    const after = await admin.query<{ status: string; completed_at: string | null; audit_rows: string }>(
      `SELECT status, completed_at,
              (SELECT count(*)::bigint FROM audit_log WHERE entity_id=$2 AND action='submission_status_step_back') AS audit_rows
         FROM submissions WHERE id=$1`,
      [destinationId, tracking]
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("rolls back only the connector release capability and preserves immutable accounting evidence", async () => {
    const rollback = readFileSync("migrations/rollback-partner-submission-credit-lifecycle.sql", "utf8");
    const activeHolds = await admin.query<{ tenant_id: string; partner_submission_id: string }>(
      `SELECT tenant_id, partner_submission_id
         FROM partner_submission_credit_holds
        WHERE released_at IS NULL
        ORDER BY created_at, id`
    );
    for (const hold of activeHolds.rows) {
      await lifecycle.recoverPartnerDestinationCreditHold({
        tenantId: hold.tenant_id,
        partnerSubmissionId: hold.partner_submission_id,
        actorUserId: partnerUserId,
        actorEmail: adminActor.actorEmail,
        idempotencyKey: `g6d-rollback-recovery-${++sequence}`,
        reason: "Controlled recovery before owner-approved G6D rollback.",
      });
    }
    const before = await admin.query<{ exceptions: string; events: string }>(
      `SELECT (SELECT count(*)::bigint FROM partner_credit_accounting_exceptions) AS exceptions,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events) AS events`
    );
    await admin.query(rollback);
    await admin.query(rollback); // absent function is deliberately a safe no-op
    const after = await admin.query<{
      exceptions: string;
      events: string;
      release_function: string | null;
      hold_guard: string | null;
      lifecycle_role: string | null;
      membership_count: string;
    }>(
      `SELECT (SELECT count(*)::bigint FROM partner_credit_accounting_exceptions) AS exceptions,
              (SELECT count(*)::bigint FROM partner_credit_reservation_events) AS events,
              to_regprocedure('public.partner_connector_release_submission_credit(uuid,uuid,uuid,text)')::text AS release_function,
              to_regprocedure('public.partner_destination_credit_hold_guard()')::text AS hold_guard,
              (SELECT rolname FROM pg_roles WHERE rolname='partner_credit_lifecycle_definer') AS lifecycle_role,
              (SELECT count(*)::bigint FROM pg_auth_members membership
                JOIN pg_roles role ON role.oid=membership.roleid
                WHERE role.rolname='partner_credit_lifecycle_definer') AS membership_count`
    );
    expect(after.rows).toEqual([
      { ...before.rows[0], release_function: null, hold_guard: null, lifecycle_role: null, membership_count: "0" },
    ]);
  });
});
