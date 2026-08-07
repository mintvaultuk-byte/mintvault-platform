/**
 * Partner Network RLS tenant-isolation proof — TWO independent suites in one file.
 *
 * MAIN RECONCILIATION, 2026-08-03. Both sides of the psp/partner-rbac-hybrid <- origin/main merge
 * rewrote this file wholesale from a common 175-line ancestor, and their harnesses are mutually
 * exclusive, so this file deliberately keeps BOTH rather than choosing:
 *
 *   - transaction model: suite 1 wraps every claim in BEGIN/ROLLBACK; suite 2's tests verify
 *     PERSISTED victim state after the attack and therefore must not be rolled back.
 *   - GUC locality: suite 1 sets app.tenant_id transaction-locally (`true`) and proves it does not
 *     leak; suite 2's generic-plan-cache test REQUIRES session-local (`false`).
 *   - fixtures: suite 2 asserts exact row counts (e.g. 2 organisations) that suite 1's extra
 *     seeded tenants would break.
 *
 * They are kept apart by running on SEPARATE DATABASES — suite 1 provisions its own disposable
 * PostgreSQL 17 cluster, suite 2 uses PARTNER_RLS_DB — so neither fixtures nor session GUCs can
 * cross between them. Nothing from either side was dropped.
 *
 * ============================== SUITE 1 (psp/partner-rbac-hybrid) ==============================
 * GENUINE RLS proof on a self-provisioned cluster, covering the MONEY path.
 *
 * WHAT WAS WRONG WITH THE PREVIOUS VERSION
 * ----------------------------------------
 * It applied only migration 0001, so it proved isolation for partner_locations,
 * partner_organisations, partner_feature_flags and partner_audit_events — and NOTHING in the
 * money path. Wallets, the credit ledger, reservations, reservation events, partner submissions
 * and credit holds were entirely unproven. It also made its isolation claims without ever
 * asserting the conditions those claims depend on:
 *
 *   - it connected as the SUPERUSER and relied on `SET ROLE partner_runtime`. That does work, but
 *     nothing checked it. Drop the SET ROLE (or run as a BYPASSRLS role) and every assertion below
 *     still "passes" while proving nothing at all, because a superuser sees all rows.
 *   - it set the tenant GUC with `set_config(..., false)` — SESSION-local. A leaked session GUC
 *     silently carries a tenant identity across tests. Production sets it transaction-locally.
 *   - "tenant A cannot see B" was asserted by counting rows, which is indistinguishable from a
 *     query that simply matched nothing.
 *
 * A manual `WHERE tenant_id = ...` filter is NOT an RLS proof. Every read query below is
 * deliberately written WITHOUT a tenant predicate: if RLS is doing the work, the row is invisible;
 * if RLS is not doing the work, the row appears and the test fails.
 *
 * HARNESS INTEGRITY (fail-loud): before any isolation claim, assertRlsHarness() proves the acting
 * role is NOT a superuser, does NOT hold BYPASSRLS, that FORCE ROW LEVEL SECURITY is active on the
 * table in question, and that a tenant context is actually set. RLS2 (running the proof as a
 * superuser) must produce an explicit harness failure, not a green run.
 *
 * MUTATION TARGETS: RLS1 (drop a tenant policy) and RLS2 (run as superuser) must both turn this red.
 *
 * ==================================== SUITE 2 (origin/main) ====================================
 * Adversarial tenant-boundary attack suite, run against PARTNER_RLS_DB.
 *
 * Runs ONLY when PARTNER_RLS_DB points at a DISPOSABLE local Postgres (host must be
 * 127.0.0.1/localhost — a guard refuses anything else). CI sets it (see .github/workflows/ci.yml)
 * and the "is not silently skipped in CI" guard below turns an unset variable into a RED build
 * rather than a silent skip. scripts/ci/assert-partner-rls-suite-executed.mjs additionally asserts
 * EXECUTION, so hard-skipping the gate cannot quietly delete the evidence either.
 *
 * WHY THIS SUITE IS LOAD-BEARING. On staging the partner RUNTIME role (partner_app_staging) has
 * rolbypassrls = FALSE while the ADMIN role (neondb_owner) has rolbypassrls = TRUE — verified
 * 2026-07-31. RLS therefore genuinely binds in production shape, and this suite is the only place
 * the boundary is adversarially attacked rather than assumed. It mirrors that shape: every
 * attack runs as `partner_runtime`, which is NOLOGIN/NOSUPERUSER/NOBYPASSRLS, and its first test
 * asserts exactly that so the suite can never degrade into a superuser no-op.
 *
 * SCOPE. It applies the partner migration chain that produces the tables the PILOT ACTUALLY USES —
 * 0001 (foundation), 0007 (customers/submissions/cards/events/handoffs), 0016 (wallets + credit
 * ledger) and 0017 (credit reservations) — then proves, as the restricted role, that tenant A
 * cannot read, update, delete, insert-as, or tenant-hop into tenant B on ANY of them; that the
 * money tables are not writable by the runtime at all; that the reporting VIEWS do not leak across
 * tenants; that missing/empty/malformed context fails closed; that the boundary survives generic
 * plan caching; that the role cannot read an existing MintVault table; and that the superuser
 * (super-admin) is unaffected.
 *
 * Reproduce locally:
 *   (create a throwaway PG 17, e.g. on 127.0.0.1:55433/mintvault_partner_rls)
 *   PARTNER_RLS_DB=postgres://postgres:postgres@127.0.0.1:55433/mintvault_partner_rls \
 *     npx vitest run tests/partner-rls-isolation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
let cluster: DisposablePostgres17;
let admin: Client; // superuser — provisioning ONLY, never used for an isolation claim
let runtime: Client; // the restricted partner runtime login — every claim is made through this
let connectorRuntime: Client; // restricted connector login for INSERT/WITH CHECK claims

const RUNTIME_LOGIN = "partner_rls_runtime";
const RUNTIME_PASSWORD = "synthetic"; // disposable cluster only
const CONNECTOR_LOGIN = "partner_rls_connector";
const CONNECTOR_PASSWORD = "synthetic"; // disposable cluster only

interface Tenant {
  id: string;
  locationId: string;
  userId: string;
  walletId: string;
  submissionId: string;
  gradingWorkItemId: string;
  destinationSubmissionId: number;
  reservationId: string;
}

let A: Tenant;
let B: Tenant;

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz, grading_status varchar(30),
    assigned_grader_id varchar, scan_status varchar(30), scan_assigned_to varchar,
    shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
    return_tracking text, return_carrier text, return_service text,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  // The MintVault table the restricted role must never be able to read.
  await admin.query(`CREATE TABLE certificates (
    id serial primary key,
    certificate_number text,
    cert_id text,
    submission_id integer,
    submission_item_id integer,
    status text,
    label_type text,
    grade_type text,
    language text,
    card_game text,
    set_name text,
    card_name text,
    card_number_display text,
    year_text text,
    variant text,
    front_image_path text,
    back_image_path text,
    grading_front_original text,
    grading_back_original text,
    created_by text,
    issued_at timestamptz,
    updated_at timestamptz,
    reference_number text,
    logbook_version integer,
    logbook_last_issued_at timestamptz,
    integrity_hash text,
    print_state text,
    grader_status text,
    origin_type text,
    origin_partner_id uuid,
    origin_partner_public_ref text,
    origin_partner_legal_name text,
    origin_partner_trading_name text,
    origin_location_id uuid,
    origin_location_public_ref text,
    origin_location_name text,
    origin_location_address text,
    origin_captured_at timestamptz,
    origin_snapshot_version integer,
    secret text
  )`);
  await admin.query("INSERT INTO certificates (certificate_number, cert_id, secret) VALUES ('MV1','MV1','MV-DATA')");
  await admin.query("CREATE TABLE label_prints (id serial primary key, certificate_id integer)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/** Provision one fully-populated tenant: org, location, user, wallet, ledger, submission, reservation. */
async function seedTenant(label: string): Promise<Tenant> {
  const id = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name,status) VALUES ($1,'ACTIVE') RETURNING id",
      [`RLS ${label}`]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
      [id, `Shop ${label}`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref,tenant_id,partner_id,email,password_hash,status,mfa_required)
       VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
      [`rls-${label}`, id, `rls-${label}@example.test`]
    )
  ).rows[0].id;
  const walletId = (
    await admin.query<{ id: string }>("INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id", [id])
  ).rows[0].id;
  const fund = `rls-fund-${label}`;
  await admin.query(
    `INSERT INTO partner_credit_ledger
       (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
     VALUES ($1,$2,100,'purchase',$3,'admin',$4,'admin',md5($3)||md5($3||':f'))`,
    [walletId, id, fund, `RLS ${label} funding`]
  );
  const submissionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
       VALUES ($1,$2,$3,1,'draft') RETURNING id`,
      [id, locationId, userId]
    )
  ).rows[0].id;
  const key = `rls-res-${label}`;
  const reservationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_credit_reservations
         (wallet_id, tenant_id, location_id, card_reference, submission_reference, reserved_credits,
          status, idempotency_key, request_fingerprint, source, reason, actor_type, expires_at)
       VALUES ($1,$2,$3,'card-1',$4,1,'active',$5,md5($5)||md5($5||':f'),'portal','rls fixture','admin',
               now() + interval '365 days')
       RETURNING id`,
      [walletId, id, locationId, submissionId, key]
    )
  ).rows[0].id;
  const cardId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submission_cards
         (tenant_id, submission_id, sequence_number, card_name, quantity, front_image_key, back_image_key)
       VALUES ($1,$2,1,$3,1,'pending','pending')
       RETURNING id`,
      [id, submissionId, `Bridge Card ${label}`]
    )
  ).rows[0].id;
  await admin.query(
    `UPDATE partner_submission_cards
        SET front_image_key = $1,
            back_image_key = $2
      WHERE id = $3`,
    [
      `partner-submissions/${id}/${submissionId}/${cardId}/front-rls.jpg`,
      `partner-submissions/${id}/${submissionId}/${cardId}/back-rls.jpg`,
      cardId,
    ]
  );
  const handoffId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
      [id, submissionId]
    )
  ).rows[0].id;
  const connectorId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_connector_records (tenant_id, partner_submission_id, handoff_id, state) VALUES ($1,$2,$3,'imported') RETURNING id",
      [id, submissionId, handoffId]
    )
  ).rows[0].id;
  const validationRunId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_connector_validation_runs
         (connector_record_id, validation_attempt, source_submission_version, source_handoff_status, outcome, source_fingerprint, source_fingerprint_version, completed_at)
       VALUES ($1,1,1,'pending','valid',md5($2)||md5($2||':f'),1,now())
       RETURNING id`,
      [connectorId, `bridge-${label}`]
    )
  ).rows[0].id;
  const destinationSubmissionId = (
    await admin.query<{ id: number }>(
      "INSERT INTO submissions (user_id, status, tracking_number) VALUES ($1,'grading',$2) RETURNING id",
      [userId, `MV-RLS-${label}`]
    )
  ).rows[0].id;
  const submissionItemId = (
    await admin.query<{ id: number }>("INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id", [
      destinationSubmissionId,
    ])
  ).rows[0].id;
  const importId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_connector_imports
         (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
          validation_run_id, destination_submission_id, source_fingerprint, source_fingerprint_version, state, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,md5($8)||md5($8||':f'),1,'completed',now())
       RETURNING id`,
      [
        connectorId,
        id,
        locationId,
        submissionId,
        handoffId,
        validationRunId,
        destinationSubmissionId,
        `import-${label}`,
      ]
    )
  ).rows[0].id;
  const gradingWorkItemId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_grading_work_items
         (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_submission_card_id,
          partner_handoff_id, connector_import_id, connector_record_id, validation_run_id,
          destination_submission_id, submission_item_id, card_ordinal, front_image_key, back_image_key,
          source_fingerprint, source_fingerprint_version)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,md5($13)||md5($13||':f'),1)
       RETURNING id`,
      [
        id,
        locationId,
        submissionId,
        cardId,
        handoffId,
        importId,
        connectorId,
        validationRunId,
        destinationSubmissionId,
        submissionItemId,
        `partner-submissions/${id}/${submissionId}/${cardId}/front-rls.jpg`,
        `partner-submissions/${id}/${submissionId}/${cardId}/back-rls.jpg`,
        `work-${label}`,
      ]
    )
  ).rows[0].id;
  return { id, locationId, userId, walletId, submissionId, gradingWorkItemId, destinationSubmissionId, reservationId };
}

