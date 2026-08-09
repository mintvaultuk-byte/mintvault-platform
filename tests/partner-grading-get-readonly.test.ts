/**
 * H2-GET-READONLY — a GET on the partner grading adapter must not transition partner state.
 *
 * WHAT THIS PINS
 * --------------
 * `GET /api/partner/grading/certificates/:id/images` used to run an unpredicated
 *
 *     UPDATE partner_grading_work_items
 *        SET certificate_id = ...,
 *            status = CASE WHEN assigned_partner_grader_id IS NULL THEN status ELSE 'assigned' END
 *
 * with NO condition on the work item's CURRENT status. `authorizeAssigned` only rejects a
 * certificate whose grader_status is `approved`, so a card sitting at `pending_review` passed the
 * gate, and merely LOOKING at its images knocked the work item back to `assigned`.
 *
 * That is terminal, not cosmetic. `mirrorPartnerApproval` keys on `pgwi.status = 'pending_review'`
 * (server/partner/grading-review-mirror.ts), so after the regression it returns `not_partner` —
 * which server/routes/grader.ts treats as SUCCESS. The Super Admin sees 200 {ok:true}, the
 * certificate publishes, the work item freezes at `assigned`, the destination submission never
 * reaches `ready_to_return`, settlement never runs and the reserved credits are held for 365 days.
 * There is no in-app recovery.
 *
 * The client reaches this route on every image load and on every invalidation after a recrop
 * (client/src/components/grading/grading-panel.tsx and
 * client/src/components/grading-workflow/CardPreviewPanel.tsx), and the partner queue
 * hands the workstation `pending_review` cards, so the path is ordinary use, not an attack.
 *
 * WHY THE PROOF RUNS ALL SIX STEPS. Asserting only "the work item is still pending_review" would
 * pass against a route that had been broken some other way. This suite carries the assertion
 * THROUGH to the money: after the GET, the Super Admin approval must still mirror, the destination
 * must still move to `ready_to_return`, and the wallet must still settle to consumed. That whole
 * chain is what the regression destroyed.
 *
 * PATTERN. Mounting and login follow tests/partner-grading-http-routes.test.ts; the wallet /
 * settlement half follows tests/partner-full-pilot-workflow.test.ts, including its precedent of
 * reproducing the Super Admin publish UPDATE verbatim rather than importing the protected
 * server/grader.ts, and then calling the REAL production mirror.
 *
 * SELF-PROVISIONING: starts its own PostgreSQL 17 and needs the disposable MinIO the rest of CI
 * already provides (the images route verifies both objects with a live headR2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  setupPartnerTestStorage,
  partnerTestStorageConfigured,
  ONE_PIXEL_PNG,
  type PartnerTestStorage,
} from "./helpers/partner-test-storage";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  createMintvaultCertificatesTable,
  alignCertificatesTableToSchema,
  createMintvaultLabelPrintsTable,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
} from "./helpers/partner-realistic-db";

const RUNTIME_LOGIN = "partner_app_test_get_readonly";
const OWNER_PASSWORD = "GetReadonly!Passw0rd";
const SUPER_ADMIN = "get-readonly-super-admin@example.test";
const ADMIN_ACTOR = { actorUserId: null, actorEmail: SUPER_ADMIN };
const storageReady = partnerTestStorageConfigured();

let cluster: DisposablePostgres17;
let admin: Client;
let storage: PartnerTestStorage;
let server: http.Server;
let base: string;
let closePartnerPools: (() => Promise<void>) | undefined;
let mirror: typeof import("../server/partner/grading-review-mirror");
let creditReservations: typeof import("../server/partner/partner-credit-reservation-service");
let wallet: typeof import("../server/partner/partner-wallet-service");
let submissions: typeof import("../server/partner/submission-service");
let sequence = 0;

type Json = Record<string, unknown>;

/**
 * CI WIRING GUARD — outside the storage gate on purpose, so an absent MinIO cannot turn the only
 * behavioural evidence for H2 into a silent skip on a green build.
 */
