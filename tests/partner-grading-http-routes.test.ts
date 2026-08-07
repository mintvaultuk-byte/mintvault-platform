/**
 * Partner grading adapter — REAL HTTP against /api/partner/grading/*.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Before it, NO suite anywhere in tests/ issued a single HTTP request to /api/partner/grading/*.
 * The whole adapter — the queue, the draft save, the submit-for-review transition and every
 * authorisation gate on them — rested on source-string pins in
 * tests/partner-shop-workflow-source.test.ts. The PR #288 mutation matrix measured exactly what
 * that is worth:
 *
 *   • REVIEW1 (`review_required = true` -> `false`) could only be caught at the CONTRACT layer.
 *   • GRADE1 (`partnerGradeBody(req.body)` -> `(req.body ?? {})`, i.e. deleting the PII strip)
 *     SURVIVED outright. The pin `not.toMatch(/applyCertGradeDraft\(certId,\s*req\.body/)` does not
 *     match that shape, and the accompanying `toContain("partnerGradeBody(req.body)")` stays
 *     satisfied by the two OTHER call sites. A control mutation using the literal `req.body` WAS
 *     caught — so the pin exists, it is simply evadable by rewriting one call site.
 *
 * A source pin can always be evaded by writing the same defect differently. The tests below assert
 * OBSERVED BEHAVIOUR through the mounted production router, so they do not care how the code is
 * spelled:
 *
 *   G1  private_notes supplied by a partner user does NOT reach the certificate, while a legitimate
 *       field on the SAME request does — so the test cannot pass vacuously by the write failing.
 *   G2  the camelCase spelling privateNotes is stripped too.
 *   G3  submitting for review moves the work item to pending_review and leaves the certificate
 *       UNPUBLISHED — review really is required, not merely reported.
 *   G4  a partner user cannot reach another tenant's certificate.
 *   G5  a partner user cannot grade a card assigned to a different grader.
 *   G6  the adapter is genuinely mounted (never 404) and genuinely authenticated (401 unauthenticated).
 *
 * G1/G2 are the behavioural replacement for GRADE1's evadable pin: `applyCertGradeDraft` writes
 * `private_notes = pick(body.private_notes, cert.privateNotes)` (server/grader.ts), so if the strip
 * is removed by ANY spelling, the partner-supplied value lands in an admin-internal column and G1
 * turns red.
 *
 * SELF-PROVISIONING: starts its own PostgreSQL 17 cluster, so it needs no database URL and cannot
 * collide with another suite. It needs the disposable MinIO the rest of CI already provides,
 * because the submit route verifies both card images with a live headR2 — a fixture cannot fake
 * that. The in-CI guard below fails the build if that storage is missing rather than skipping.
 *
 * server/grader.ts is READ, never modified, and never re-implemented here.
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

const RUNTIME_LOGIN = "partner_app_test_grading_http";
const OWNER_PASSWORD = "GradingHttp!Passw0rd";
const storageReady = partnerTestStorageConfigured();

let cluster: DisposablePostgres17;
let admin: Client;
let storage: PartnerTestStorage;
let server: http.Server;
let base: string;
let closePartnerPools: (() => Promise<void>) | undefined;
let sequence = 0;

type Json = Record<string, unknown>;

interface GradingFixture {
  tenantId: string;
  locationId: string;
  graderId: string;
  graderEmail: string;
  destinationSubmissionId: number;
  certIds: number[];
  submissionItemIds: number[];
  frontKeys: string[];
  backKeys: string[];
  partnerSubmissionId: string;
}

/**
 * CI WIRING GUARD — outside the gate on purpose.
 *
 * Without it an absent MinIO would make the whole file `describe.skip`, and the build would stay
 * green with the ONLY behavioural evidence for the partner grading adapter never running. That is
 * the exact failure mode the connector and RLS execution floors exist to stop.
 */