/**
 * FAIL-LOUD HARNESS ASSERTIONS. Every isolation claim in this file is only meaningful if all of
 * these hold. They are checked inside the same transaction the claim is made in.
 */
async function assertRlsHarness(client: Client, table: string, expectTenant: string): Promise<void> {
  const r = await client.query<{
    rolname: string;
    is_super: boolean;
    bypassrls: boolean;
    forced: boolean;
    rls_enabled: boolean;
    tenant: string | null;
    policies: number;
  }>(
    `SELECT current_user AS rolname,
            (SELECT rolsuper      FROM pg_roles WHERE rolname = current_user) AS is_super,
            (SELECT rolbypassrls  FROM pg_roles WHERE rolname = current_user) AS bypassrls,
            c.relforcerowsecurity AS forced,
            c.relrowsecurity      AS rls_enabled,
            NULLIF(current_setting('app.tenant_id', true), '') AS tenant,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = 'public'`,
    [table]
  );
  expect(r.rowCount, `table ${table} must exist`).toBe(1);
  const h = r.rows[0];
  // RLS2: running this proof as a superuser must fail HERE, explicitly, not pass silently.
  expect(h.is_super, `RLS proof is running as SUPERUSER '${h.rolname}' — every isolation claim would be vacuous`).toBe(
    false
  );
  expect(h.bypassrls, `RLS proof role '${h.rolname}' holds BYPASSRLS — every isolation claim would be vacuous`).toBe(
    false
  );
  // Pin the ACTING role, not merely "some unprivileged role": dropping the SET ROLE would
  // otherwise leave the proof running as the outer login, which does not exist in production.
  expect(h.rolname, "isolation claims must be made as partner_runtime").toBe("partner_runtime");
  expect(h.rls_enabled, `${table} must have ROW LEVEL SECURITY enabled`).toBe(true);
  // FORCE matters independently: without it the table OWNER is exempt from its own policies.
  expect(h.forced, `${table} must have FORCE ROW LEVEL SECURITY`).toBe(true);
  expect(h.policies, `${table} must carry at least one policy`).toBeGreaterThan(0);
  expect(h.tenant, "tenant context must be set for this claim").toBe(expectTenant);
}

async function assertConnectorRlsHarness(client: Client, table: string, expectTenant: string): Promise<void> {
  const r = await client.query<{
    rolname: string;
    is_super: boolean;
    bypassrls: boolean;
    rls_enabled: boolean;
    forced: boolean;
    policies: number;
    tenant: string | null;
  }>(
    `SELECT current_user AS rolname,
            (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS is_super,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS forced,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
            NULLIF(current_setting('app.tenant_id', true),'') AS tenant
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname=$1`,
    [table]
  );
  expect(r.rowCount, `table ${table} must exist`).toBe(1);
  const h = r.rows[0];
  expect(h.is_super, `connector RLS proof is running as SUPERUSER '${h.rolname}'`).toBe(false);
  expect(h.bypassrls, `connector RLS proof role '${h.rolname}' holds BYPASSRLS`).toBe(false);
  expect(h.rolname, "connector claims must be made as partner_connector_runtime").toBe("partner_connector_runtime");
  expect(h.rls_enabled, `${table} must have ROW LEVEL SECURITY enabled`).toBe(true);
  expect(h.forced, `${table} must have FORCE ROW LEVEL SECURITY`).toBe(true);
  expect(h.policies, `${table} must carry at least one policy`).toBeGreaterThan(0);
  expect(h.tenant, "tenant context must be set for this connector claim").toBe(expectTenant);
}

/**
 * Attempt a cross-tenant write and report HOW it was refused.
 *
 * Two mechanisms defend the money path and both are legitimate; conflating them would overstate
 * what RLS alone proves, so this reports which one fired:
 *   "denied"  — partner_runtime holds no such grant on the table (privilege absence).
 *   "no_rows" — the grant exists and RLS made the target row invisible to the statement.
 * The security property under test is that the write is refused AND the victim row is unchanged;
 * the mechanism is recorded so the assertion stays honest about which layer did the work.
 *
 * Each attempt runs inside its own SAVEPOINT: a failed statement aborts the enclosing transaction,
 * so without this the first expected failure would poison every later assertion in the same block.
 */
async function attemptWrite(
  sql: string,
  params: unknown[]
): Promise<{ refusal: "denied" | "no_rows" | "APPLIED"; rowCount: number; sqlstate: string; message: string }> {
  await runtime.query("SAVEPOINT attempt");
  try {
    const r = await runtime.query(sql, params);
    await runtime.query("RELEASE SAVEPOINT attempt");
    return {
      refusal: (r.rowCount ?? 0) === 0 ? "no_rows" : "APPLIED",
      rowCount: r.rowCount ?? 0,
      sqlstate: "",
      message: "",
    };
  } catch (err) {
    await runtime.query("ROLLBACK TO SAVEPOINT attempt");
    await runtime.query("RELEASE SAVEPOINT attempt");
    // The SQLSTATE is returned so a test can require the SPECIFIC refusal it claims. A bare
    // "denied" would also be produced by a typo, an FK violation or a unique collision, which
    // would leave the test green while proving nothing about isolation.
    const e = err as { code?: string; message?: string };
    return { refusal: "denied", rowCount: 0, sqlstate: e.code ?? "", message: e.message ?? "" };
  }
}

async function attemptConnectorWrite(
  sql: string,
  params: unknown[]
): Promise<{ refusal: "denied" | "no_rows" | "APPLIED"; rowCount: number; sqlstate: string; message: string }> {
  await connectorRuntime.query("SAVEPOINT attempt");
  try {
    const r = await connectorRuntime.query(sql, params);
    await connectorRuntime.query("RELEASE SAVEPOINT attempt");
    return {
      refusal: (r.rowCount ?? 0) === 0 ? "no_rows" : "APPLIED",
      rowCount: r.rowCount ?? 0,
      sqlstate: "",
      message: "",
    };
  } catch (err) {
    await connectorRuntime.query("ROLLBACK TO SAVEPOINT attempt");
    await connectorRuntime.query("RELEASE SAVEPOINT attempt");
    const e = err as { code?: string; message?: string };
    return { refusal: "denied", rowCount: 0, sqlstate: e.code ?? "", message: e.message ?? "" };
  }
}

/**
 * Run `fn` as partner_runtime with a TRANSACTION-LOCAL tenant context, exactly as production does.
 * The transaction is always rolled back, so no test can leak state or a GUC into another.
 */
async function asTenant(tenant: string | null, fn: () => Promise<void>): Promise<void> {
  await runtime.query("BEGIN");
  try {
    await runtime.query("SET ROLE partner_runtime");
    // `true` = transaction-local. The previous suite used `false` (session-local), which lets a
    // tenant identity survive past the test that set it.
    if (tenant !== null) await runtime.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await fn();
  } finally {
    await runtime.query("ROLLBACK").catch(() => {});
    await runtime.query("RESET ROLE").catch(() => {});
  }
}

async function asConnectorTenant(tenant: string | null, fn: () => Promise<void>): Promise<void> {
  await connectorRuntime.query("BEGIN");
  try {
    await connectorRuntime.query("SET ROLE partner_connector_runtime");
    if (tenant !== null) await connectorRuntime.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await fn();
  } finally {
    await connectorRuntime.query("ROLLBACK").catch(() => {});
    await connectorRuntime.query("RESET ROLE").catch(() => {});
  }
}

async function nextDestinationItem(tenant: Tenant): Promise<number> {
  return (
    await admin.query<{ id: number }>("INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id", [
      tenant.destinationSubmissionId,
    ])
  ).rows[0].id;
}

async function workItemInsertParams(tenant: Tenant, submissionItemId: number, ordinal: number) {
  const row = (
    await admin.query<{
      tenant_id: string;
      partner_location_id: string;
      partner_submission_id: string;
      partner_submission_card_id: string;
      partner_handoff_id: string;
      connector_import_id: string;
      connector_record_id: string;
      validation_run_id: string;
      destination_submission_id: number;
      front_image_key: string;
      back_image_key: string;
    }>(
      `SELECT tenant_id, partner_location_id, partner_submission_id, partner_submission_card_id,
              partner_handoff_id, connector_import_id, connector_record_id, validation_run_id,
              destination_submission_id, front_image_key, back_image_key
         FROM partner_grading_work_items
        WHERE id=$1`,
      [tenant.gradingWorkItemId]
    )
  ).rows[0];
  return [
    row.tenant_id,
    row.partner_location_id,
    row.partner_submission_id,
    row.partner_submission_card_id,
    row.partner_handoff_id,
    row.connector_import_id,
    row.connector_record_id,
    row.validation_run_id,
    row.destination_submission_id,
    submissionItemId,
    ordinal,
    row.front_image_key.replace(/front-[^/]+$/, `front-connector-${ordinal}.jpg`),
    row.back_image_key.replace(/back-[^/]+$/, `back-connector-${ordinal}.jpg`),
    `connector-insert-${row.tenant_id}-${ordinal}`,
  ];
}