describe("H2 GET-read-only coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (!process.env.CI && !process.env.GITHUB_ACTIONS) return;
    expect(
      storageReady,
      "PARTNER_REAL_R2_PROOF_ENDPOINT/_KEY/_SECRET must be set in CI — the images route verifies both objects with a live headR2"
    ).toBe(true);
  });
});

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {}
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    /* non-JSON body — assertions use `status` */
  }
  return { status: res.status, body };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/partner/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: OWNER_PASSWORD }),
  });
  expect(res.status, `partner login for ${email} must succeed`).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("mv.partner.sid");
  return cookie;
}

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const r = await admin.query(sql, params);
  return Object.values(r.rows[0])[0] as T;
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

async function seedMintVaultTables(): Promise<void> {
  await admin.query(`CREATE TABLE users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar, last_name varchar,
    profile_image_url varchar, role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), password_hash text,
    display_name text, email_verified boolean NOT NULL DEFAULT false, email_verified_at timestamp,
    last_login_at timestamp, last_login_ip text, failed_login_count integer NOT NULL DEFAULT 0,
    locked_until timestamp, last_failed_login_at timestamp, credential_version integer NOT NULL DEFAULT 1,
    admin_passphrase_hash text, pin_hash text, pin_set_at timestamp, pin_failed_count integer NOT NULL DEFAULT 0,
    pin_locked_until timestamp, public_name boolean NOT NULL DEFAULT false,
    can_grade boolean NOT NULL DEFAULT false, can_scan boolean NOT NULL DEFAULT false,
    can_print boolean NOT NULL DEFAULT false, can_edit_sets boolean NOT NULL DEFAULT false,
    review_rate integer NOT NULL DEFAULT 100)`);
  await admin.query(`CREATE TABLE submissions (
    id serial PRIMARY KEY, user_id varchar, status varchar(30) NOT NULL DEFAULT 'draft',
    tracking_number text NOT NULL UNIQUE, service_tier text, deleted_at timestamptz,
    shipped_at timestamptz, completed_at timestamptz,
    status_history jsonb NOT NULL DEFAULT '[]'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())`);
  await admin.query(
    "CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL REFERENCES submissions(id))"
  );
  // loadPartnerCert LEFT JOINs `cards` to resolve the destination submission, so it must exist.
  await admin.query("CREATE TABLE cards (id serial PRIMARY KEY, submission_id integer REFERENCES submissions(id))");
  await admin.query(`CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
  await createMintvaultCertificatesTable(admin);
  await alignCertificatesTableToSchema(admin);
  await createMintvaultLabelPrintsTable(admin);
  await admin.query(
    "CREATE TABLE cert_counter (id integer PRIMARY KEY DEFAULT 1, last_issued integer NOT NULL DEFAULT 0)"
  );
  await admin.query("CREATE UNIQUE INDEX uq_submission_items_submission ON submission_items (submission_id, id)");
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "audit_log",
    "cards",
    "certificates",
    "label_prints",
    "cert_counter",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/** 0022 adds certificates.print_state and the print_batches/print_events tables. */
async function applyPrintLifecycle(): Promise<void> {
  await admin.query(readFileSync(join(process.cwd(), "migrations", "0022_print_workflow_lifecycle.sql"), "utf8"));
  for (const t of ["print_batches", "print_events"]) await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
}

async function setGlobalFlag(flag: string, enabled: boolean): Promise<void> {
  await admin.query("DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL", [
    flag,
  ]);
  await admin.query(
    "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL,NULL,$1,$2)",
    [flag, enabled]
  );
}

/** The principal shape the production submit service expects. */
function principalFor(f: { tenantId: string; locationId: string; graderId: string }) {
  return {
    sessionId: `h2-get-readonly-${f.tenantId}`,
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

interface Fixture {
  tenantId: string;
  locationId: string;
  graderId: string;
  graderEmail: string;
  partnerSubmissionId: string;
  destinationSubmissionId: number;
  certId: number;
  workItemId: string;
}

/**
 * ONE physical card, funded with 10 credits, carried through the REAL production submit (so the
 * reservation is created the way production creates it — hand-seeding reservations is what
 * produced reservation_link_inconsistent), then hand-placed at the exact post-grading state:
 * work item `pending_review`, certificate `pending_review` with a complete numeric grade and all
 * four sub-grades so the B3 publish gate passes on its own merits.
 *
 * One card, not two, so a SINGLE Super Admin approval is the last one — which is what makes the
 * mirror fire and settlement run inside this test.
 */
async function seedAtPendingReview(): Promise<Fixture> {
  const n = ++sequence;
  const uniq = randomUUID().slice(0, 8);

  const tenantId = await scalar<string>(
    "INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id",
    [`h2-org-${n}-${uniq}`, `H2 GET ${n} Ltd`]
  );
  const locationId = await scalar<string>(
    "INSERT INTO partner_locations (tenant_id, partner_id, public_ref, name, status) VALUES ($1,$1,$2,$3,'ACTIVE') RETURNING id",
    [tenantId, `h2-loc-${n}-${uniq}`, `H2 GET ${n} HQ`]
  );
  const graderEmail = `h2-grader-${n}-${uniq}@example.test`;
  const graderId = await scalar<string>(
    `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required)
     VALUES ($1,$2,$2,$3,$4,'ACTIVE',false) RETURNING id`,
    [`h2-user-${n}-${uniq}`, tenantId, graderEmail, await bcrypt.hash(OWNER_PASSWORD, 10)]
  );
  await admin.query(
    "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
    [tenantId, graderId]
  );
  await admin.query("INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)", [
    tenantId,
    graderId,
    locationId,
  ]);

  const customerId = await scalar<string>(
    "INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,$2) RETURNING id",
    [tenantId, `H2 GET Customer ${n}`]
  );
  const tierCode = `h2-tier-${n}-${uniq}`;
  await admin.query(
    `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active)
     VALUES ($1,$2,'H2 Tier',1500,20,true)`,
    [tenantId, tierCode]
  );
  const partnerSubmissionId = await scalar<string>(
    `INSERT INTO partner_submissions
       (tenant_id, location_id, created_by, card_count, status, customer_id, service_tier_code, submitted_at)
     VALUES ($1,$2,$3,1,'draft',$4,$5, NULL) RETURNING id`,
    [tenantId, locationId, graderId, customerId, tierCode]
  );

  const cardId = randomUUID();
  const frontKey = `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/front-h2.jpg`;
  const backKey = `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/back-h2.jpg`;
  await admin.query(
    `INSERT INTO partner_submission_cards
       (id, tenant_id, submission_id, sequence_number, card_name, quantity, front_image_key, back_image_key)
     VALUES ($1,$2,$3,1,$4,1,$5,$6)`,
    [cardId, tenantId, partnerSubmissionId, `H2 Card ${n}`, frontKey, backKey]
  );
  // REAL objects: both the submit route and the images route verify them with a live headR2.
  await storage.put(frontKey, ONE_PIXEL_PNG, "image/jpeg");
  await storage.put(backKey, ONE_PIXEL_PNG, "image/jpeg");

  await wallet.ensureWallet(ADMIN_ACTOR, tenantId);
  await wallet.appendFoundationCredit(ADMIN_ACTOR, {
    tenantId,
    amount: 10,
    entryType: "purchase",
    source: "admin",
    reason: "h2 get-readonly funding",
    idempotencyKey: `h2-fund-${n}-${uniq}`,
    actorType: "admin",
  });

  // REAL submit — this is what creates the handoff and the reservation.
  await submissions.submitSubmission(
    principalFor({ tenantId, locationId, graderId }),
    partnerSubmissionId,
    `h2-submit-${n}-${uniq}`
  );

  const handoffId = await scalar<string>("SELECT id FROM partner_submission_handoffs WHERE submission_id=$1", [
    partnerSubmissionId,
  ]);
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
    `INSERT INTO submissions (user_id, tracking_number, status, service_tier)
     VALUES ('h2-owner',$1,'in_grading','standard') RETURNING id`,
    [`MV-H2-${n}-${uniq}`]
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

  const itemId = await scalar<number>("INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id", [
    destinationSubmissionId,
  ]);
  const certId = await scalar<number>(
    `INSERT INTO certificates
       (certificate_number, submission_item_id, status, grade_type, grader_status,
        print_state, ownership_status, grade, centering_score, corners_score, edges_score, surface_score,
        assigned_grader_id, graded_by, review_required, graded_at, created_by, issued_at, updated_at,
        origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
        origin_location_id, origin_location_public_ref, origin_location_name,
        origin_captured_at, origin_snapshot_version)
     VALUES ($1,$2,'active','numeric','pending_review','awaiting_approval','unclaimed',
             9,9,9,9,9,$3,$3,true, now(),'partner_connector', now(), now(),
             'PARTNER',$4,$5,$6,$7,$8,$9, now(), 1)
     RETURNING id`,
    [
      `MVH2${9000 + n * 10}`,
      itemId,
      graderId,
      tenantId,
      `h2-org-ref-${n}-${uniq}`,
      `H2 GET ${n} Ltd`,
      locationId,
      `h2-loc-ref-${n}-${uniq}`,
      `H2 GET ${n} HQ`,
    ]
  );

  const workItemId = await scalar<string>(
    `INSERT INTO partner_grading_work_items
       (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_submission_card_id,
        partner_handoff_id, connector_import_id, connector_record_id, validation_run_id,
        destination_submission_id, submission_item_id, card_ordinal, status, assigned_partner_grader_id, assigned_at,
        certificate_id, certificate_linked_at, front_image_key, back_image_key, source_fingerprint,
        source_fingerprint_version)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'pending_review',$11, now(),$12, now(),$13,$14,$15,1) RETURNING id`,
    [
      tenantId,
      locationId,
      partnerSubmissionId,
      cardId,
      handoffId,
      importId,
      connectorId,
      validationRunId,
      destinationSubmissionId,
      itemId,
      graderId,
      certId,
      frontKey,
      backKey,
      "a".repeat(64),
    ]
  );

  return {
    tenantId,
    locationId,
    graderId,
    graderEmail,
    partnerSubmissionId,
    destinationSubmissionId,
    certId,
    workItemId,
  };
}

/**
 * Exactly what POST /api/admin/certificates/:id/approve-grader-grade does after requireSuperAdmin:
 * publish, then mirror. The publish half is the protected engine's statement, reproduced verbatim
 * (the precedent set by tests/partner-full-pilot-workflow.test.ts) so this suite never becomes a
 * reason to touch server/grader.ts. The MIRROR is the real production function.
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

async function workItemStatus(workItemId: string): Promise<string> {
  return await scalar<string>("SELECT status FROM partner_grading_work_items WHERE id=$1", [workItemId]);
}

(storageReady ? describe : describe.skip)("H2 — a GET on the partner grading adapter is read-only", () => {
  beforeAll(async () => {
    // MUST precede every server/* import: server/r2 memoises its S3 client at module scope.
    storage = await setupPartnerTestStorage({ bucketSuffix: "h2get" });

    cluster = await startPostgres17("partner-grading-get-readonly");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);
    await applyPrintLifecycle();

    // A synthetic LOGIN role inheriting the RESTRICTED partner_runtime — the session middleware and
    // the route handlers must never run as a superuser, which is the only way a FORCE-RLS gap in
    // the route under test could show up at all.
    await admin.query(`DROP ROLE IF EXISTS ${RUNTIME_LOGIN}`).catch(() => {});
    await admin.query(`CREATE ROLE ${RUNTIME_LOGIN} LOGIN PASSWORD 'synthetic'`);
    await admin.query(`GRANT partner_runtime TO ${RUNTIME_LOGIN}`);
    const runtimeUrl = (() => {
      const u = new URL(cluster.url);
      u.username = RUNTIME_LOGIN;
      u.password = "synthetic";
      return u.toString();
    })();

    // All four accounting URLs must resolve to the SAME database or
    // assertPartnerAccountingDatabaseTopology aborts every settlement call. server/db.ts resolves
    // its URL at MODULE LOAD, so every pin must precede the first import that reaches it.
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_CONNECTOR_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = runtimeUrl;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic, never a real key
    process.env.SESSION_SECRET = "synthetic-h2-get-readonly-session-secret";

    const dbMod = await import("../server/partner/db");
    closePartnerPools = dbMod.closePartnerPools;

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    for (const flag of ["partner_portal_enabled", "partner_login_enabled", "partner_connector_enabled"]) {
      await setGlobalFlag(flag, true);
    }
    await setGlobalFlag("partner_emergency_stop", false);

    mirror = await import("../server/partner/grading-review-mirror");
    creditReservations = await import("../server/partner/partner-credit-reservation-service");
    wallet = await import("../server/partner/partner-wallet-service");
    submissions = await import("../server/partner/submission-service");

    // ---- the app under test: server/routes.ts's partner registration lines, in that order ----
    const express = (await import("express")).default;
    const session = (await import("express-session")).default;
    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");

    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use(
      session({
        name: "mv.sid",
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax" },
      })
    );
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    // SENTINEL — so a 404 assertion can never be tautological.
    app.use((rq, rs) => rs.status(418).json({ sentinel: true, path: rq.path }));

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    await storage?.cleanup().catch(() => {});
    await new Promise<void>((r) => server?.close(() => r()));
    await closePartnerPools?.().catch(() => {});
    await admin?.query(`DROP ROLE IF EXISTS ${RUNTIME_LOGIN}`).catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("H2: fetching the images of a pending_review card does not strand it — approval, settlement and the wallet still complete", async () => {
    // ---- 1. a Partner card in pending_review -------------------------------------------------
    const f = await seedAtPendingReview();
    expect(await workItemStatus(f.workItemId), "precondition: the work item starts at pending_review").toBe(
      "pending_review"
    );
    expect(
      await scalar<string>("SELECT grader_status FROM certificates WHERE id=$1", [f.certId]),
      "precondition: the certificate is awaiting Super Admin review"
    ).toBe("pending_review");
    expect(await triple(f.tenantId), "precondition: 10 funded, 1 card submitted and reserved").toEqual({
      available: 9,
      reserved: 1,
      consumed: 0,
    });

    // ---- 2. GET the images route, exactly as the workstation does ------------------------------
    const cookie = await login(f.graderEmail);
    const images = await req("GET", `/api/partner/grading/certificates/${f.certId}/images`, { cookie });
    // Positive control: the route really ran and really served this card's images. Without it the
    // read-only assertion below could pass simply because the request 403'd or 500'd.
    expect(images.status, JSON.stringify(images.body)).toBe(200);
    const urls = (images.body.urls ?? {}) as Record<string, string>;
    expect(Object.keys(urls).sort(), "the GET served both signed image URLs").toEqual(
      ["back_display", "back_original", "front_display", "front_original"].sort()
    );

    // ---- 3. THE PROPERTY: the GET transitioned nothing -----------------------------------------
    expect(
      await workItemStatus(f.workItemId),
      "a GET must never move the work item — knocking it back to 'assigned' is what strands the card"
    ).toBe("pending_review");
    expect(
      await scalar<string>("SELECT grader_status FROM certificates WHERE id=$1", [f.certId]),
      "a GET must never move the certificate either"
    ).toBe("pending_review");

    // A second GET, because the grading panel refetches this key on every invalidation.
    expect((await req("GET", `/api/partner/grading/certificates/${f.certId}/images`, { cookie })).status).toBe(200);
    expect(await workItemStatus(f.workItemId), "still read-only on a repeat fetch").toBe("pending_review");

    // ---- 4. Super Admin approval succeeds — and genuinely MIRRORS -----------------------------
    const approval = await approveAsSuperAdmin(f.certId);
    // `not_partner` is the regression's signature: server/routes/grader.ts treats it as SUCCESS, so
    // the operator sees 200 {ok:true} over a work item that never moved.
    expect(approval.kind, "the approval must mirror onto the partner work item, not report not_partner").toBe(
      "mirrored"
    );
    expect(approval.allApproved).toBe(true);
    expect(await workItemStatus(f.workItemId)).toBe("approved");

    // ---- 5. settlement occurs -----------------------------------------------------------------
    expect(
      await scalar<string>("SELECT status FROM submissions WHERE id=$1", [f.destinationSubmissionId]),
      "the destination submission must reach ready_to_return — the trigger for settlement"
    ).toBe("ready_to_return");

    // ---- 6. the wallet reaches the expected consumed state -------------------------------------
    expect(await triple(f.tenantId), "the reserved credit must be consumed, not held for 365 days").toEqual({
      available: 9,
      reserved: 0,
      consumed: 1,
    });
  }, 120_000);
});