describe("Partner grading HTTP coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (!process.env.CI && !process.env.GITHUB_ACTIONS) return;
    expect(
      storageReady,
      "PARTNER_REAL_R2_PROOF_ENDPOINT/_KEY/_SECRET must be set in CI — the submit route verifies both card images with a live headR2"
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
  // The partner portal issues its OWN cookie, deliberately distinct from the admin `mv.sid` — a
  // shared name is what lets a staff login evict an admin session.
  expect(cookie).toContain("mv.partner.sid");
  return cookie;
}

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const r = await admin.query(sql, params);
  return Object.values(r.rows[0])[0] as T;
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
  // loadPartnerCert and the queue both LEFT JOIN `cards` to resolve the destination submission
  // (`COALESCE(c.submission_id, si.submission_id)`), so the table must exist even though this
  // fixture links certificates through submission_items. Without it every grading route 500s with
  // `relation "cards" does not exist` — which is exactly what an HTTP suite is for: no source-text
  // assertion could ever have found that.
  await admin.query(
    "CREATE TABLE cards (id serial PRIMARY KEY, submission_id integer REFERENCES submissions(id))"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
  await createMintvaultCertificatesTable(admin);
  /**
   * The narrow fixture table is not enough here: this suite drives the REAL `applyCertGradeDraft`,
   * which begins with `storage.getCertificate()` — a Drizzle `select()` over the FULL ~150-column
   * model. Align adds every declared column (plus the raw-SQL-only ones the model omits, including
   * `private_notes`, the column the partner PII strip exists to protect). Without it every grading
   * route 500s on a query naming columns the stub never had.
   */
  const aligned = await alignCertificatesTableToSchema(admin);
  if (!aligned.added.includes("private_notes")) {
    throw new Error("certificates.private_notes must exist — it is what the partner PII strip protects");
  }
  await createMintvaultLabelPrintsTable(admin);
  await admin.query(
    "CREATE TABLE cert_counter (id integer PRIMARY KEY DEFAULT 1, last_issued integer NOT NULL DEFAULT 0)"
  );
  // The composite FK target migration 0045 needs on the MintVault side.
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
  const sql = readFileSync(join(process.cwd(), "migrations", "0022_print_workflow_lifecycle.sql"), "utf8");
  await admin.query(sql);
  for (const t of ["print_batches", "print_events"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
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

/**
 * One partner tenant with one ACTIVE owner-grader, one destination submission and TWO cards whose
 * work items sit at `assigned` — the state the adapter is allowed to act on. Both card images are
 * written to the disposable MinIO under the SERVER-GENERATED key shape 0045's CHECK constraints
 * require, so the submit route's live headR2 verification passes for real.
 */
async function seedGradingFixture(opts: { privateNotes: string }): Promise<GradingFixture> {
  const n = ++sequence;

  const tenantId = await scalar<string>(
    "INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id",
    [`gh-org-${n}-${randomUUID().slice(0, 8)}`, `Grading HTTP ${n} Ltd`]
  );
  const locationId = await scalar<string>(
    "INSERT INTO partner_locations (tenant_id, partner_id, public_ref, name, status) VALUES ($1,$1,$2,$3,'ACTIVE') RETURNING id",
    [tenantId, `gh-loc-${n}-${randomUUID().slice(0, 8)}`, `Grading HTTP ${n} HQ`]
  );

  const graderEmail = `gh-grader-${n}-${randomUUID().slice(0, 8)}@example.test`;
  const graderId = await scalar<string>(
    `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required)
     VALUES ($1,$2,$2,$3,$4,'ACTIVE',false) RETURNING id`,
    [`gh-user-${n}-${randomUUID().slice(0, 8)}`, tenantId, graderEmail, await bcrypt.hash(OWNER_PASSWORD, 10)]
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
    [tenantId, `Grading HTTP Customer ${n}`]
  );
  const tierCode = `gh-tier-${n}`;
  await admin.query(
    `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active)
     VALUES ($1,$2,'Grading HTTP Tier',1500,20,true)`,
    [tenantId, tierCode]
  );

  const partnerSubmissionId = await scalar<string>(
    `INSERT INTO partner_submissions
       (tenant_id, location_id, created_by, card_count, status, customer_id, service_tier_code, submitted_at)
     VALUES ($1,$2,$3,2,'submitted_to_mintvault',$4,$5, now()) RETURNING id`,
    [tenantId, locationId, graderId, customerId, tierCode]
  );

  const cardIds: string[] = [];
  const frontKeys: string[] = [];
  const backKeys: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const cardId = randomUUID();
    const front = `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/front-gh.jpg`;
    const back = `partner-submissions/${tenantId}/${partnerSubmissionId}/${cardId}/back-gh.jpg`;
    await admin.query(
      `INSERT INTO partner_submission_cards
         (id, tenant_id, submission_id, sequence_number, card_name, quantity, front_image_key, back_image_key)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
      [cardId, tenantId, partnerSubmissionId, i, `Grading HTTP Card ${i}`, front, back]
    );
    // REAL objects, because the submit route verifies them with a live headR2.
    await storage.put(front, ONE_PIXEL_PNG, "image/jpeg");
    await storage.put(back, ONE_PIXEL_PNG, "image/jpeg");
    cardIds.push(cardId);
    frontKeys.push(front);
    backKeys.push(back);
  }

  const handoffId = await scalar<string>(
    `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot)
     VALUES ($1,$2,'pending',$3::jsonb) RETURNING id`,
    [tenantId, partnerSubmissionId, JSON.stringify({ cards: 2, fixture: "grading-http" })]
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
  const destinationSubmissionId = await scalar<number>(
    `INSERT INTO submissions (user_id, tracking_number, status, service_tier)
     VALUES ('gh-owner',$1,'in_grading','standard') RETURNING id`,
    [`MV-GH-${n}-${randomUUID().slice(0, 8)}`]
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
  const submissionItemIds: number[] = [];
  for (let i = 0; i < 2; i++) {
    const itemId = await scalar<number>(
      "INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id",
      [destinationSubmissionId]
    );
    const certId = await scalar<number>(
      // 0035's origin constraints are paired: a PARTNER certificate carries the full immutable
      // origin snapshot AND its capture metadata, or the row is rejected outright.
      `INSERT INTO certificates
         (certificate_number, submission_id, submission_item_id, status, grade_type, grader_status,
          print_state, created_by, issued_at, updated_at, private_notes,
          origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
          origin_location_id, origin_location_public_ref, origin_location_name,
          origin_captured_at, origin_snapshot_version)
       VALUES ($1,$2,$3,'active','numeric','assigned','awaiting_approval','partner_connector', now(), now(), $10,
               'PARTNER',$4,$5,$6,$7,$8,$9, now(), 1)
       RETURNING id`,
      [
        `MVGH${9000 + n * 10 + i}`,
        destinationSubmissionId,
        itemId,
        tenantId,
        `gh-org-ref-${n}`,
        `Grading HTTP ${n} Ltd`,
        locationId,
        `gh-loc-ref-${n}`,
        `Grading HTTP ${n} HQ`,
        opts.privateNotes,
      ]
    );
    await admin.query("UPDATE certificates SET assigned_grader_id=$2 WHERE id=$1", [certId, graderId]);
    certIds.push(certId);
    submissionItemIds.push(itemId);

    await admin.query(
      `INSERT INTO partner_grading_work_items
         (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_submission_card_id,
          partner_handoff_id, connector_import_id, connector_record_id, validation_run_id,
          destination_submission_id, submission_item_id, card_ordinal, status, assigned_partner_grader_id, assigned_at,
          certificate_id, certificate_linked_at, front_image_key, back_image_key, source_fingerprint,
          source_fingerprint_version)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'assigned',$11, now(),$12, now(),$13,$14,$15,1)`,
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
        certIds[i],
        frontKeys[i],
        backKeys[i],
        "a".repeat(64),
      ]
    );
  }

  return {
    tenantId,
    locationId,
    graderId,
    graderEmail,
    destinationSubmissionId,
    certIds,
    submissionItemIds,
    frontKeys,
    backKeys,
    partnerSubmissionId,
  };
}

(storageReady ? describe : describe.skip)("Partner grading adapter over real HTTP", () => {
  beforeAll(async () => {
    storage = await setupPartnerTestStorage({ bucketSuffix: "gradhttp" });

    cluster = await startPostgres17("partner-grading-http-routes");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);
    await applyPrintLifecycle();

    // A synthetic LOGIN role inheriting the RESTRICTED partner_runtime, exactly as the mount suite
    // does — the session middleware must never run as a superuser.
    await admin.query(`DROP ROLE IF EXISTS ${RUNTIME_LOGIN}`).catch(() => {});
    await admin.query(`CREATE ROLE ${RUNTIME_LOGIN} LOGIN PASSWORD 'synthetic'`);
    await admin.query(`GRANT partner_runtime TO ${RUNTIME_LOGIN}`);
    const runtimeUrl = (() => {
      const u = new URL(cluster.url);
      u.username = RUNTIME_LOGIN;
      u.password = "synthetic";
      return u.toString();
    })();

    // All four accounting URLs must resolve to the SAME database identity or
    // assertPartnerAccountingDatabaseTopology() aborts the suite. server/db.ts resolves its URL at
    // MODULE LOAD, so every pin must precede the first import that reaches it.
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_CONNECTOR_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = runtimeUrl;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic, never a real key
    process.env.SESSION_SECRET = "synthetic-grading-http-session-secret";

    const dbMod = await import("../server/partner/db");
    closePartnerPools = dbMod.closePartnerPools;

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    for (const flag of ["partner_portal_enabled", "partner_login_enabled"]) await setGlobalFlag(flag, true);

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
    // SENTINEL — so a 404 assertion can never be tautological (nothing else registers these paths).
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

  // =====================================================================================
  // G6 — the adapter is genuinely mounted and genuinely authenticated (control for everything).
  // =====================================================================================
  it("G6: /api/partner/grading/* is MOUNTED (never 404) and rejects an unauthenticated caller", async () => {
    const unauth = await req("GET", "/api/partner/grading/session");
    expect(unauth.status, "a 404 would mean the grading router is not mounted at all").not.toBe(404);
    expect(unauth.status, "the sentinel would mean the request travelled past the partner surface").not.toBe(418);
    expect(unauth.status).toBe(401);

    const f = await seedGradingFixture({ privateNotes: "unused" });
    const cookie = await login(f.graderEmail);
    const authed = await req("GET", "/api/partner/grading/session", { cookie });
    expect(authed.status).toBe(200);
    expect(authed.body.authenticated).toBe(true);
    expect(authed.body.userId).toBe(f.graderId);
  });

  // =====================================================================================
  // G1/G2 — GRADE1's behavioural replacement. The PII strip is proven by OBSERVATION.
  // =====================================================================================
  it("G1: private_notes sent by a partner user NEVER reaches the certificate, while a legitimate field on the same request does", async () => {
    const sentinel = `ADMIN-ONLY-${randomUUID()}`;
    const f = await seedGradingFixture({ privateNotes: sentinel });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const injected = `PARTNER-INJECTED-${randomUUID()}`;
    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: {
        // The admin-internal field a partner user must never be able to write.
        private_notes: injected,
        // A legitimate, partner-writable field on the SAME request. Without this the test could
        // pass simply because the whole write failed, which would prove nothing.
        card_name: "Behavioural Control Card",
        // The grading panel always sends the overall grade on a draft save, and it is load-bearing:
        // server/grader.ts writes it straight into `grade numeric(4,1)`, so an omitted value sends
        // '' and Postgres rejects the whole statement.
        overall_grade: "9",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await admin.query<{ private_notes: string | null; card_name: string | null }>(
      "SELECT private_notes, card_name FROM certificates WHERE id=$1",
      [certId]
    );
    expect(
      after.rows[0].card_name,
      "positive control: the request really did write to this certificate"
    ).toBe("Behavioural Control Card");
    // THE SECURITY PROPERTY. This is GRADE1's behavioural replacement: delete the PII strip by ANY
    // spelling and the partner-supplied value lands here.
    expect(
      after.rows[0].private_notes,
      "a partner user must not be able to write the admin-internal private_notes column"
    ).not.toBe(injected);
  });

  /**
   * G2 — DEFENCE IN DEPTH, and labelled as such rather than overclaimed.
   *
   * Verified by mutation: removing the strip at the `/grade` call site turns G1 RED but leaves this
   * test GREEN, because `applyCertGradeDraft` reads only `body.private_notes` — the camelCase
   * spelling has no write path today. It is pinned anyway: `partnerGradeBody` deletes both, the
   * grader's own PII list carries `privateNotes`, and a future camelCase reader would otherwise
   * inherit an unguarded field. G1 is the load-bearing proof; this one guards the second door.
   */
  it("G2: the camelCase spelling privateNotes is also stripped (defence in depth)", async () => {
    const f = await seedGradingFixture({ privateNotes: `ADMIN-ONLY-${randomUUID()}` });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const injected = `CAMEL-INJECTED-${randomUUID()}`;
    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: { privateNotes: injected, card_name: "Camel Control Card", overall_grade: "8" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await admin.query<{ private_notes: string | null; card_name: string | null }>(
      "SELECT private_notes, card_name FROM certificates WHERE id=$1",
      [certId]
    );
    expect(after.rows[0].card_name).toBe("Camel Control Card");
    expect(after.rows[0].private_notes).not.toBe(injected);
  });

  /**
   * G1b — PRESERVATION (was: characterisation of open defect D-1).
   *
   * This test used to assert `toBeNull()` — i.e. it pinned a data-destroying defect as expected
   * behaviour, inside a must-pass CI floor. Its own comment instructed the swap made here:
   * "WHEN IT IS FIXED this test goes RED. That is the intended signal: replace it with the
   * preservation assertion rather than deleting it."
   *
   * The defect: server/grader.ts wrote `private_notes = ${pick(body.private_notes,
   * cert.privateNotes)}`, `cert` comes from a Drizzle `select()` over shared/schema.ts, and that
   * model declares no `privateNotes` field — so `cert.privateNotes` was ALWAYS `undefined`,
   * `partnerGradeBody()` always strips `private_notes` from a partner request, and
   * `pick(undefined, undefined)` -> `null` destroyed the admin note on EVERY partner save.
   * `auth_status` and `auth_notes` sat on the identical construct.
   *
   * FIXED (owner-approved 2026-08-07) by preserving all three at the SQL layer, the same
   * `COALESCE` form server/routes.ts already ships for these exact columns on the admin
   * certificate-update route. The strip itself is unchanged and still proven by G1/G2 above:
   * a partner STILL cannot write private_notes — it is now merely left alone instead of erased.
   */
  it("G1b: a partner draft save PRESERVES private_notes instead of erasing it", async () => {
    const sentinel = `ADMIN-ONLY-${randomUUID()}`;
    const f = await seedGradingFixture({ privateNotes: sentinel });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    expect(
      await scalar<string | null>("SELECT private_notes FROM certificates WHERE id=$1", [certId]),
      "precondition: the admin note is really there before the partner touches the card"
    ).toBe(sentinel);

    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: { card_name: "Erasure Witness Card", overall_grade: "9" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(
      await scalar<string | null>("SELECT private_notes FROM certificates WHERE id=$1", [certId]),
      "the admin-internal note must survive an unrelated partner draft save"
    ).toBe(sentinel);
    // Control: the save really executed, so this cannot pass by the write silently failing.
    expect(await scalar<string>("SELECT card_name FROM certificates WHERE id=$1", [certId])).toBe(
      "Erasure Witness Card"
    );
  });

  /**
   * G1c — the other two columns of D-1, over real HTTP.
   *
   * `auth_status` is not cosmetic: the grading panel derives grade KIND (AA / NO) from it, so an
   * `authentic_altered` verdict silently reset to nothing by an unrelated partner save is a
   * grading-integrity failure, not a display one.
   */
  it("G1c: a partner draft save PRESERVES an authentic_altered verdict and its notes", async () => {
    const f = await seedGradingFixture({ privateNotes: "irrelevant" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];
    await admin.query("UPDATE certificates SET auth_status=$1, auth_notes=$2 WHERE id=$3", [
      "authentic_altered",
      "Trimmed edges observed under UV",
      certId,
    ]);

    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: { card_name: "Verdict Witness Card", overall_grade: "9" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await admin.query<{ auth_status: string; auth_notes: string; card_name: string }>(
      "SELECT auth_status, auth_notes, card_name FROM certificates WHERE id=$1",
      [certId]
    );
    expect(after.rows[0].auth_status, "a partner save must not reset the authenticity verdict").toBe(
      "authentic_altered"
    );
    expect(after.rows[0].auth_notes).toBe("Trimmed edges observed under UV");
    expect(after.rows[0].card_name).toBe("Verdict Witness Card");
  });

  // =====================================================================================
  // G3 — REVIEW1's behavioural replacement. Review is REQUIRED, not merely reported.
  // =====================================================================================
  it("G3: submitting for review moves the work item to pending_review and leaves the certificate UNPUBLISHED", async () => {
    const f = await seedGradingFixture({ privateNotes: "review-gate" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const before = await admin.query<{ grader_status: string; grade_approved_at: Date | null }>(
      "SELECT grader_status, grade_approved_at FROM certificates WHERE id=$1",
      [certId]
    );
    expect(before.rows[0].grader_status).toBe("assigned");
    expect(before.rows[0].grade_approved_at).toBeNull();

    const res = await req("POST", `/api/partner/grading/certificates/${certId}/submit`, {
      cookie,
      body: { overall_grade: "9", card_name: "Review Gate Card" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.gradingStatus).toBe("pending_review");
    expect(res.body.reviewRequired, "the adapter must report that review is required").toBe(true);

    const after = await admin.query<{
      grader_status: string;
      grade_approved_at: Date | null;
      review_required: boolean | null;
    }>("SELECT grader_status, grade_approved_at, review_required FROM certificates WHERE id=$1", [certId]);
    expect(after.rows[0].grader_status, "a partner submit must NOT publish the grade").toBe("pending_review");
    // REVIEW1's exact target: partnerSubmitForReview's `review_required = true`. Flipping it to
    // false was catchable ONLY by a source pin before this assertion existed.
    expect(
      after.rows[0].review_required,
      "the persisted review_required flag is what routes the card to Super Admin review"
    ).toBe(true);
    expect(
      after.rows[0].grade_approved_at,
      "grade_approved_at is the publish marker — a partner submit must never set it"
    ).toBeNull();

    const item = await scalar<string>(
      "SELECT status FROM partner_grading_work_items WHERE certificate_id=$1",
      [certId]
    );
    expect(item, "the work item must await Super Admin review, not be approved by the partner").toBe("pending_review");

    // And the settlement-side gate agrees: nothing is approved yet.
    const approved = await scalar<string>(
      "SELECT count(*)::text FROM partner_grading_work_items WHERE partner_submission_id=$1 AND status='approved'",
      [f.partnerSubmissionId]
    );
    expect(approved).toBe("0");
  });

  // =====================================================================================
  // G4/G5 — authorisation, over real HTTP rather than by reading the SQL.
  // =====================================================================================
  it("G4: a partner user cannot grade another tenant's certificate", async () => {
    const mine = await seedGradingFixture({ privateNotes: "mine" });
    const theirs = await seedGradingFixture({ privateNotes: "theirs" });
    expect(mine.tenantId).not.toBe(theirs.tenantId);

    const cookie = await login(mine.graderEmail);
    const res = await req("PUT", `/api/partner/grading/certificates/${theirs.certIds[0]}/grade`, {
      cookie,
      body: { card_name: "CROSS TENANT WRITE", overall_grade: "9" },
    });
    expect([403, 404]).toContain(res.status);

    const after = await scalar<string | null>("SELECT card_name FROM certificates WHERE id=$1", [theirs.certIds[0]]);
    expect(after, "not one byte of another tenant's certificate may change").not.toBe("CROSS TENANT WRITE");
  });

  it("G5: the grading queue never returns another tenant's cards", async () => {
    const mine = await seedGradingFixture({ privateNotes: "queue-mine" });
    const theirs = await seedGradingFixture({ privateNotes: "queue-theirs" });
    const cookie = await login(mine.graderEmail);

    const res = await req("GET", "/api/partner/grading/queue", { cookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The queue groups by SUBMISSION: each item carries a `cards` array.
    const items = (res.body.items ?? []) as { cards?: { certId: number }[] }[];
    const ids = items.flatMap((i) => (i.cards ?? []).map((c) => c.certId));
    for (const id of theirs.certIds) {
      expect(ids, "the queue leaked another tenant's certificate").not.toContain(id);
    }
    // Positive control: the caller's own assigned cards ARE returned, so an empty queue cannot
    // make the isolation assertion pass vacuously.
    expect(ids).toEqual(expect.arrayContaining(mine.certIds));
  });
});