describe("Partner RLS tenant isolation (real PostgreSQL, restricted runtime role)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-rls-isolation");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);

    await admin.query(`DO $$ BEGIN
        CREATE ROLE ${RUNTIME_LOGIN} LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query(`GRANT partner_runtime TO ${RUNTIME_LOGIN}`);
    await admin.query(`DO $$ BEGIN
        CREATE ROLE ${CONNECTOR_LOGIN} LOGIN PASSWORD '${CONNECTOR_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query(`GRANT partner_connector_runtime TO ${CONNECTOR_LOGIN}`);

    A = await seedTenant("A");
    B = await seedTenant("B");

    const url = new URL(cluster.url);
    url.username = RUNTIME_LOGIN;
    url.password = RUNTIME_PASSWORD;
    runtime = new Client({ connectionString: url.toString() });
    await runtime.connect();
    const connectorUrl = new URL(cluster.url);
    connectorUrl.username = CONNECTOR_LOGIN;
    connectorUrl.password = CONNECTOR_PASSWORD;
    connectorRuntime = new Client({ connectionString: connectorUrl.toString() });
    await connectorRuntime.connect();
  }, 120_000);

  afterAll(async () => {
    await connectorRuntime?.end().catch(() => {});
    await runtime?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // ------------------------------------------------------------------ harness integrity
  describe("harness integrity", () => {
    it("the acting role is partner_runtime, NOSUPERUSER and NOBYPASSRLS", async () => {
      await asTenant(A.id, async () => {
        const r = await runtime.query<{ rolname: string; s: boolean; b: boolean }>(
          `SELECT current_user AS rolname,
                  (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS s,
                  (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b`
        );
        expect(
          r.rows[0].s,
          `RLS proof is running as SUPERUSER '${r.rows[0].rolname}' — every isolation claim would be vacuous`
        ).toBe(false);
        expect(r.rows[0].rolname).toBe("partner_runtime");
        expect(r.rows[0].b).toBe(false);
      });
    });

    it("the connector acting role is partner_connector_runtime, NOSUPERUSER and NOBYPASSRLS", async () => {
      await asConnectorTenant(A.id, async () => {
        const r = await connectorRuntime.query<{ rolname: string; s: boolean; b: boolean }>(
          `SELECT current_user AS rolname,
                  (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS s,
                  (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b`
        );
        expect(r.rows[0].rolname).toBe("partner_connector_runtime");
        expect(r.rows[0].s, "connector proof must not run as a superuser").toBe(false);
        expect(r.rows[0].b, "connector proof must not hold BYPASSRLS").toBe(false);
      });
    });

    it("the tenant context is TRANSACTION-local and does not survive the transaction", async () => {
      await asTenant(A.id, async () => {
        expect((await runtime.query("SELECT current_setting('app.tenant_id', true) AS t")).rows[0].t).toBe(A.id);
      });
      // outside any transaction the GUC must be gone, or a later test inherits this identity
      const after = await runtime.query<{ t: string | null }>(
        "SELECT NULLIF(current_setting('app.tenant_id', true),'') AS t"
      );
      expect(after.rows[0].t).toBeNull();
    });

    it("every money-path table has RLS enabled, FORCED, and at least one policy", async () => {
      await asTenant(A.id, async () => {
        for (const t of [
          "partner_wallets",
          "partner_credit_ledger",
          "partner_credit_reservations",
          "partner_credit_reservation_events",
          "partner_submissions",
          "partner_submission_cards",
          // 0041 created this table with NO row-level security at all, while enabling it on its
          // sibling partner_credit_accounting_exceptions in the same migration. 0043 closes that.
          "partner_submission_credit_holds",
          "partner_grading_work_items",
          "partner_locations",
        ]) {
          await assertRlsHarness(runtime, t, A.id);
        }
      });
    });
  });

  // ------------------------------------------------------------------ read isolation, money path
  describe("tenant A cannot READ tenant B", () => {
    /**
     * Deliberately NO tenant predicate in any of these queries. If RLS is enforcing, B's row is
     * invisible; if it is not, B's row is returned and the assertion fails. A `WHERE tenant_id=A`
     * filter would pass either way and would prove nothing.
     */
    const cases: Array<{ table: string; bId: (t: Tenant) => string }> = [
      { table: "partner_wallets", bId: (t) => t.walletId },
      { table: "partner_submissions", bId: (t) => t.submissionId },
      { table: "partner_credit_reservations", bId: (t) => t.reservationId },
      { table: "partner_grading_work_items", bId: (t) => t.gradingWorkItemId },
    ];

    for (const c of cases) {
      it(`${c.table}: B's row is invisible and only A's rows are returned`, async () => {
        await asTenant(A.id, async () => {
          await assertRlsHarness(runtime, c.table, A.id);
          const seen = await runtime.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM ${c.table}`);
          expect(seen.rows.length).toBeGreaterThan(0); // A must genuinely see its own data
          expect(seen.rows.every((r) => r.tenant_id === A.id)).toBe(true);
          expect(seen.rows.some((r) => r.id === c.bId(B))).toBe(false);
        });
      });
    }

    it("partner_credit_ledger: A sees only its own entries and never B's balance", async () => {
      await asTenant(A.id, async () => {
        await assertRlsHarness(runtime, "partner_credit_ledger", A.id);
        const rows = await runtime.query<{ tenant_id: string }>("SELECT tenant_id FROM partner_credit_ledger");
        expect(rows.rows.length).toBeGreaterThan(0);
        expect(rows.rows.every((r) => r.tenant_id === A.id)).toBe(true);
      });
    });

    it("an explicit lookup of B's primary key by id returns nothing", async () => {
      await asTenant(A.id, async () => {
        const r = await runtime.query("SELECT id FROM partner_credit_reservations WHERE id=$1", [B.reservationId]);
        expect(r.rowCount).toBe(0);
      });
    });

    it("aggregates cannot leak B — count() over the whole table equals A's own count", async () => {
      const total = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_credit_reservations");
      await asTenant(A.id, async () => {
        const seen = await runtime.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_credit_reservations");
        expect(Number(seen.rows[0].n)).toBe(1);
        expect(Number(seen.rows[0].n)).toBeLessThan(Number(total.rows[0].n));
      });
    });
  });

  // ------------------------------------------------------------------ write isolation
  describe("tenant A cannot WRITE tenant B", () => {
    it("partner_runtime has SELECT only on partner_grading_work_items, never DML", async () => {
      await asTenant(A.id, async () => {
        await assertRlsHarness(runtime, "partner_grading_work_items", A.id);
        for (const statement of [
          {
            sql: "UPDATE partner_grading_work_items SET status='void' WHERE id=$1",
            params: [A.gradingWorkItemId],
          },
          {
            sql: "DELETE FROM partner_grading_work_items WHERE id=$1",
            params: [A.gradingWorkItemId],
          },
          {
            sql: `INSERT INTO partner_grading_work_items
                   (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id,
                    partner_submission_card_id, partner_handoff_id, connector_import_id, connector_record_id,
                    validation_run_id, destination_submission_id, submission_item_id, card_ordinal,
                    front_image_key, back_image_key, source_fingerprint, source_fingerprint_version)
                  SELECT tenant_id, tenant_id, partner_location_id, partner_submission_id,
                         partner_submission_card_id, partner_handoff_id, connector_import_id, connector_record_id,
                         validation_run_id, destination_submission_id, submission_item_id, 99,
                         front_image_key, back_image_key, 'runtime-forbidden', 1
                    FROM partner_grading_work_items WHERE id=$1`,
            params: [A.gradingWorkItemId],
          },
        ]) {
          const r = await attemptWrite(statement.sql, statement.params);
          expect(r.refusal).toBe("denied");
          expect(r.sqlstate).toBe("42501");
          expect(r.message).toMatch(/permission denied/i);
        }
      });
    });

    it("partner_connector_runtime can insert only work items for its transaction tenant", async () => {
      const aItem = await nextDestinationItem(A);
      const bItem = await nextDestinationItem(B);
      const insertSql = `INSERT INTO partner_grading_work_items
         (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id,
          partner_submission_card_id, partner_handoff_id, connector_import_id, connector_record_id,
          validation_run_id, destination_submission_id, submission_item_id, card_ordinal,
          front_image_key, back_image_key, source_fingerprint, source_fingerprint_version)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,md5($14)||md5($14||':f'),1)`;
      await asConnectorTenant(A.id, async () => {
        await assertConnectorRlsHarness(connectorRuntime, "partner_grading_work_items", A.id);
        const own = await attemptConnectorWrite(insertSql, await workItemInsertParams(A, aItem, 41));
        expect(own.refusal).toBe("APPLIED");
        expect(own.rowCount).toBe(1);

        const cross = await attemptConnectorWrite(insertSql, await workItemInsertParams(B, bItem, 41));
        expect(cross.refusal).toBe("denied");
        expect(cross.sqlstate).toBe("42501");
        expect(cross.message).toMatch(/row-level security|violates row-level security/i);
      });
    });

    it("partner_connector_runtime fails closed when tenant context is missing", async () => {
      const aItem = await nextDestinationItem(A);
      const insertSql = `INSERT INTO partner_grading_work_items
         (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id,
          partner_submission_card_id, partner_handoff_id, connector_import_id, connector_record_id,
          validation_run_id, destination_submission_id, submission_item_id, card_ordinal,
          front_image_key, back_image_key, source_fingerprint, source_fingerprint_version)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,md5($14)||md5($14||':f'),1)`;
      await asConnectorTenant(null, async () => {
        const r = await attemptConnectorWrite(insertSql, await workItemInsertParams(A, aItem, 42));
        expect(r.refusal).toBe("denied");
        expect(r.sqlstate).toBe("42501");
        expect(r.message).toMatch(/row-level security|violates row-level security/i);
      });
    });

    it("UPDATE against B's reservation is refused and leaves it untouched", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite("UPDATE partner_credit_reservations SET reason='hijacked' WHERE id=$1", [
          B.reservationId,
        ]);
        expect(r.refusal).not.toBe("APPLIED");
      });
      const after = await admin.query<{ reason: string }>(
        "SELECT reason FROM partner_credit_reservations WHERE id=$1",
        [B.reservationId]
      );
      expect(after.rows[0].reason).not.toBe("hijacked");
    });

    it("an unqualified UPDATE (no WHERE at all) is refused outright", async () => {
      /**
       * This previously asserted only that B's row was unchanged AFTER the transaction — which
       * `asTenant` always rolls back, so the assertion held no matter what the statement did. It
       * could not fail for any implementation. It now asserts the refusal itself.
       *
       * partner_runtime holds SELECT only on this table (0017), so the refusal here is PRIVILEGE
       * ABSENCE, not RLS. That distinction is the point of asserting the SQLSTATE rather than
       * calling this an RLS proof: the genuine RLS write proof is the partner_submissions case
       * below, on a table where the runtime role really does hold DML.
       */
      await asTenant(A.id, async () => {
        const r = await attemptWrite("UPDATE partner_credit_reservations SET reason='sweep'", []);
        expect(r.refusal).toBe("denied");
        expect(r.sqlstate).toBe("42501");
        expect(r.message).toMatch(/permission denied/i);
      });
    });

    it("RLS (not privilege) hides B's submission from an UPDATE the runtime role IS allowed to make", async () => {
      /**
       * THE LOAD-BEARING WRITE PROOF. partner_submissions is the one money-path table where
       * partner_runtime genuinely holds INSERT/UPDATE (0007), so a refusal here can only come from
       * row-level security. Every other write test in this block is refused by grant absence and
       * would stay green with RLS switched off entirely.
       */
      await asTenant(A.id, async () => {
        await assertRlsHarness(runtime, "partner_submissions", A.id);
        const r = await attemptWrite("UPDATE partner_submissions SET status='cancelled' WHERE id=$1", [B.submissionId]);
        // Not "denied": the grant exists. RLS makes the row invisible, so zero rows match.
        expect(r.refusal).toBe("no_rows");
        // ...and A can still update its OWN row, proving the grant is real and the test is not
        // passing merely because the statement is broken.
        const own = await attemptWrite("UPDATE partner_submissions SET status='cancelled' WHERE id=$1", [
          A.submissionId,
        ]);
        expect(own.refusal).toBe("APPLIED");
        expect(own.rowCount).toBe(1);
      });
      const b = await admin.query<{ status: string }>("SELECT status FROM partner_submissions WHERE id=$1", [
        B.submissionId,
      ]);
      expect(b.rows[0].status).not.toBe("cancelled");
    });

    it("DELETE against B's submission is refused and B survives", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite("DELETE FROM partner_submissions WHERE id=$1", [B.submissionId]);
        expect(r.refusal).not.toBe("APPLIED");
      });
      const alive = await admin.query("SELECT 1 FROM partner_submissions WHERE id=$1", [B.submissionId]);
      expect(alive.rowCount).toBe(1);
    });

    it("INSERT of a row owned by B is refused", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite(
          `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
           VALUES ($1,$2,$3,1,'draft')`,
          [B.id, B.locationId, B.userId]
        );
        expect(r.refusal).toBe("denied");
      });
      const count = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM partner_submissions WHERE tenant_id=$1",
        [B.id]
      );
      expect(Number(count.rows[0].n)).toBe(1);
    });

    it("A cannot CONSUME B's credit — the settlement-shaped write is refused", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite(
          `UPDATE partner_credit_reservations
              SET status='consumed', consumed_at=now()
            WHERE id=$1 AND status='active'`,
          [B.reservationId]
        );
        expect(r.refusal).not.toBe("APPLIED");
      });
      const b = await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [
        B.reservationId,
      ]);
      expect(b.rows[0].status).toBe("active");
    });

    it("A cannot RELEASE B's credit — the release-shaped write is refused", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite(
          `UPDATE partner_credit_reservations
              SET status='released', released_at=now()
            WHERE id=$1 AND status='active'`,
          [B.reservationId]
        );
        expect(r.refusal).not.toBe("APPLIED");
      });
      const b = await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [
        B.reservationId,
      ]);
      expect(b.rows[0].status).toBe("active");
    });

    it("A cannot append a reservation EVENT against B's reservation", async () => {
      await asTenant(A.id, async () => {
        const key = "rls-evil-event";
        const r = await attemptWrite(
          `INSERT INTO partner_credit_reservation_events
             (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
              request_fingerprint, source, reason, actor_type)
           VALUES ($1,$2,$3,'released',1,$4,md5($4)||md5($4||':f'),'system','cross tenant','system')`,
          [B.reservationId, B.walletId, B.id, key]
        );
        expect(r.refusal).toBe("denied");
      });
    });

    it("A cannot mint ledger credit for B", async () => {
      await asTenant(A.id, async () => {
        const key = "rls-evil-ledger";
        const r = await attemptWrite(
          `INSERT INTO partner_credit_ledger
             (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason,
              actor_type, request_fingerprint)
           VALUES ($1,$2,999,'purchase',$3,'admin','cross tenant','admin',md5($3)||md5($3||':f'))`,
          [B.walletId, B.id, key]
        );
        expect(r.refusal).toBe("denied");
      });
    });
  });

  // ------------------------------------------------------------------ context failure modes
  describe("missing or malformed tenant context fails closed", () => {
    for (const [name, value] of [
      ["missing", null],
      ["empty", ""],
      ["non-uuid", "not-a-uuid"],
      ["another tenant's id", "00000000-0000-0000-0000-0000000000ff"],
    ] as Array<[string, string | null]>) {
      it(`${name} context yields 0 rows across the money path`, async () => {
        await asTenant(value, async () => {
          for (const t of ["partner_wallets", "partner_credit_reservations", "partner_submissions"]) {
            const r = await runtime.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
            expect(Number(r.rows[0].n), `${t} must be empty without a valid tenant context`).toBe(0);
          }
        });
      });
    }
  });

  // ------------------------------------------------------------------ preserved 0001-era coverage
  describe("restricted-role privilege boundaries", () => {
    it("cannot read an existing MintVault table", async () => {
      await asTenant(A.id, async () => {
        await expect(runtime.query("SELECT 1 FROM certificates LIMIT 1")).rejects.toThrow(/permission denied/i);
      });
    });

    it("has no privilege on existing MintVault sequences", async () => {
      const r = await admin.query<{ g: boolean }>(
        "SELECT has_sequence_privilege('partner_runtime','certificates_id_seq','USAGE') AS g"
      );
      expect(r.rows[0].g).toBe(false);
    });

    it("audit events are append-only for the restricted role", async () => {
      await asTenant(A.id, async () => {
        await runtime.query("INSERT INTO partner_audit_events (tenant_id,action) VALUES ($1,'t')", [A.id]);
        const r = await attemptWrite("UPDATE partner_audit_events SET action='x'", []);
        expect(r.refusal).toBe("denied");
      });
    });

    it("F1: cannot INSERT/UPDATE/DELETE its own organisation", async () => {
      await asTenant(A.id, async () => {
        expect((await attemptWrite("DELETE FROM partner_organisations WHERE id=$1", [A.id])).refusal).toBe("denied");
        expect(
          (await attemptWrite("UPDATE partner_organisations SET status='REVOKED' WHERE id=$1", [A.id])).refusal
        ).toBe("denied");
      });
      const alive = await admin.query("SELECT 1 FROM partner_organisations WHERE id=$1", [A.id]);
      expect(alive.rowCount).toBe(1);
    });

    it("F2: a global feature flag is readable by a tenant but cannot be written by one", async () => {
      await admin.query("INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'global',true)");
      await asTenant(A.id, async () => {
        const seen = await runtime.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM partner_feature_flags WHERE flag='global'"
        );
        expect(Number(seen.rows[0].n)).toBe(1);
        const r = await attemptWrite(
          "INSERT INTO partner_feature_flags (tenant_id, flag) VALUES (NULL,'evil-global')",
          []
        );
        expect(r.refusal).not.toBe("APPLIED");
      });
    });
  });
});

// ============================================================================================
// SUITE 2 (origin/main) — adversarial tenant-boundary attacks against PARTNER_RLS_DB.
// Its fixtures and session GUCs are isolated from Suite 1 by living on a DIFFERENT database.
// A/B and the fixture constants below are scoped INSIDE the describe so they cannot collide with
// Suite 1's `A`/`B` tenant objects; every test body is byte-identical to origin/main.
// ============================================================================================

// Renamed from `URL` during the main reconciliation: a module-level `const URL` shadows the
// GLOBAL URL constructor, which Suite 1 uses at `new URL(cluster.url)`. Suite 2's own uses are
// the three below; the test bodies are otherwise byte-identical to origin/main.
const RLS_DB_URL = process.env.PARTNER_RLS_DB;
const isLocal = !!RLS_DB_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(RLS_DB_URL);

/**
 * CI WIRING GUARD. Without this, an unset PARTNER_RLS_DB makes the entire file `describe.skip` and
 * the build stays GREEN with the single most important test in the partner stack never running —
 * exactly how ~250 connector tests reported green for months. Same pattern as
 * tests/partner-rbac-migration.test.ts and tests/partner-rbac-bootstrap.test.ts.
 */
describe("Partner RLS isolation coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_RLS_DB must be a disposable loopback PostgreSQL URL in CI").toBe(true);
    }
    if (!isLocal) console.warn("[partner-rls] skipped: PARTNER_RLS_DB not a loopback URL");
    expect(true).toBe(true);
  });
});

(isLocal ? describe : describe.skip)("Partner RLS tenant isolation (disposable DB)", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  /**
   * The partner migration chain that creates every table the partner pilot reads or writes.
   * 0001 alone (what this file used to apply) covers the ORG/USER/SESSION layer only — it does not
   * create partner_submissions, partner_submission_cards, partner_customers or any partner_credit_*
   * table, so before this list existed the pilot's actual data surface had ZERO tenant-isolation
   * coverage. Verified to apply cleanly, in this order, onto an empty database.
   */
  const PARTNER_MIGRATIONS = PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE.map((name) => `${name}.sql`);

  /** Deterministic per-tenant fixture ids, so every assertion can target an exact cross-tenant row. */
  const ID = {
    locA: "aaaa0000-0000-0000-0000-0000000000a1",
    locB: "bbbb0000-0000-0000-0000-0000000000b1",
    userA: "aaaa0000-0000-0000-0000-0000000000a2",
    userB: "bbbb0000-0000-0000-0000-0000000000b2",
    custA: "aaaa0000-0000-0000-0000-0000000000a3",
    custB: "bbbb0000-0000-0000-0000-0000000000b3",
    subA: "aaaa0000-0000-0000-0000-0000000000a4",
    subB: "bbbb0000-0000-0000-0000-0000000000b4",
    cardA: "aaaa0000-0000-0000-0000-0000000000a5",
    cardB: "bbbb0000-0000-0000-0000-0000000000b5",
    walletA: "aaaa0000-0000-0000-0000-0000000000a6",
    walletB: "bbbb0000-0000-0000-0000-0000000000b6",
    resA: "aaaa0000-0000-0000-0000-0000000000a7",
    resB: "bbbb0000-0000-0000-0000-0000000000b7",
    handoffA: "aaaa0000-0000-0000-0000-0000000000a8",
    handoffB: "bbbb0000-0000-0000-0000-0000000000b8",
    connectorA: "aaaa0000-0000-0000-0000-0000000000a9",
    connectorB: "bbbb0000-0000-0000-0000-0000000000b9",
    validationA: "aaaa0000-0000-0000-0000-0000000000aa",
    validationB: "bbbb0000-0000-0000-0000-0000000000ba",
    importA: "aaaa0000-0000-0000-0000-0000000000ab",
    importB: "bbbb0000-0000-0000-0000-0000000000bb",
    /** A uuid that exists in NO tenant — the control arm of the FK existence-oracle probe. */
    absent: "deadbeef-0000-0000-0000-000000000000",
  };

  /** Every tenant-scoped table the pilot touches that partner_runtime can SELECT. */
  const TENANT_TABLES = [
    "partner_locations",
    "partner_users",
    "partner_customers",
    "partner_submissions",
    "partner_submission_cards",
    "partner_submission_events",
    "partner_wallets",
    "partner_credit_ledger",
    "partner_credit_reservations",
    "partner_credit_reservation_events",
    "partner_grading_work_items",
  ] as const;

  /**
   * RLS-LESS EXCEPTION REGISTER — the pinned counterpart to the catalogue-driven coverage sweep
   * below.
   *
   * WHY THIS EXISTS (A8-F4): the sweep used to be scoped `AND c.relname = ANY(TENANT_TABLES)`, an
   * 11-name INCLUSION allowlist, while its own comment claimed it "catches a NEW tenant-scoped
   * table landing in a future migration with the RLS block forgotten". It could not: a table
   * absent from the list was absent from the query, so it could never fail. The live catalogue in
   * this fixture has 34 tenant-keyed `partner_%` tables, not 11. That gap is exactly how A8-F1
   * survived every green run of this file.
   *
   * The sweep is now catalogue-driven — it asks the catalogue which tenant-keyed tables exist and
   * checks ALL of them — and this register is an EXCLUSION list asserted in BOTH directions. A new
   * unprotected table fails closed (not in the register). Protecting a table listed here ALSO
   * fails, which forces the fix to delete its entry rather than leave a stale exception behind.
   *
   * `partnerRuntimeGrants` is the load-bearing half. An RLS-less table is only reachable by a
   * partner session if `partner_runtime` holds a grant on it, so the grant set is pinned per entry
   * and asserted separately below. Three of these four are genuinely unreachable (no grant); the
   * fourth is an OPEN HIGH.
   */
  const RLS_EXEMPT_TENANT_TABLES: Record<string, { partnerRuntimeGrants: string[]; why: string }> = {
    partner_connector_records: {
      partnerRuntimeGrants: [],
      why: "connector-plane table; reached only by partner_connector_runtime, never granted to partner_runtime",
    },
    partner_internal_notes: {
      partnerRuntimeGrants: [],
      why: "MintVault-staff-only table; no partner_runtime grant, so RLS is not the boundary",
    },
    partner_management_audit: {
      partnerRuntimeGrants: [],
      why: "HQ management audit trail; admin-pool only, no partner_runtime grant",
    },
    partner_owner_invariant_tenants: {
      // OPEN HIGH — A8-F1. migrations/0032_partner_final_owner_invariant.sql creates this table at
      // :9 and grants SELECT, INSERT to partner_runtime at :117, but never issues ENABLE ROW LEVEL
      // SECURITY and never creates a policy. Every one of the file's five RLS statements concerns
      // partner_users / partner_user_roles. The behavioural consequence is proved, not narrated,
      // by the "KNOWN OPEN" test below. Repair needs a new migration number, which this branch is
      // not authorised to allocate — the entry stays, the leak stays visible, and the fix will
      // turn BOTH pinned tests red and force this entry's deletion.
      partnerRuntimeGrants: ["INSERT", "SELECT"],
      why: "A8-F1 OPEN HIGH: 0032 grants partner_runtime SELECT+INSERT with no RLS and no policy",
    },
  };

  const FP_A = "a".repeat(64);
  const FP_B = "b".repeat(64);
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: RLS_DB_URL });
    await client.connect();
    // fresh state
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO public");
    await client.query("DROP OWNED BY partner_runtime").catch(() => {});
    await client.query(`DO $$ BEGIN
      PERFORM 1; END$$;`);
    // an existing MintVault-style table the restricted role must never read
    await client.query(
      "CREATE TABLE IF NOT EXISTS users (id varchar primary key default gen_random_uuid(), email varchar unique)"
    );
    await client.query(`CREATE TABLE IF NOT EXISTS submissions (
      id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
      tracking_number text not null unique, deleted_at timestamptz, grading_status varchar(30),
      assigned_grader_id varchar, scan_status varchar(30), scan_assigned_to varchar,
      shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
      return_tracking text, return_carrier text, return_service text,
      status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
    )`);
    await client.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
    );
    await client.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial primary key, entity_type text not null, entity_id text not null, action text not null,
      admin_user text, details jsonb, created_at timestamptz not null default now()
    )`);
    await client.query("DROP TABLE IF EXISTS certificates");
    await client.query(`CREATE TABLE certificates (
      id serial primary key,
      certificate_number text,
      cert_id text,
      submission_id integer,
      submission_item_id integer,
      status text,
      label_type text,
      grade_type text,
      language text,
      card_game text,
      set_name text,
      card_name text,
      card_number_display text,
      year_text text,
      variant text,
      front_image_path text,
      back_image_path text,
      grading_front_original text,
      grading_back_original text,
      created_by text,
      issued_at timestamptz,
      updated_at timestamptz,
      reference_number text,
      logbook_version integer,
      logbook_last_issued_at timestamptz,
      integrity_hash text,
      print_state text,
      grader_status text,
      origin_type text,
      origin_partner_id uuid,
      origin_partner_public_ref text,
      origin_partner_legal_name text,
      origin_partner_trading_name text,
      origin_location_id uuid,
      origin_location_public_ref text,
      origin_location_name text,
      origin_location_address text,
      origin_captured_at timestamptz,
      origin_snapshot_version integer,
      secret text
    )`);
    await client.query(
      "INSERT INTO certificates (certificate_number, cert_id, secret) VALUES ('MV1','MV1','MV-DATA') ON CONFLICT DO NOTHING"
    );
    await client.query("CREATE TABLE IF NOT EXISTS label_prints (id serial primary key, certificate_id integer)");
    // apply the authoritative migrations (idempotent), in dependency order
    for (const file of PARTNER_MIGRATIONS) {
      await client.query(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
    }
    // Reset the whole partner estate to a known state, as superuser.
    //
    // TRUNCATE, not DELETE, and with triggers suppressed — because 0016/0017 defend the credit
    // tables with append-only ENFORCEMENT TRIGGERS that refuse both DELETE and TRUNCATE even for
    // the superuser ("partner_credit_ledger is append-only: TRUNCATE is not permitted"). That is a
    // good thing and is asserted as a control further down; it just means a test fixture has to
    // step around it deliberately. `session_replication_role = replica` suppresses origin-mode user
    // triggers (all of them are tgenabled='O') and FK triggers for the duration of the reset only.
    // TRUNCATE … CASCADE is also order-independent, so this stays correct as the migration chain
    // grows. The table list is discovered dynamically so a table added by a future partner
    // migration is reset too — a stale row from a previous run silently changing a count is exactly
    // the kind of flake that erodes trust in this suite.
    // Safe because PARTNER_RLS_DB is guarded to a DISPOSABLE loopback database.
    await client.query("SET session_replication_role = 'replica'");
    await client.query(`DO $$
      DECLARE list text;
      BEGIN
        SELECT string_agg(format('%I', c.relname), ', ') INTO list
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'partner\\_%';
        IF list IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE ' || list || ' RESTART IDENTITY CASCADE';
        END IF;
      END$$;`);
    await client.query("SET session_replication_role = 'origin'");
    await client.query(
      "INSERT INTO partner_organisations (id,public_ref,legal_name) VALUES ($1,'refA','A Ltd'),($2,'refB','B Ltd')",
      [A, B]
    );
    await client.query(
      "INSERT INTO partner_locations (id,public_ref,tenant_id,partner_id,name) VALUES ($1,'la',$3,$3,'Shop A'),($2,'lb',$4,$4,'Shop B')",
      [ID.locA, ID.locB, A, B]
    );
    await client.query(
      "INSERT INTO partner_users (id,public_ref,tenant_id,partner_id,email,status) VALUES ($1,'ua',$3,$3,'a@x.test','active'),($2,'ub',$4,$4,'b@x.test','active')",
      [ID.userA, ID.userB, A, B]
    );
    await client.query(
      "INSERT INTO partner_customers (id,tenant_id,full_name,email) VALUES ($1,$3,'Cust A','a-cust@x.test'),($2,$4,'Cust B','b-cust@x.test')",
      [ID.custA, ID.custB, A, B]
    );
    await client.query(
      `INSERT INTO partner_submissions (id,tenant_id,location_id,created_by,public_ref,customer_id,status,card_count)
       VALUES ($1,$3,$5,$7,'sa',$9,'draft',1),($2,$4,$6,$8,'sb',$10,'draft',1)`,
      [ID.subA, ID.subB, A, B, ID.locA, ID.locB, ID.userA, ID.userB, ID.custA, ID.custB]
    );
    await client.query(
      `INSERT INTO partner_submission_cards (id,tenant_id,submission_id,sequence_number,card_name,declared_value_pence)
       VALUES ($1,$3,$5,1,'Card A',100),($2,$4,$6,1,'Card B',999999)`,
      [ID.cardA, ID.cardB, A, B, ID.subA, ID.subB]
    );
    await client.query(
      `INSERT INTO partner_submission_handoffs (id,tenant_id,submission_id,status,snapshot)
       VALUES ($1,$3,$5,'applied','{}'::jsonb),($2,$4,$6,'applied','{}'::jsonb)`,
      [ID.handoffA, ID.handoffB, A, B, ID.subA, ID.subB]
    );
    await client.query(
      "INSERT INTO partner_connector_records (id,tenant_id,partner_submission_id,handoff_id,state) VALUES ($1,$3,$5,$7,'imported'),($2,$4,$6,$8,'imported')",
      [ID.connectorA, ID.connectorB, A, B, ID.subA, ID.subB, ID.handoffA, ID.handoffB]
    );
    await client.query(
      `INSERT INTO partner_connector_validation_runs
         (id,connector_record_id,validation_attempt,source_submission_version,source_handoff_status,outcome,source_fingerprint,source_fingerprint_version,completed_at)
       VALUES ($1,$3,1,1,'applied','valid',$5,1,now()),
              ($2,$4,1,1,'applied','valid',$6,1,now())`,
      [ID.validationA, ID.validationB, ID.connectorA, ID.connectorB, FP_A, FP_B]
    );
    const destA = await client.query<{ id: number }>(
      "INSERT INTO submissions (user_id,status,tracking_number) VALUES ($1,'grading','RLS-A') RETURNING id",
      [ID.userA]
    );
    const destB = await client.query<{ id: number }>(
      "INSERT INTO submissions (user_id,status,tracking_number) VALUES ($1,'grading','RLS-B') RETURNING id",
      [ID.userB]
    );
    const itemA = await client.query<{ id: number }>(
      "INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id",
      [destA.rows[0].id]
    );
    const itemB = await client.query<{ id: number }>(
      "INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id",
      [destB.rows[0].id]
    );
    await client.query(
      `INSERT INTO partner_connector_imports
         (id,connector_record_id,partner_organisation_id,partner_location_id,partner_submission_id,partner_handoff_id,validation_run_id,destination_submission_id,source_fingerprint,source_fingerprint_version,state,completed_at)
       VALUES ($1,$3,$5,$7,$9,$11,$13,$15,$17,1,'completed',now()),
              ($2,$4,$6,$8,$10,$12,$14,$16,$18,1,'completed',now())`,
      [
        ID.importA,
        ID.importB,
        ID.connectorA,
        ID.connectorB,
        A,
        B,
        ID.locA,
        ID.locB,
        ID.subA,
        ID.subB,
        ID.handoffA,
        ID.handoffB,
        ID.validationA,
        ID.validationB,
        destA.rows[0].id,
        destB.rows[0].id,
        FP_A,
        FP_B,
      ]
    );
    await client.query(
      `INSERT INTO partner_grading_work_items
         (tenant_id,partner_organisation_id,partner_location_id,partner_submission_id,partner_submission_card_id,
          partner_handoff_id,connector_import_id,connector_record_id,validation_run_id,destination_submission_id,
          submission_item_id,card_ordinal,front_image_key,back_image_key,source_fingerprint,source_fingerprint_version)
       VALUES ($1,$1,$3,$5,$7,$9,$11,$13,$15,$17,$19,1,$23,$24,$21,1),
              ($2,$2,$4,$6,$8,$10,$12,$14,$16,$18,$20,1,$25,$26,$22,1)`,
      [
        A,
        B,
        ID.locA,
        ID.locB,
        ID.subA,
        ID.subB,
        ID.cardA,
        ID.cardB,
        ID.handoffA,
        ID.handoffB,
        ID.importA,
        ID.importB,
        ID.connectorA,
        ID.connectorB,
        ID.validationA,
        ID.validationB,
        destA.rows[0].id,
        destB.rows[0].id,
        itemA.rows[0].id,
        itemB.rows[0].id,
        FP_A,
        FP_B,
        `partner-submissions/${A}/${ID.subA}/${ID.cardA}/front-a.png`,
        `partner-submissions/${A}/${ID.subA}/${ID.cardA}/back-a.png`,
        `partner-submissions/${B}/${ID.subB}/${ID.cardB}/front-b.png`,
        `partner-submissions/${B}/${ID.subB}/${ID.cardB}/back-b.png`,
      ]
    );
    await client.query(
      `INSERT INTO partner_submission_events (tenant_id,submission_id,event_type) VALUES ($1,$3,'created'),($2,$4,'created')`,
      [A, B, ID.subA, ID.subB]
    );
    await client.query("INSERT INTO partner_wallets (id,tenant_id) VALUES ($1,$3),($2,$4)", [
      ID.walletA,
      ID.walletB,
      A,
      B,
    ]);
    await client.query(
      `INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint)
       VALUES ($1,$3,10,'purchase','seed-a','admin','seed','admin',$5),($2,$4,999,'purchase','seed-b','admin','seed','admin',$6)`,
      [ID.walletA, ID.walletB, A, B, FP_A, FP_B]
    );
    await client.query(
      `INSERT INTO partner_credit_reservations
         (id,wallet_id,tenant_id,location_id,card_reference,idempotency_key,request_fingerprint,source,reason,actor_type,expires_at)
       VALUES ($1,$3,$5,$7,'card-a','res-a',$9,'portal','seed','partner_user',now()+interval '1 day'),
              ($2,$4,$6,$8,'card-b','res-b',$10,'portal','seed','partner_user',now()+interval '1 day')`,
      [ID.resA, ID.resB, ID.walletA, ID.walletB, A, B, ID.locA, ID.locB, FP_A, FP_B]
    );
    await client.query(
      `INSERT INTO partner_credit_reservation_events
         (reservation_id,wallet_id,tenant_id,event_type,idempotency_key,request_fingerprint,source,reason,actor_type)
       VALUES ($1,$3,$5,'reserved','ev-a',$7,'portal','seed','partner_user'),
              ($2,$4,$6,'reserved','ev-b',$8,'portal','seed','partner_user')`,
      [ID.resA, ID.resB, ID.walletA, ID.walletB, A, B, FP_A, FP_B]
    );
  });

  afterAll(async () => {
    await client?.query("RESET ROLE").catch(() => {});
    await client?.end().catch(() => {});
  });

  // helper: run fn as the restricted role with a given tenant context, then reset.
  async function asPartner(tenant: string | null, fn: () => Promise<void>) {
    await client.query("SET ROLE partner_runtime");
    if (tenant === null) await client.query("RESET app.tenant_id");
    else await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
    try {
      await fn();
    } finally {
      await client.query("RESET ROLE");
    }
  }

  it("superuser (super-admin) sees all tenants — unchanged", async () => {
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_organisations");
    expect(rows[0].n).toBe(2);
  });

  it("tenant A reads only its own rows", async () => {
    await asPartner(A, async () => {
      const own = await client.query("SELECT count(*)::int n FROM partner_locations");
      const bVisible = await client.query("SELECT count(*)::int n FROM partner_locations WHERE name='Shop B'");
      expect(own.rows[0].n).toBe(1);
      expect(bVisible.rows[0].n).toBe(0);
    });
  });

  it("tenant A cannot update or delete tenant B (0 rows affected)", async () => {
    await asPartner(A, async () => {
      const u = await client.query("UPDATE partner_locations SET address='hack' WHERE tenant_id=$1", [B]);
      const d = await client.query("DELETE FROM partner_locations WHERE tenant_id=$1", [B]);
      expect(u.rowCount).toBe(0);
      expect(d.rowCount).toBe(0);
    });
    // B intact (checked as superuser)
    const { rows } = await client.query(
      "SELECT count(*)::int n FROM partner_locations WHERE tenant_id=$1 AND address IS NULL",
      [B]
    );
    expect(rows[0].n).toBe(1);
  });

  it("tenant A cannot insert a row owned by tenant B (WITH CHECK)", async () => {
    await asPartner(A, async () => {
      await expect(
        client.query(
          "INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name) VALUES ('evil',$1,$1,'evil')",
          [B]
        )
      ).rejects.toThrow();
    });
  });

  it("missing tenant context fails closed (0 rows, no error)", async () => {
    await asPartner(null, async () => {
      const { rows } = await client.query("SELECT count(*)::int n FROM partner_locations");
      expect(rows[0].n).toBe(0);
    });
  });

  it("empty tenant context fails closed (0 rows, no error)", async () => {
    await asPartner("", async () => {
      const { rows } = await client.query("SELECT count(*)::int n FROM partner_locations");
      expect(rows[0].n).toBe(0);
    });
  });

  it("restricted role cannot read an existing MintVault table", async () => {
    await asPartner(A, async () => {
      await expect(client.query("SELECT 1 FROM certificates LIMIT 1")).rejects.toThrow(/permission denied/i);
    });
  });

  it("restricted role has no privilege on existing MintVault sequences", async () => {
    const { rows } = await client.query(
      "SELECT has_sequence_privilege('partner_runtime','certificates_id_seq','USAGE') AS g"
    );
    expect(rows[0].g).toBe(false);
  });

  it("audit table is append-only for the restricted role (insert ok, update denied)", async () => {
    await asPartner(A, async () => {
      await client.query("INSERT INTO partner_audit_events (tenant_id,action) VALUES ($1,'t')", [A]);
      await expect(client.query("UPDATE partner_audit_events SET action='x'")).rejects.toThrow(/permission denied/i);
    });
  });

  it("F1: restricted role cannot INSERT/UPDATE/DELETE its own organisation (super-admin lifecycle)", async () => {
    await asPartner(A, async () => {
      // DELETE: no grant -> permission denied (so the audit trail can never be cascade-wiped)
      await expect(client.query("DELETE FROM partner_organisations WHERE id=$1", [A])).rejects.toThrow(
        /permission denied/i
      );
      await expect(client.query("UPDATE partner_organisations SET status='REVOKED' WHERE id=$1", [A])).rejects.toThrow(
        /permission denied/i
      );
      await expect(
        client.query("INSERT INTO partner_organisations (public_ref,legal_name) VALUES ('x','X')")
      ).rejects.toThrow(/permission denied/i);
    });
    // org + its audit trail intact
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_organisations WHERE id=$1", [A]);
    expect(rows[0].n).toBe(1);
  });

  it("F2: a global feature flag (tenant_id NULL) is readable by a tenant, but a tenant cannot write one", async () => {
    await client.query("DELETE FROM partner_feature_flags");
    await client.query("INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL, 'global', true)");
    await asPartner(A, async () => {
      const seen = await client.query("SELECT count(*)::int n FROM partner_feature_flags WHERE flag='global'");
      expect(seen.rows[0].n).toBe(1); // global visible
      await expect(
        client.query("INSERT INTO partner_feature_flags (tenant_id, flag) VALUES (NULL, 'evil-global')")
      ).rejects.toThrow(); // cannot write a global flag
    });
  });

  it("F4: malformed (non-uuid) tenant context fails closed to 0 rows, not an error", async () => {
    await asPartner(A, async () => {
      await client.query("SELECT set_config('app.tenant_id','not-a-uuid',false)");
      const { rows } = await client.query("SELECT count(*)::int n FROM partner_locations");
      expect(rows[0].n).toBe(0);
    });
  });

  // =========================================================================================
  // ROLE MODEL — the precondition that makes every assertion below mean anything.
  // =========================================================================================

  it("the attacking role is genuinely restricted (NOBYPASSRLS, non-superuser, RLS active)", async () => {
    await asPartner(A, async () => {
      const { rows } = await client.query(
        `SELECT current_user AS who,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
                (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS super,
                current_setting('is_superuser')  AS is_superuser,
                current_setting('row_security')  AS row_security`
      );
      // Mirrors staging exactly: the RUNTIME role partner_app_staging is rolbypassrls = FALSE,
      // while only the ADMIN role neondb_owner is TRUE. If this ever flips, every cross-tenant
      // assertion in this file would pass vacuously — so it fails here first, loudly.
      expect(rows[0].who).toBe("partner_runtime");
      expect(rows[0].bypass).toBe(false);
      expect(rows[0].super).toBe(false);
      expect(rows[0].is_superuser).toBe("off");
      expect(rows[0].row_security).toBe("on");
    });
  });

  /**
   * The catalogue itself — asked once, reused by the three sweep assertions below so they cannot
   * drift apart. NO allowlist filter: whatever the migration chain created is what gets checked.
   */
  async function tenantKeyedPartnerTables() {
    const { rows } = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'partner\\_%'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                         AND a.attnum > 0 AND NOT a.attisdropped)
        ORDER BY c.relname`
    );
    return rows;
  }

  it("every partner table carrying tenant_id has RLS ENABLED, FORCED and an isolation policy", async () => {
    // Coverage sweep, driven by the CATALOGUE rather than by an inclusion allowlist: this is what
    // catches a NEW tenant-scoped table landing in a future migration with the RLS block
    // forgotten. FORCE matters because without it the table OWNER is exempt from its own policies.
    // See RLS_EXEMPT_TENANT_TABLES for why an exclusion register replaced the old TENANT_TABLES
    // scoping, and for the one entry that is an open defect rather than a real exception.
    const rows = await tenantKeyedPartnerTables();
    const unprotected = rows
      .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies < 1)
      .map((r) => r.relname);

    // Both directions. Left-to-right: a new unprotected tenant table fails closed. Right-to-left:
    // an exception that has since been fixed (or whose table was dropped) fails too, so the
    // register cannot rot into a permanent blanket amnesty.
    expect(unprotected.sort()).toEqual(Object.keys(RLS_EXEMPT_TENANT_TABLES).sort());

    // Floors, so neither the chain shrinking nor a table being dropped can quietly reduce the
    // sweep to a vacuous pass.
    const names = rows.map((r) => r.relname);
    expect(TENANT_TABLES.filter((t) => !names.includes(t))).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(TENANT_TABLES.length);
    // The sweep must be materially wider than the 11-name list it replaced — the whole point of
    // A8-F4. If a future refactor reintroduces allowlist scoping, this is what notices.
    expect(rows.length).toBeGreaterThan(TENANT_TABLES.length);
  });

  it("no RLS-less tenant table is reachable by partner_runtime except the pinned open defect", async () => {
    // The grant is what turns "no RLS" into "cross-tenant read". Pinning the grant set per exempt
    // table means a future migration handing partner_runtime access to any currently-unreachable
    // exempt table fails here, even though the RLS sweep above would still pass.
    const rows = await tenantKeyedPartnerTables();
    const exempt = rows
      .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies < 1)
      .map((r) => r.relname);

    const { rows: grants } = await client.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'partner_runtime' AND table_name = ANY($1::text[])`,
      [exempt]
    );

    const actual = Object.fromEntries(exempt.map((t) => [t, [] as string[]]));
    for (const g of grants) actual[g.table_name].push(g.privilege_type);
    for (const t of exempt) actual[t] = [...new Set(actual[t])].sort();

    const expected = Object.fromEntries(
      exempt.map((t) => [t, [...(RLS_EXEMPT_TENANT_TABLES[t]?.partnerRuntimeGrants ?? [])].sort()])
    );
    expect(actual).toEqual(expected);
  });

  it("KNOWN OPEN (A8-F1): partner_owner_invariant_tenants leaks every tenant to partner_runtime", async () => {
    // This asserts the DEFECT, deliberately. It is the behavioural counterpart to the register
    // entry above: as long as 0032's omission is live, the leak is reproduced on every run instead
    // of being a line in a document. When the repair migration lands, this test goes RED — which
    // is the intended signal to delete it together with the register entry.
    //
    // Contrast arm: partner_organisations, an RLS-protected table on the same connection with the
    // same GUC, returns only tenant A's row. So this is not a fixture artefact or a missing tenant
    // context — it is the table ignoring tenant context entirely.
    //
    // FIXTURE PROVENANCE: the two rows this reads are NOT hand-inserted into
    // partner_owner_invariant_tenants. They are produced by 0032's own trigger function
    // partner_enforce_final_owner_invariant() — the only writer that exists in production — fired
    // by an ordinary partner_user_roles INSERT that makes an ACTIVE user a PARTNER_OWNER. Two
    // throwaway tenants are used so the shared A/B fixture is untouched. (The PARTNER_OWNER role
    // row is created here because 0034's seed uses ON COMMIT DROP temp tables and leaves
    // partner_roles empty under this suite's statement-at-a-time migration application.)
    const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const ownerRole = "eeeeeeee-0000-0000-0000-00000000000e";
    await client.query(
      `INSERT INTO partner_roles (id, code, label) VALUES ($1,'PARTNER_OWNER','Partner Owner')
         ON CONFLICT (code) DO NOTHING`,
      [ownerRole]
    );
    const roleId = (await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code='PARTNER_OWNER'"))
      .rows[0].id;
    for (const [tenant, tag] of [
      [C, "c"],
      [D, "d"],
    ] as const) {
      await client.query(
        `INSERT INTO partner_organisations (id, public_ref, legal_name, status)
           VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
        [tenant, `ref${tag.toUpperCase()}`, `${tag.toUpperCase()} Ltd`]
      );
      const userId = `ffff0000-0000-0000-0000-00000000000${tag === "c" ? "1" : "2"}`;
      await client.query(
        `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status)
           VALUES ($1, $2, $3, $3, $4, 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
        [userId, `u${tag}`, tenant, `${tag}@owner.test`]
      );
      // THIS is the production write path. The trigger on partner_user_roles is what inserts into
      // partner_owner_invariant_tenants; nothing in this test writes to that table directly.
      await client.query(
        `INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
        [tenant, userId, roleId]
      );
    }
    const seeded = await client.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_owner_invariant_tenants WHERE tenant_id = ANY($1::uuid[])",
      [[C, D]]
    );
    // Precondition, not the assertion: if the production trigger did not populate the table, the
    // leak assertion below would pass or fail for the wrong reason.
    expect(seeded.rows[0].n).toBe(2);

    await asPartner(A, async () => {
      const isolated = await client.query<{ n: number }>(
        "SELECT count(*)::int n FROM partner_organisations WHERE id = ANY($1::uuid[])",
        [[C, D]]
      );
      expect(isolated.rows[0].n).toBe(0);

      const leaked = await client.query<{ n: number }>(
        "SELECT count(*)::int n FROM partner_owner_invariant_tenants WHERE tenant_id = ANY($1::uuid[])",
        [[C, D]]
      );
      // Tenant A holds no relationship whatsoever to C or D, yet reads both.
      expect(leaked.rows[0].n).toBe(2);
    });
  });

  // =========================================================================================
  // CROSS-TENANT READ — on the tables the pilot actually uses.
  // =========================================================================================

  for (const table of TENANT_TABLES) {
    it(`cross-tenant SELECT on ${table}: tenant A sees its own row and ZERO of tenant B's`, async () => {
      await asPartner(A, async () => {
        const { rows } = await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE tenant_id = $1)::int AS b_rows,
                  count(*) FILTER (WHERE tenant_id = $2)::int AS a_rows
             FROM ${table}`,
          [B, A]
        );
        expect(rows[0].b_rows).toBe(0);
        expect(rows[0].a_rows).toBeGreaterThanOrEqual(1);
        // Nothing outside A is visible at all — not even rows belonging to no tenant.
        expect(rows[0].total).toBe(rows[0].a_rows);
      });
    });
  }

  it("no existence oracle: selecting tenant B's exact primary keys returns 0 rows, not an error", async () => {
    await asPartner(A, async () => {
      for (const [table, id] of [
        ["partner_customers", ID.custB],
        ["partner_submissions", ID.subB],
        ["partner_submission_cards", ID.cardB],
        ["partner_wallets", ID.walletB],
        ["partner_credit_reservations", ID.resB],
      ] as const) {
        const { rows } = await client.query(`SELECT count(*)::int n FROM ${table} WHERE id = $1`, [id]);
        expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
      }
    });
  });

  it("the reporting VIEWS do not leak across tenants (security_invoker, not owner rights)", async () => {
    // A view owned by a BYPASSRLS role runs with the OWNER's rights unless security_invoker=true,
    // which would hand every tenant a full cross-tenant read of wallet balances and credit
    // availability. Assert the behaviour AND the option that produces it.
    const opts = await client.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relkind = 'v' AND relname IN ('partner_wallet_balances','partner_credit_availability')`
    );
    expect(opts.rows.length).toBe(2);
    for (const v of opts.rows) {
      expect({ v: v.relname, opts: v.reloptions ?? [] }).toEqual({
        v: v.relname,
        opts: expect.arrayContaining(["security_invoker=true"]),
      });
    }
    await asPartner(A, async () => {
      for (const view of ["partner_wallet_balances", "partner_credit_availability"] as const) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE tenant_id = $1)::int AS b_rows FROM ${view}`,
          [B]
        );
        expect({ view, ...rows[0] }).toEqual({ view, total: 1, b_rows: 0 });
      }
    });
  });

  // =========================================================================================
  // CROSS-TENANT WRITE — UPDATE / DELETE / INSERT / tenant-hop.
  // =========================================================================================

  it("cross-tenant UPDATE affects ZERO rows on submissions, cards and customers", async () => {
    await asPartner(A, async () => {
      const s = await client.query("UPDATE partner_submissions SET status='cancelled' WHERE tenant_id=$1", [B]);
      const c = await client.query("UPDATE partner_submission_cards SET card_name='hacked' WHERE tenant_id=$1", [B]);
      const k = await client.query(
        "UPDATE partner_customers SET full_name='hacked', email='attacker@evil.test' WHERE tenant_id=$1",
        [B]
      );
      expect({ s: s.rowCount, c: c.rowCount, k: k.rowCount }).toEqual({ s: 0, c: 0, k: 0 });
      // Blind UPDATE with no WHERE at all must also spare B.
      const blind = await client.query("UPDATE partner_submissions SET intake_notes='blind'");
      expect(blind.rowCount).toBe(1); // only A's own row
    });
    // B's records are byte-for-byte intact, checked as superuser (which bypasses RLS).
    const { rows } = await client.query(
      `SELECT (SELECT status    FROM partner_submissions      WHERE id=$1) AS sub_status,
              (SELECT card_name FROM partner_submission_cards WHERE id=$2) AS card_name,
              (SELECT full_name FROM partner_customers        WHERE id=$3) AS cust_name,
              (SELECT intake_notes FROM partner_submissions   WHERE id=$1) AS sub_notes`,
      [ID.subB, ID.cardB, ID.custB]
    );
    expect(rows[0]).toEqual({ sub_status: "draft", card_name: "Card B", cust_name: "Cust B", sub_notes: null });
  });

  it("cross-tenant DELETE is refused outright where no DELETE grant exists, and hits 0 rows where it does", async () => {
    await asPartner(A, async () => {
      // No DELETE grant at all — submissions/cards/customers are soft-delete-only by design, so
      // the attack fails one layer EARLIER than RLS, at the privilege check.
      for (const table of ["partner_submissions", "partner_submission_cards", "partner_customers"] as const) {
        await expect(client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [B])).rejects.toThrow(
          /permission denied/i
        );
      }
      // partner_users DOES carry a DELETE grant, so here RLS itself is the only thing standing
      // between tenant A and deleting tenant B's staff accounts. It must report 0 rows.
      const d = await client.query("DELETE FROM partner_users WHERE tenant_id=$1", [B]);
      expect(d.rowCount).toBe(0);
      const blind = await client.query("DELETE FROM partner_users WHERE email='b@x.test'");
      expect(blind.rowCount).toBe(0);
    });
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_users WHERE tenant_id=$1", [B]);
    expect(rows[0].n).toBe(1);
  });

  it("cross-tenant INSERT (a row stamped with tenant B) is refused by WITH CHECK", async () => {
    await asPartner(A, async () => {
      await expect(
        client.query("INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,'planted')", [B])
      ).rejects.toThrow(/row-level security/i);
      await expect(
        client.query(
          `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,status)
           VALUES ($1,$2,$3,'planted','draft')`,
          [B, ID.locB, ID.userB]
        )
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name)
           VALUES ($1,$2,99,'planted')`,
          [B, ID.subB]
        )
      ).rejects.toThrow(/row-level security/i);
    });
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_submissions WHERE public_ref='planted'");
    expect(rows[0].n).toBe(0);
  });

  it("tenant-hop is refused: A cannot re-stamp its OWN row with tenant B's id", async () => {
    // The subtlest escape: don't touch B's rows, push your own across the boundary instead. The
    // policy's WITH CHECK arm is what stops it — USING alone would let this through.
    await asPartner(A, async () => {
      await expect(
        client.query("UPDATE partner_submissions SET tenant_id=$1 WHERE tenant_id=$2", [B, A])
      ).rejects.toThrow(/row-level security/i);
      await expect(
        client.query("UPDATE partner_customers SET tenant_id=$1 WHERE tenant_id=$2", [B, A])
      ).rejects.toThrow(/row-level security/i);
    });
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_submissions WHERE tenant_id=$1", [B]);
    expect(rows[0].n).toBe(1);
  });

  it("MONEY: the runtime role cannot mint, adjust or forge credit for itself or anyone else", async () => {
    // The credit tables are SELECT-only to partner_runtime by design — all mutation goes through
    // super-admin/definer paths. A partner that could INSERT a ledger row could grade for free.
    await asPartner(A, async () => {
      await expect(
        client.query(
          `INSERT INTO partner_credit_ledger
             (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint)
           VALUES ($1,$2,1000000,'purchase','self-topup','admin','free money','admin',$3)`,
          [ID.walletA, A, FP_A]
        )
      ).rejects.toThrow(/permission denied/i);
      await expect(client.query("UPDATE partner_credit_ledger SET amount=amount+1000")).rejects.toThrow(
        /permission denied/i
      );
      await expect(client.query("DELETE FROM partner_credit_ledger")).rejects.toThrow(/permission denied/i);
      await expect(client.query("UPDATE partner_wallets SET status='active'")).rejects.toThrow(/permission denied/i);
      // Reservations likewise: forging one would consume credit that was never bought, and
      // releasing tenant B's would free their reserved credit.
      await expect(
        client.query("UPDATE partner_credit_reservations SET status='released', released_at=now() WHERE tenant_id=$1", [
          B,
        ])
      ).rejects.toThrow(/permission denied/i);
      await expect(client.query("DELETE FROM partner_credit_reservations")).rejects.toThrow(/permission denied/i);
    });
    const { rows } = await client.query("SELECT balance::int FROM partner_wallet_balances WHERE tenant_id=$1", [B]);
    expect(rows[0].balance).toBe(999); // tenant B's balance untouched
  });

  it("MONEY: the credit ledger is immutable even to the table OWNER, by trigger", async () => {
    // Grants stop partner_runtime; these triggers stop everyone, including the migration owner and
    // any future code that reaches the ledger on an admin connection. They are the last line of
    // defence for balances, so assert they exist and are ENABLED — a disabled trigger (tgenabled
    // 'D') looks identical to a present one in a schema diff.
    const { rows } = await client.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgrelid IN ('partner_credit_ledger'::regclass, 'partner_credit_reservation_events'::regclass)
        ORDER BY tgname`
    );
    const names = rows.map((r) => r.tgname);
    expect(names).toEqual(expect.arrayContaining(["trg_partner_credit_ledger_no_row_mutate"]));
    expect(names).toEqual(expect.arrayContaining(["trg_partner_credit_ledger_no_truncate"]));
    for (const r of rows) expect({ t: r.tgname, on: r.tgenabled }).toEqual({ t: r.tgname, on: "O" });
    // And behaviourally, as the superuser/owner — not merely present, actually enforcing.
    await expect(client.query("UPDATE partner_credit_ledger SET amount = amount + 1")).rejects.toThrow(/append-only/i);
    await expect(client.query("DELETE FROM partner_credit_ledger")).rejects.toThrow(/append-only/i);
  });

  it("submission events are append-only for the runtime role (no history rewriting)", async () => {
    await asPartner(A, async () => {
      await client.query(
        "INSERT INTO partner_submission_events (tenant_id,submission_id,event_type) VALUES ($1,$2,'noted')",
        [A, ID.subA]
      );
      await expect(client.query("UPDATE partner_submission_events SET event_type='forged'")).rejects.toThrow(
        /permission denied/i
      );
      await expect(client.query("DELETE FROM partner_submission_events")).rejects.toThrow(/permission denied/i);
    });
  });

  // =========================================================================================
  // CONTEXT INTEGRITY — fail-closed, and no stale plan.
  // =========================================================================================

  for (const [label, ctx] of [
    ["missing", null],
    ["empty", ""],
    ["malformed", "not-a-uuid"],
  ] as const) {
    it(`${label} tenant context fails closed to 0 rows on every pilot table`, async () => {
      await asPartner(ctx, async () => {
        for (const table of TENANT_TABLES) {
          const { rows } = await client.query(`SELECT count(*)::int n FROM ${table}`);
          expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
        }
      });
    });
  }

  it("the RLS predicate is re-evaluated per execution — a cached generic plan cannot freeze a tenant in", async () => {
    // Real-world failure mode: PostgreSQL switches a server-side prepared statement from a custom
    // plan to a GENERIC plan after ~5 executions. If the tenant predicate were folded into that
    // generic plan, a long-lived pooled connection would keep serving the FIRST tenant's rows to
    // every subsequent tenant. Alternate A/B across the switchover on one named statement.
    await asPartner(A, async () => {
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        await client.query("SELECT set_config('app.tenant_id',$1,false)", [i % 2 === 0 ? A : B]);
        const { rows } = await client.query({
          name: "rls_plan_cache_probe",
          text: "SELECT coalesce(string_agg(public_ref, ',' ORDER BY public_ref), '') AS refs FROM partner_submissions",
        });
        seen.push(rows[0].refs);
      }
      expect(seen).toEqual(["sa", "sb", "sa", "sb", "sa", "sb", "sa", "sb"]);
    });
  });

  // =========================================================================================
  // KNOWN GAP — cross-tenant FK pivot. Characterised, not fixed: migrations/ is owned elsewhere.
  //
  // PostgreSQL evaluates referential-integrity checks with an internal snapshot that is NOT
  // subject to RLS. 0007's FKs are SINGLE-COLUMN (submission_id, customer_id, location_id), so the
  // restricted role CAN create its own row pointing at another tenant's parent. 0016/0017 avoided
  // this deliberately with tenant-composite FKs — FOREIGN KEY (wallet_id, tenant_id) REFERENCES
  // partner_wallets(id, tenant_id) — which make the pivot impossible because no such pair exists.
  //
  // These tests pin the CURRENT behaviour and, more importantly, pin the CONTAINMENT boundary that
  // still holds (no read amplification, invisible to the victim). They will FAIL the day 0007 is
  // hardened, which is the intended signal to update them. See the report for the proposed fix.
  // =========================================================================================

  it("KNOWN GAP: card FK pivot remains possible, but submission customer/location pivot is refused", async () => {
    await asPartner(A, async () => {
      // A card owned by A, hung off tenant B's submission.
      await client.query(
        `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name)
         VALUES ($1,$2,900,'pivot-card')`,
        [A, ID.subB]
      );
      // A submission owned by A, referencing tenant B's customer and location.
      await expect(
        client.query(
          `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,customer_id,status)
         VALUES ($1,$2,$3,'pivot-sub',$4,'draft')`,
          [A, ID.locB, ID.userA, ID.custB]
        )
      ).rejects.toThrow();
    });
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM partner_submission_cards WHERE card_name='pivot-card') AS cards,
              (SELECT count(*)::int FROM partner_submissions      WHERE public_ref='pivot-sub')  AS subs`
    );
    expect(rows[0]).toEqual({ cards: 1, subs: 0 });
  });

  it("CONTAINMENT HOLDS: the card pivot yields no cross-tenant READ and failed submission pivot is absent", async () => {
    await asPartner(A, async () => {
      const joined = await client.query(
        `SELECT s.public_ref AS leaked
           FROM partner_submission_cards c
          LEFT JOIN partner_submissions s ON s.id = c.submission_id
         WHERE c.card_name = 'pivot-card'`
      );
      expect(joined.rows[0].leaked).toBeNull();
      const cust = await client.query(
        `SELECT k.full_name AS leaked
           FROM partner_submissions s
          LEFT JOIN partner_customers k ON k.id = s.customer_id
         WHERE s.public_ref = 'pivot-sub'`
      );
      expect(cust.rowCount).toBe(0);
      const loc = await client.query(
        `SELECT l.name AS leaked
           FROM partner_submissions s
          LEFT JOIN partner_locations l ON l.id = s.location_id
         WHERE s.public_ref = 'pivot-sub'`
      );
      expect(loc.rowCount).toBe(0);
    });
    await asPartner(B, async () => {
      const { rows } = await client.query(
        `SELECT (SELECT count(*)::int FROM partner_submission_cards WHERE card_name='pivot-card') AS cards,
                (SELECT count(*)::int FROM partner_submission_cards) AS all_cards`
      );
      expect(rows[0]).toEqual({ cards: 0, all_cards: 1 }); // B's own view is uncontaminated
    });
    // cleanup so later state stays deterministic
    await client.query("DELETE FROM partner_submission_cards WHERE card_name='pivot-card'");
    await client.query("DELETE FROM partner_submissions WHERE public_ref='pivot-sub'");
  });

  it("KNOWN GAP: the same FK path is an existence oracle for other tenants' uuids", async () => {
    await asPartner(A, async () => {
      // A uuid that exists in NO tenant is rejected by the FK...
      await expect(
        client.query(
          `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,customer_id,status)
           VALUES ($1,$2,$3,'oracle-miss',$4,'draft')`,
          [A, ID.locA, ID.userA, ID.absent]
        )
      ).rejects.toThrow(/foreign key constraint/i);
      // ...while tenant B's real customer id is ACCEPTED. The difference is the oracle.
      await client.query(
        `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,customer_id,status)
         VALUES ($1,$2,$3,'oracle-hit',$4,'draft')`,
        [A, ID.locA, ID.userA, ID.custB]
      );
    });
    await client.query("DELETE FROM partner_submissions WHERE public_ref='oracle-hit'");
  });

  it("the CREDIT layer is immune to the pivot: its FKs are tenant-composite", async () => {
    // Positive regression guard for the pattern that 0007 should adopt. If anyone "simplifies"
    // these back to single-column FKs, the credit tables inherit the gap above and this reddens.
    const { rows } = await client.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('partner_credit_ledger'::regclass,
                           'partner_credit_reservations'::regclass,
                           'partner_credit_reservation_events'::regclass)
        ORDER BY conname`
    );
    const walletFks = rows.filter((r) => r.def.includes("REFERENCES partner_wallets"));
    expect(walletFks.length).toBeGreaterThanOrEqual(2);
    for (const fk of walletFks) {
      expect({ fk: fk.conname, composite: /FOREIGN KEY \(wallet_id, tenant_id\)/.test(fk.def) }).toEqual({
        fk: fk.conname,
        composite: true,
      });
    }
  });
});
