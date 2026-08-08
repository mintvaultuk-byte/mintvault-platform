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
// READ-ONLY use of the protected engine. A1/A2 below run the ONE MVGS engine over the evidence the
// server itself persisted, purely to establish what that engine says. Neither file is modified, and
// nothing here re-implements any part of the scoring.
import { scoreMvgsV2 } from "@shared/mvgs-input-builder";
import { gradeFromMvgsScore, remainingToGrade } from "@shared/mvgs-scoring";
import { centeringSubgrade, centeringSubgradeStrict } from "@shared/centering";
import { calcCornerSubgrade, calcEdgeSubgrade, calculateOverallGrade } from "@shared/legacy-grade-fallback";
import { isBlackLabel } from "@shared/pristine";
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
  // The composite FK target migration 0049 needs on the MintVault side.
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
 * written to the disposable MinIO under the SERVER-GENERATED key shape 0049's CHECK constraints
 * require, so the submit route's live headR2 verification passes for real.
 */
async function seedGradingFixture(opts: { privateNotes: string; cards?: number }): Promise<GradingFixture> {
  const n = ++sequence;
  const cardCount = opts.cards ?? 2;

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
     VALUES ($1,$2,$3,$6,'submitted_to_mintvault',$4,$5, now()) RETURNING id`,
    [tenantId, locationId, graderId, customerId, tierCode, cardCount]
  );

  const cardIds: string[] = [];
  const frontKeys: string[] = [];
  const backKeys: string[] = [];
  for (let i = 1; i <= cardCount; i++) {
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
    [tenantId, partnerSubmissionId, JSON.stringify({ cards: cardCount, fixture: "grading-http" })]
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
  for (let i = 0; i < cardCount; i++) {
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
        `MVGH${9000 + n * 1000 + i}`,
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
  // G3-ATOMIC — the submit transition is ALL-OR-NOTHING.
  //
  // Submit performs two state transitions: the certificate to pending_review, and the work item to
  // pending_review. They used to be two auto-commit statements, so anything that made the SECOND
  // one match zero rows left the certificate at pending_review with the work item still 'assigned'.
  // That is not a crash-only scenario — it is the ROUTINE concurrency path, because the work-item
  // miss returns a plain 409.
  //
  // The split state is unrecoverable in-app: both retry doors (/submit and /edit-submission)
  // require gradingStatus 'assigned', and the card now reads pending_review; meanwhile the approval
  // mirror keys on the work item being pending_review, so it never settles either.
  //
  // The lever below is exact rather than incidental: loadPartnerCert derives gradingStatus from
  // cert.grader_status and does NOT filter on the work item's status or assignee, so clearing the
  // assignment leaves every earlier gate passing and breaks ONLY the work-item predicate.
  // Mutation SUBMIT-ATOMIC1 (drop the transaction) turns this RED: 'pending_review' vs 'assigned'.
  // =====================================================================================
  it("G3-ATOMIC: when the work-item transition cannot land, the certificate transition is ROLLED BACK", async () => {
    const f = await seedGradingFixture({ privateNotes: "atomic-gate" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    // Break ONLY the work-item predicate. Nothing the certificate guard reads is touched.
    // assigned_at travels with the assignee (chk_..._assignment_pair), so both clear together.
    await admin.query(
      "UPDATE partner_grading_work_items SET assigned_partner_grader_id = NULL, assigned_at = NULL WHERE submission_item_id = $1",
      [f.submissionItemIds[0]]
    );

    const res = await req("POST", `/api/partner/grading/certificates/${certId}/submit`, {
      cookie,
      body: { overall_grade: "9", card_name: "Atomic Gate Card" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);

    const after = await admin.query<{
      grader_status: string;
      review_required: boolean | null;
      graded_by: string | null;
      grade_approved_at: Date | null;
    }>("SELECT grader_status, review_required, graded_by, grade_approved_at FROM certificates WHERE id=$1", [certId]);
    expect(
      after.rows[0].grader_status,
      "the certificate transition MUST roll back with the work-item transition — otherwise the card is stranded pending_review with an 'assigned' work item, unrecoverable through any route"
    ).toBe("assigned");
    expect(after.rows[0].review_required, "review_required must not survive a rolled-back submit").not.toBe(true);
    expect(after.rows[0].graded_by, "graded_by is set by the same rolled-back UPDATE").toBeNull();
    expect(after.rows[0].grade_approved_at, "nothing here may ever publish").toBeNull();

    const item = await scalar<string>("SELECT status FROM partner_grading_work_items WHERE submission_item_id=$1", [
      f.submissionItemIds[0],
    ]);
    expect(item, "the work item is untouched, so both sides agree the card is still assigned").toBe("assigned");
  });

  // =====================================================================================
  // G3-HQLOCK — an HQ unassign/reassign cannot strand a partner card awaiting review.
  //
  // The mirror image of G3-ATOMIC, on the HQ side of the same seam. assign/reassign/unassign
  // predicate only on `grader_status <> 'approved'`, which a card at 'pending_review' passes, and
  // none of them touch partner_grading_work_items. Moving the certificate therefore left the work
  // item behind at 'pending_review' — terminal, because approval needs the cert AT 'pending_review'
  // and every retry door needs the work item back in an assignable state.
  //
  // Mutation HQ-LOCK1: drop `${await partnerReviewLockGuard()}` from the three UPDATEs → RED.
  // =====================================================================================
  it("G3-HQLOCK: HQ unassign/reassign REFUSES a partner card that is awaiting HQ review", async () => {
    const f = await seedGradingFixture({ privateNotes: "hq-lock" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const submit = await req("POST", `/api/partner/grading/certificates/${certId}/submit`, {
      cookie,
      body: { overall_grade: "9", card_name: "HQ Lock Card" },
    });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);

    const { unassignCerts } = await import("../server/grader");
    const r = await unassignCerts([certId], "admin@test");
    expect(r.ok).toBe(true);
    expect(
      (r as { count: number }).count,
      "a card awaiting HQ review must not be unassignable — moving it strands the work item"
    ).toBe(0);

    const after = await admin.query<{ grader_status: string }>(
      "SELECT grader_status FROM certificates WHERE id=$1",
      [certId]
    );
    expect(after.rows[0].grader_status, "the certificate must stay at pending_review").toBe("pending_review");
    const item = await scalar<string>("SELECT status FROM partner_grading_work_items WHERE certificate_id=$1", [certId]);
    expect(item, "and the work item stays in lockstep with it").toBe("pending_review");
  });

  // =====================================================================================
  // G1d — auth_notes is HQ-private on the READ side too, not only the write side.
  //
  // The write side was already refused (auth_notes is not on the partner evidence whitelist, pinned
  // by W and F3). The read side was not: buildCertGradingPayload returned authNotes verbatim one
  // line below the hard-blanked privateNotes, and GRADER_PII_KEYS stripped privateNotes but not
  // authNotes. Mutation PII-AUTHNOTES1: remove "authNotes"/"auth_notes" from GRADER_PII_KEYS → RED.
  // =====================================================================================
  it("G1d: HQ-private auth_notes NEVER reaches a partner operator's grading payload", async () => {
    const f = await seedGradingFixture({ privateNotes: "authnotes-read" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const secret = "HQ-INTERNAL: suspected trimmed edge, escalate before slabbing";
    await admin.query("UPDATE certificates SET auth_notes=$2 WHERE id=$1", [certId, secret]);

    const res = await req("GET", `/api/partner/grading/certificates/${certId}/grading`, { cookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const blob = JSON.stringify(res.body);
    expect(blob, "HQ authentication commentary must never reach a partner shop operator").not.toContain(secret);
    expect(blob).not.toMatch(/"authNotes"\s*:\s*"(?!")/);
    // The sibling protection must still hold, and the card must still be gradeable.
    // …and the payload is still a real grading payload, not an empty object that would pass
    // the negative assertions vacuously.
    expect(Object.keys(res.body as Record<string, unknown>).length).toBeGreaterThan(5);
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

  // =====================================================================================
  // SERVER AUTHORITY — A1/A2 (rewritten) plus proofs B, D, E, F.
  //
  // These tests previously CHARACTERISED the defect: the partner path persisted whatever
  // overall grade and sub-grades the browser claimed, and the one MVGS engine — run over the
  // evidence the server itself had just stored — disagreed. That behaviour is now fixed, so
  // the two tests are inverted DELIBERATELY: every expectation that used to read "OBSERVED:
  // the client authored this" now reads "the server authored this, and it equals the engine's
  // own verdict on the stored evidence".
  //
  // The method is unchanged and is still observation, not source-reading: send a grade that
  // CONTRADICTS the evidence on the very same request, then run the one real engine
  // (shared/mvgs-input-builder → shared/mvgs-scoring, imported read-only) over the evidence
  // the SERVER persisted, and compare.
  // =====================================================================================

  /** Centering so bad the engine cannot rate it highly, expressed in the persisted string form. */
  const CATASTROPHIC_CENTERING = {
    centering_front_lr: "90/10",
    centering_front_tb: "90/10",
    centering_back_lr: "90/10",
    centering_back_tb: "90/10",
  } as const;

  /** Flawless centering — the engine's own top outcome, used to prove the gates are
   *  EVIDENCE-driven rather than merely "always refuse the client". */
  const PERFECT_CENTERING = {
    centering_front_lr: "50/50",
    centering_front_tb: "50/50",
    centering_back_lr: "50/50",
    centering_back_tb: "50/50",
  } as const;

  /** One real MVGS-classified surface pin — enough to force a non-zero deduction. */
  const REAL_SURFACE_PIN = [{ mvgsCode: "SC", tier: "D2", zone: "FA", x: 0.5, y: 0.5 }];

  /** A SEVERE surface pin: SP D1 in the art zone, which the engine weights heavily enough to
   *  move the surface SUB-GRADE off its top bucket (not just the score). */
  const SEVERE_SURFACE_PIN = [{ mvgsCode: "SP", tier: "D1", zone: "FA", x: 0.4, y: 0.4 }];

  interface EngineVerdict {
    score: number;
    /** Numeric authoritative grade, or null when the outcome is AA/NO. */
    grade: number | null;
    nonNumericGrade: "AA" | "NO" | null;
    subgrades: { centering: number; corners: number; edges: number; surface: number } | null;
    deductions: Record<string, number>;
    basis: string;
  }

  /**
   * Run the ONE engine over the columns the server actually stored, using the SAME input
   * shape the HQ admin approve route builds (server/routes.ts, "MVGS scoring on approve").
   * `pipeline_settings` does not exist on this disposable cluster, so `loadMvgsCalibration()`
   * inside the server falls back to DEFAULT_MVGS_CALIBRATION — which is what scoreMvgsV2 uses
   * here when no calibration is passed. Both sides therefore use identical calibration.
   */
  /**
   * The SHARED grading maths, run over the columns the server actually stored, with the
   * SAME precedence the grading workstation uses. This is the oracle for every proof below.
   *
   * Precedence mirrors client/src/components/grading/grading-panel.tsx verbatim:
   *   authentication verdict → engine major-tear rule → MVGS engine WHEN A PIN IS
   *   CLASSIFIED → otherwise the zone-stepper fallback (calculateOverallGrade).
   *
   * Hostile review's F2 landed precisely because the earlier version of this helper applied
   * the engine unconditionally, so a card graded with the zone steppers and no pins "agreed"
   * with an implementation that was inflating it to 10.
   *
   * Everything here is imported, not reimplemented: scoreMvgsV2, gradeFromMvgsScore,
   * centeringSubgrade(Strict), remainingToGrade, calcCornerSubgrade, calcEdgeSubgrade,
   * calculateOverallGrade.
   */
  async function engineOverPersistedEvidence(certId: number): Promise<EngineVerdict> {
    const row = await admin.query<Record<string, any>>(
      `SELECT centering_front_lr, centering_front_tb, centering_back_lr, centering_back_tb,
              defects, corner_values, edge_values, surface_values,
              dark_border_front, dark_border_back, eye_appeal_modifier,
              whitening_lines, crease_lines, crease_span_pct, wrinkle_severity, tear_severity,
              auth_status, grade_type
         FROM certificates WHERE id=$1`,
      [certId]
    );
    const c = row.rows[0];
    const surfaceFlags = (c.surface_values ?? {}) as Record<string, unknown>;
    const pins = (Array.isArray(c.defects) ? c.defects : [])
      .filter((d: any) => d?.mvgsCode && d?.tier && d?.zone)
      .map((d: any) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) }));
    const result = scoreMvgsV2({
      centeringFrontLr: c.centering_front_lr,
      centeringFrontTb: c.centering_front_tb,
      centeringBackLr: c.centering_back_lr,
      centeringBackTb: c.centering_back_tb,
      defects: pins,
      darkBorderFront: !!c.dark_border_front,
      darkBorderBack: !!c.dark_border_back,
      eyeAppealModifier: Number(c.eye_appeal_modifier ?? 0) || 0,
      whiteningLines: Array.isArray(c.whitening_lines) ? c.whitening_lines : null,
      creaseLines: Array.isArray(c.crease_lines) ? c.crease_lines : null,
      creaseSpanPct: c.crease_span_pct != null ? Number(c.crease_span_pct) : null,
      wrinkleSeverity: c.wrinkle_severity ?? null,
      tearSeverity: c.tear_severity ?? null,
      hasCrease: !!(surfaceFlags as any).hasCrease,
      hasTear: !!(surfaceFlags as any).hasTear,
    });

    const nonNum = (grade: "AA" | "NO"): EngineVerdict => ({
      score: result.score,
      grade: null,
      nonNumericGrade: grade,
      subgrades: null,
      deductions: result.deductions,
      basis: "authentication",
    });
    const storedKind = String(c.grade_type ?? "numeric").trim().toLowerCase();
    if (c.auth_status === "authentic_altered") return nonNum("AA");
    if (c.auth_status === "not_original") return nonNum("NO");
    if (storedKind === "authentic_altered" || storedKind === "aa") return nonNum("AA");
    if (storedKind === "not_original" || storedKind === "no" || storedKind === "non_numeric") return nonNum("NO");
    if (result.tearForceNotGraded) return { ...nonNum("NO"), basis: "engine-tear-rule" };

    const surface = remainingToGrade(25 - Math.abs(result.deductions.surface ?? 0));
    if (pins.length > 0) {
      const subgrades = {
        centering: centeringSubgrade(
          c.centering_front_lr,
          c.centering_front_tb,
          c.centering_back_lr,
          c.centering_back_tb
        ).subgrade,
        corners: remainingToGrade(25 - Math.abs(result.deductions.corners ?? 0)),
        edges: remainingToGrade(25 - Math.abs(result.deductions.edges ?? 0)),
        surface,
      };
      return {
        score: result.score,
        grade: gradeFromMvgsScore(result.score),
        nonNumericGrade: null,
        subgrades,
        deductions: result.deductions,
        basis: "mvgs-engine",
      };
    }

    const zeroC = {
      frontTL: 0, frontTR: 0, frontBL: 0, frontBR: 0, backTL: 0, backTR: 0, backBL: 0, backBR: 0,
    };
    const zeroE = {
      frontTop: 0, frontBottom: 0, frontLeft: 0, frontRight: 0,
      backTop: 0, backBottom: 0, backLeft: 0, backRight: 0,
    };
    const subgrades = {
      centering:
        centeringSubgradeStrict(
          c.centering_front_lr,
          c.centering_front_tb,
          c.centering_back_lr,
          c.centering_back_tb
        )?.subgrade ?? 10,
      corners: calcCornerSubgrade({ ...zeroC, ...(c.corner_values ?? {}) }).grade,
      edges: calcEdgeSubgrade({ ...zeroE, ...(c.edge_values ?? {}) }).grade,
      surface,
    };
    return {
      score: result.score,
      grade: calculateOverallGrade(subgrades, !!(surfaceFlags as any).hasCrease, !!(surfaceFlags as any).hasTear),
      nonNumericGrade: null,
      subgrades,
      deductions: result.deductions,
      basis: "legacy-zone-fallback",
    };
  }

  /** THE INVARIANT, as one reusable assertion: the stored row carries what the shared
   *  maths says about that same stored row. Every proof below leans on it. */
  async function assertRowMatchesSharedMaths(certId: number, why: string): Promise<EngineVerdict> {
    const oracle = await engineOverPersistedEvidence(certId);
    const stored = await authorityColumns(certId);
    if (oracle.grade == null) {
      expect(stored.grade, `${why}: a non-numeric outcome must store a NULL grade`).toBeNull();
    } else {
      expect(Number(stored.grade), `${why}: stored grade must equal the shared maths over the stored row`).toBe(
        oracle.grade
      );
      expect(
        {
          centering: Number(stored.centering_score),
          corners: Number(stored.corners_score),
          edges: Number(stored.edges_score),
          surface: Number(stored.surface_score),
        },
        `${why}: stored sub-grades must equal the shared maths over the stored row`
      ).toEqual(oracle.subgrades);
    }
    return oracle;
  }

  /** Every authority-bearing column the partner must not be able to author. */
  async function authorityColumns(certId: number) {
    const r = await admin.query<Record<string, any>>(
      `SELECT grade::text, grade_type, label_type, card_name, crease_span_pct::text,
              centering_score::text, corners_score::text, edges_score::text, surface_score::text,
              centering_front_lr, grade_strength_score, private_notes, auth_status,
              grade_approved_at, print_state, operator_grade::text, operator_subgrades
         FROM certificates WHERE id=$1`,
      [certId]
    );
    return r.rows[0];
  }

  // ── PROOF A — a manipulated client grade is ignored ─────────────────────────────────────

  it("A1: a manipulated client grade is IGNORED — the server re-derives the grade from the evidence it persisted", async () => {
    const f = await seedGradingFixture({ privateNotes: "engine-authority" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    // A perfect 10 asserted on top of catastrophic centering, in ONE request. No implementation
    // of MVGS can produce 10 from this evidence, so the persisted value identifies its author.
    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: {
        ...CATASTROPHIC_CENTERING,
        overall_grade: "10",
        grade_centering: 10,
        grade_corners: 10,
        grade_edges: 10,
        grade_surface: 10,
        card_name: "Engine Authority Card",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await authorityColumns(certId);

    // Positive control — the request really did write this row, so nothing below passes vacuously.
    expect(after.card_name, "positive control: the request reached the certificate").toBe("Engine Authority Card");
    // The EVIDENCE was persisted exactly as sent: it is evidence, and evidence is the partner's
    // to supply. Only the CONCLUSION is the server's.
    expect(after.centering_front_lr, "the server stored the centering measurement the client supplied").toBe("90/10");

    const engine = await engineOverPersistedEvidence(certId);
    expect(engine.grade!, "sanity: the maths must rate this evidence poorly, or the test proves nothing").toBeLessThan(5);

    // THE ARCHITECTURE FACT, inverted from what this test used to assert. Changed deliberately:
    // the previous expectation was `.toBe(10)` / `.not.toBe(engineGrade)`, characterising the
    // client-authoritative defect. It is now equality with the engine's own verdict.
    expect(
      Number(after.grade),
      "the persisted grade is the ONE engine's verdict on the server's own stored evidence, " +
        "not the number the client sent"
    ).toBe(engine.grade);
    expect(Number(after.grade), "the client's contradictory claim of 10 was not persisted").not.toBe(10);

    // Sub-grades are server-authored too. The client claimed centering 10 while supplying 90/10
    // centering; the server stored the chart's answer for 90/10 instead.
    expect(
      Number(after.centering_score),
      "the centering SUB-grade follows the stored centering measurement, not the client's claim"
    ).toBeLessThan(10);

    // And the response the partner receives is the SERVER's result, not an echo of their input.
    expect((res.body as any).authority, "the partner is shown the server's outcome").toMatchObject({
      source: "server",
      overallGrade: String(engine.grade),
    });
  });

  it("A2: SUPER ADMIN REVIEW receives the SERVER's grade — operator_grade is the engine verdict, not the browser's claim", async () => {
    const f = await seedGradingFixture({ privateNotes: "engine-authority-review" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const res = await req("POST", `/api/partner/grading/certificates/${certId}/submit`, {
      cookie,
      body: {
        ...CATASTROPHIC_CENTERING,
        overall_grade: "10",
        grade_centering: 10,
        grade_corners: 10,
        grade_edges: 10,
        grade_surface: 10,
        card_name: "Engine Authority Review Card",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.gradingStatus).toBe("pending_review");

    const after = await authorityColumns(certId);
    const grader = await admin.query<{ grader_status: string }>(
      "SELECT grader_status FROM certificates WHERE id=$1",
      [certId]
    );

    // Positive control — the submit transition really happened.
    expect(grader.rows[0].grader_status, "positive control: the card really did move to review").toBe("pending_review");
    // The mandatory-review gate still holds; this test is about WHAT is reviewed, not whether.
    expect(after.grade_approved_at, "a partner submit must still never publish").toBeNull();

    const engine = await engineOverPersistedEvidence(certId);
    expect(engine.grade!, "sanity: the maths must rate this evidence poorly").toBeLessThan(5);

    // Changed deliberately: was `.toBe(10)` / `.not.toBe(engineGrade)`.
    expect(
      Number(after.operator_grade),
      "operator_grade — the record a Super Admin reviews — is the SERVER's derived grade"
    ).toBe(engine.grade);
    expect(Number(after.operator_grade), "the browser's claim of 10 never reached review").not.toBe(10);
    expect(
      Number((after.operator_subgrades as any)?.centering),
      "the snapshotted sub-grades are the server's, not the client's claims"
    ).toBeLessThan(10);
  });

  // ── PROOF B — partner path and HQ/server path agree on identical evidence ───────────────

  it("B: identical evidence through the PARTNER path and the HQ engine writer yields an IDENTICAL authoritative result", async () => {
    const f = await seedGradingFixture({ privateNotes: "parity" });
    const cookie = await login(f.graderEmail);
    const partnerCert = f.certIds[0];
    const hqCert = f.certIds[1];

    const EVIDENCE = {
      centering_front_lr: "60/40",
      centering_front_tb: "55/45",
      centering_back_lr: "70/30",
      centering_back_tb: "50/50",
      defects: REAL_SURFACE_PIN,
      dark_border_front: true,
      dark_border_back: false,
      eye_appeal_modifier: 0,
      wrinkle_severity: null,
      tear_severity: null,
    };

    // PARTNER PATH — over real HTTP, through the mounted production router. The client also
    // sends a contradictory grade, which must be discarded.
    const res = await req("PUT", `/api/partner/grading/certificates/${partnerCert}/grade`, {
      cookie,
      body: { ...EVIDENCE, overall_grade: "1", grade_centering: 1, grade_corners: 1, grade_edges: 1, grade_surface: 1 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // HQ PATH — the SAME evidence through the unmodified grading engine writer that every HQ
    // grading surface calls (server/grader.ts::applyCertGradeDraft). No partner adapter involved.
    const { applyCertGradeDraft } = await import("../server/grader");
    expect(await applyCertGradeDraft(hqCert, { ...EVIDENCE, overall_grade: "4" })).toBe(true);

    // The authoritative result on each row, computed the way the HQ approve route computes it.
    const partnerEngine = await engineOverPersistedEvidence(partnerCert);
    const hqEngine = await engineOverPersistedEvidence(hqCert);

    // 1. Identical evidence ⇒ identical engine verdict on both rows.
    expect(partnerEngine.score, "same evidence ⇒ same engine score on both paths").toBe(hqEngine.score);
    expect(partnerEngine.grade, "same evidence ⇒ same engine grade on both paths").toBe(hqEngine.grade);
    expect(partnerEngine.deductions, "same evidence ⇒ same deduction breakdown").toEqual(hqEngine.deductions);

    // 2. Sanity: the engine's verdict is neither of the two numbers a client asserted, so the
    //    comparison below is not tautological.
    expect(partnerEngine.grade).not.toBe(1);
    expect(partnerEngine.grade).not.toBe(4);

    // 3. The PARTNER row PERSISTED that authoritative result. The HQ row persisted its
    //    operator's number (9) — that is HQ's existing, unchanged behaviour and is precisely
    //    why the partner surface needed the adapter: an external shop is not an HQ operator.
    const partnerRow = await authorityColumns(partnerCert);
    const hqRow = await authorityColumns(hqCert);
    expect(Number(partnerRow.grade), "the partner path persisted the shared authoritative verdict").toBe(
      hqEngine.grade
    );
    expect(Number(hqRow.grade), "control: the HQ writer is untouched and still persists its caller's grade").toBe(4);
  });

  // ── PROOF D — Black Label / Pristine cannot be client-forced ────────────────────────────

  it("D: Black Label / Pristine cannot be forced by the client, and is granted only by the evidence", async () => {
    const forced = await seedGradingFixture({ privateNotes: "pristine-forced" });
    const forcedCookie = await login(forced.graderEmail);
    const forcedCert = forced.certIds[0];

    // The client claims a flawless card AND tries to set the label columns directly, while
    // supplying evidence that carries a real defect deduction.
    const res = await req("PUT", `/api/partner/grading/certificates/${forcedCert}/grade`, {
      cookie: forcedCookie,
      body: {
        ...PERFECT_CENTERING,
        defects: SEVERE_SURFACE_PIN,
        overall_grade: "10",
        grade_centering: 10,
        grade_corners: 10,
        grade_edges: 10,
        grade_surface: 10,
        label_type: "black",
        card_name: "Forced Pristine",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await authorityColumns(forcedCert);
    expect(row.card_name, "positive control: the request reached the certificate").toBe("Forced Pristine");
    expect(row.label_type, "a partner client cannot write label_type — Black Label is not theirs to set").not.toBe(
      "black"
    );

    const engine = await engineOverPersistedEvidence(forcedCert);
    // The shared Pristine/Black-Label gate, evaluated over what was PERSISTED. It must refuse,
    // because the evidence carries a real deduction — exactly as it would for an HQ card.
    expect(
      isBlackLabel(
        {
          centering: Number(row.centering_score),
          corners: Number(row.corners_score),
          edges: Number(row.edges_score),
          surface: Number(row.surface_score),
        },
        Number(row.grade),
        engine.deductions
      ),
      "the shared Pristine gate refuses the persisted row: the client's claim of four 10s was discarded"
    ).toBe(false);
    expect(
      Number(row.surface_score),
      "the surface SUB-grade reflects the real pin, not the client's 10"
    ).toBeLessThan(10);

    // NEGATIVE CONTROL — the gate is evidence-driven, not merely "always refuse".
    const clean = await seedGradingFixture({ privateNotes: "pristine-earned" });
    const cleanCookie = await login(clean.graderEmail);
    const cleanCert = clean.certIds[0];
    const cleanRes = await req("PUT", `/api/partner/grading/certificates/${cleanCert}/grade`, {
      cookie: cleanCookie,
      // The client here claims a POOR grade. Genuinely flawless evidence must still earn 10.
      body: { ...PERFECT_CENTERING, defects: [], overall_grade: "2", grade_centering: 2 },
    });
    expect(cleanRes.status, JSON.stringify(cleanRes.body)).toBe(200);
    const cleanRow = await authorityColumns(cleanCert);
    const cleanEngine = await engineOverPersistedEvidence(cleanCert);
    expect(Number(cleanRow.grade), "flawless evidence earns the engine's top grade despite the client claiming 2").toBe(
      cleanEngine.grade
    );
    expect(
      isBlackLabel(
        {
          centering: Number(cleanRow.centering_score),
          corners: Number(cleanRow.corners_score),
          edges: Number(cleanRow.edges_score),
          surface: Number(cleanRow.surface_score),
        },
        Number(cleanRow.grade),
        cleanEngine.deductions
      ),
      "Pristine is GRANTED by the evidence on the same shared gate — proving D is not a blanket refusal"
    ).toBe(true);
  });

  // ── PROOF E — a partner cannot author B3 (nor any grading gate) ─────────────────────────

  it("E: a partner cannot author the B3 sub-grade gate, the grade kind, or any other publish gate input", async () => {
    // B3 (owner-approved 2026-07-02, server/grader.ts::checkGradePublishGates) is the rule that
    // a NUMERIC grade may not publish while any of centering_score / corners_score /
    // edges_score / surface_score is NULL. Its inputs are therefore the four sub-grade columns
    // and the grade kind. Both are now server-authored.
    //
    // (B1 and B2 are not grading rules in this codebase — they are local test-case and
    // review-finding labels. Stated here rather than fabricating an assertion for them.)
    const f = await seedGradingFixture({ privateNotes: "b3" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: {
        ...CATASTROPHIC_CENTERING,
        defects: REAL_SURFACE_PIN,
        // The client tries to satisfy B3 with fabricated sub-grades, and to reclassify the card
        // as non-numeric so the gate would exempt it entirely.
        grade_centering: 10,
        grade_corners: 10,
        grade_edges: 10,
        grade_surface: 10,
        grade_type: "non_numeric",
        overall_grade: "AA",
        // …and to reach past grading into workflow / provenance / settlement state.
        grader_status: "approved",
        review_required: false,
        grade_approved_at: "2020-01-01T00:00:00Z",
        print_state: "printed",
        origin_type: "HQ",
        origin_partner_legal_name: "Someone Else Ltd",
        operator_grade: 10,
        verified_defects: [],
        grade_strength_score: 100,
        card_name: "B3 Probe",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await authorityColumns(certId);
    const engine = await engineOverPersistedEvidence(certId);
    expect(row.card_name, "positive control: the request reached the certificate").toBe("B3 Probe");

    // The grade kind stayed numeric — the client could not reclassify the card to dodge B3.
    expect(row.grade_type, "a partner cannot change the grade KIND").toBe("numeric");
    expect(Number(row.grade), "the grade is the engine's numeric verdict, not the client's 'AA'").toBe(engine.grade);

    // B3's four inputs are all present (so the gate can run) AND all server-derived.
    for (const col of ["centering_score", "corners_score", "edges_score", "surface_score"] as const) {
      expect(row[col], `B3 input ${col} must be populated by the server`).not.toBeNull();
    }
    expect(
      [row.centering_score, row.corners_score, row.edges_score, row.surface_score].every((v) => Number(v) === 10),
      "the client's four fabricated 10s did not become the B3 inputs"
    ).toBe(false);

    // Workflow, provenance and settlement state were untouched by the request.
    const wf = await admin.query<Record<string, any>>(
      `SELECT grader_status, review_required, print_state, origin_type, origin_partner_legal_name,
              operator_grade, verified_defects
         FROM certificates WHERE id=$1`,
      [certId]
    );
    expect(wf.rows[0].grader_status, "a partner cannot self-approve").toBe("assigned");
    expect(row.grade_approved_at, "a partner cannot backdate publication").toBeNull();
    expect(wf.rows[0].print_state, "a partner cannot advance the print lifecycle").toBe("awaiting_approval");
    expect(wf.rows[0].origin_type, "a partner cannot rewrite provenance").toBe("PARTNER");
    expect(wf.rows[0].origin_partner_legal_name).not.toBe("Someone Else Ltd");
    expect(wf.rows[0].operator_grade, "a partner cannot pre-seed the review snapshot").toBeNull();
  });

  // ── PROOF F — the authority decision is persisted and auditable ─────────────────────────

  it("F: the server-authority version and the engine verdict are PERSISTED and AUDITABLE", async () => {
    const f = await seedGradingFixture({ privateNotes: "audit" });
    const cookie = await login(f.graderEmail);
    const certId = f.certIds[0];

    const res = await req("POST", `/api/partner/grading/certificates/${certId}/submit`, {
      cookie,
      body: { ...CATASTROPHIC_CENTERING, defects: REAL_SURFACE_PIN, overall_grade: "10", card_name: "Audit Card" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await authorityColumns(certId);
    const engine = await engineOverPersistedEvidence(certId);

    // 1. PERSISTED — the engine score that produced the grade is on the row, in the same column
    //    the HQ approve route writes it to.
    expect(
      Number(row.grade_strength_score),
      "grade_strength_score records WHICH engine verdict produced the stored grade"
    ).toBe(engine.score);
    expect(Number(row.grade)).toBe(engine.grade);

    // 2. AUDITABLE — the partner audit trail carries the authority decision, its version, and
    //    the derived values, on an append-only table the runtime role cannot UPDATE or DELETE.
    const audit = await admin.query<{ after_value: Record<string, any> }>(
      `SELECT after_value FROM partner_audit_events
        WHERE record_type='certificate' AND record_id=$1 AND action='grading.submitted_for_review'
        ORDER BY created_at DESC LIMIT 1`,
      [String(certId)]
    );
    expect(audit.rows.length, "an audit event was written for the submit").toBe(1);
    const detail = audit.rows[0].after_value;
    expect(detail.grade_authority, "the audit records that the SERVER authored the grade").toBe("server");
    expect(typeof detail.grade_authority_version, "the authority contract version is recorded").toBe("number");
    expect(detail.mvgs_score, "the audited score matches the persisted score").toBe(engine.score);
    expect(detail.overall_grade, "the audited grade matches the persisted grade").toBe(String(engine.grade));

    // 3. The audit trail must not leak HQ-private state.
    expect(JSON.stringify(detail)).not.toContain("audit");
  });

  // ── The whitelist itself ────────────────────────────────────────────────────────────────

  it("W: partnerGradeBody is a WHITELIST — unknown and authority-bearing keys never cross the boundary", async () => {
    const { partnerGradeBody, PARTNER_GRADE_SERVER_AUTHORED_FIELDS } = await import(
      "../server/partner/grading-authority"
    );
    const out = partnerGradeBody({
      centering_front_lr: "50/50",
      card_name: "kept",
      defects: [],
      // authority
      overall_grade: "10",
      grade_centering: 10,
      grade_corners: 10,
      grade_edges: 10,
      grade_surface: 10,
      grade_type: "non_numeric",
      label_type: "black",
      // HQ-private / auth state
      private_notes: "x",
      privateNotes: "x",
      auth_status: "authentic_altered",
      auth_notes: "x",
      // provenance / approval / settlement / print
      origin_type: "HQ",
      grade_approved_at: "2020-01-01",
      grade_approved_by: "someone",
      grader_status: "approved",
      review_required: false,
      operator_grade: 10,
      operator_subgrades: {},
      print_state: "printed",
      verified_defects: [],
      grade_strength_score: 100,
      deleted_at: null,
      // an unknown key invented by an attacker
      totally_made_up_column: 1,
    });
    expect(Object.keys(out).sort(), "only evidence/identity keys survive").toEqual(
      ["auth_status", "card_name", "centering_front_lr", "defects"].sort()
    );
    for (const f of PARTNER_GRADE_SERVER_AUTHORED_FIELDS) {
      expect(out, `${f} is server-authored and must never come from the client`).not.toHaveProperty(f);
    }
  });
  // =====================================================================================
  // THE FIELD MATRIX — the test gap that let F1 and F2 through.
  //
  // A1/A2 only ever exercised centering and defect pins, so two whole classes of evidence
  // (the crease measurement group, and the zone steppers) were never checked against the
  // invariant. This matrix sends a NON-DEFAULT value for EVERY whitelisted evidence field,
  // one field at a time, and asserts the invariant each time:
  //
  //     stored grade == what the shared grading maths says about the STORED ROW
  //
  // Run against the real router over real PostgreSQL, so a field that is scored but never
  // persisted (F1) or routed through the wrong maths (F2) fails here by construction rather
  // than needing someone to think of it.
  // =====================================================================================

  /**
   * ONE tenant, ONE login, many cards — shared by every proof below.
   *
   * `/api/partner/auth/login` is rate-limited per SOURCE IP (server/partner/rate-limit.ts:
   * "Keying on req.ip alone removes the escape"), so seeding a fresh operator per assertion
   * trips a 429 partway through the matrix. One login, one fresh certificate per assertion.
   */
  let sharedCookie = "";
  let sharedCerts: number[] = [];
  let sharedCursor = 0;
  async function nextSharedCert(): Promise<{ cookie: string; certId: number }> {
    if (!sharedCookie) {
      const f = await seedGradingFixture({ privateNotes: "shared-proof-fixture", cards: 30 });
      sharedCookie = await login(f.graderEmail);
      sharedCerts = f.certIds;
    }
    const certId = sharedCerts[sharedCursor++];
    if (certId == null) throw new Error("shared fixture exhausted — raise the card count");
    return { cookie: sharedCookie, certId };
  }

  /** Every whitelisted evidence field, with a value that is NOT the column default. */
  const EVIDENCE_MATRIX: { field: string; body: Record<string, unknown>; why: string }[] = [
    { field: "centering_front_lr", body: { centering_front_lr: "80/20" }, why: "front L/R measurement" },
    { field: "centering_front_tb", body: { centering_front_tb: "75/25" }, why: "front T/B measurement" },
    { field: "centering_back_lr", body: { centering_back_lr: "85/15" }, why: "back L/R measurement" },
    { field: "centering_back_tb", body: { centering_back_tb: "70/30" }, why: "back T/B measurement" },
    {
      field: "corners",
      body: { corners: { frontTL: 4, frontTR: 0, frontBL: 0, frontBR: 0, backTL: 0, backTR: 0, backBL: 0, backBR: 0 } },
      why: "zone stepper — F2's blind spot",
    },
    {
      field: "edges",
      body: {
        edges: {
          frontTop: 5,
          frontBottom: 0,
          frontLeft: 0,
          frontRight: 0,
          backTop: 0,
          backBottom: 0,
          backLeft: 0,
          backRight: 0,
        },
      },
      why: "zone stepper — F2's blind spot",
    },
    { field: "surface", body: { surface: { hasCrease: true, hasTear: false } }, why: "legacy structural flags" },
    { field: "defects", body: { defects: SEVERE_SURFACE_PIN }, why: "MVGS-classified pin" },
    { field: "dark_border_front", body: { dark_border_front: true }, why: "per-side dark border" },
    { field: "dark_border_back", body: { dark_border_back: true }, why: "per-side dark border" },
    { field: "eye_appeal_modifier", body: { eye_appeal_modifier: -3 }, why: "operator eye-appeal adjustment" },
    {
      field: "whitening_lines",
      body: { whitening_lines: [{ edge: "frontTop", affectedPct: 60 }] },
      why: "v2 whitening measurement",
    },
    {
      field: "crease_lines",
      body: { crease_lines: [{ spanPct: 70, side: "front" }] },
      why: "v2 crease measurement — F1's neighbour",
    },
    { field: "wrinkle_severity", body: { wrinkle_severity: "moderate" }, why: "v2 wrinkle ceiling input" },
    { field: "tear_severity", body: { tear_severity: "minor" }, why: "v2 tear ceiling input" },
    { field: "auth_status", body: { auth_status: "authentic_altered" }, why: "authentication verdict — F3" },
  ];

  it("MATRIX: for EVERY whitelisted evidence field, the stored grade equals the shared maths over the stored row", async () => {
    // One tenant, one card per field, so a field cannot be masked by another's state.
    for (const entry of EVIDENCE_MATRIX) {
      const { cookie, certId } = await nextSharedCert();

      const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
        cookie,
        // Every request also carries a contradictory authoritative claim, so the matrix
        // doubles as a per-field tamper test.
        body: {
          ...entry.body,
          overall_grade: "10",
          grade_centering: 10,
          grade_corners: 10,
          grade_edges: 10,
          grade_surface: 10,
          card_name: `Matrix ${entry.field}`,
        },
      });
      expect(res.status, `${entry.field}: ${JSON.stringify(res.body)}`).toBe(200);

      const stored = await authorityColumns(certId);
      expect(stored.card_name, `${entry.field}: positive control — the request reached the row`).toBe(
        `Matrix ${entry.field}`
      );

      // THE INVARIANT.
      const oracle = await assertRowMatchesSharedMaths(certId, `${entry.field} (${entry.why})`);

      // …and the response the partner saw describes that same row (F4).
      const shown = (res.body as any).authority;
      expect(shown.source, `${entry.field}: the partner is shown a server-authored result`).toBe("server");
      expect(shown.overallGrade, `${entry.field}: the response must not contradict the row`).toBe(
        oracle.grade == null ? oracle.nonNumericGrade : String(oracle.grade)
      );
      expect(shown.basis, `${entry.field}: the response records WHICH shared decision was used`).toBe(oracle.basis);
    }
  }, 120_000);

  it("MATRIX: every whitelisted field that the shared maths READS is also PERSISTED by the engine writer", async () => {
    // The generalisation of F1, asserted directly rather than only through behaviour.
    // A field the authority computation reads but server/grader.ts never writes makes the
    // stored row and the scored evidence permanently divergent.
    const { PARTNER_GRADE_EVIDENCE_FIELDS } = await import("../server/partner/grading-authority");
    const graderSource = readFileSync(join(process.cwd(), "server", "grader.ts"), "utf8");

    // Fields that feed the grading maths (as opposed to identity/narrative, which do not).
    const SCORED = [
      "centering_front_lr",
      "centering_front_tb",
      "centering_back_lr",
      "centering_back_tb",
      "corners",
      "edges",
      "surface",
      "defects",
      "dark_border_front",
      "dark_border_back",
      "eye_appeal_modifier",
      "whitening_lines",
      "crease_lines",
      "wrinkle_severity",
      "tear_severity",
      "auth_status",
    ] as const;

    // The zone/pin bodies land in differently-named columns; everything else is 1:1.
    const COLUMN: Record<string, string> = {
      corners: "corner_values",
      edges: "edge_values",
      surface: "surface_values",
      defects: "defects",
    };

    for (const field of SCORED) {
      expect(PARTNER_GRADE_EVIDENCE_FIELDS as readonly string[], `${field} must be whitelisted`).toContain(field);
      const column = COLUMN[field] ?? field;
      expect(
        graderSource.includes(`${column} `) || graderSource.includes(`${column}=`),
        `${field} is SCORED, so server/grader.ts must persist column ${column} — otherwise the ` +
          `stored row and the scored evidence can disagree (this is exactly finding F1)`
      ).toBe(true);
    }

    // And the converse: the two fields removed after F1/F9 must stay out.
    for (const gone of ["crease_span_pct", "ai_defect_candidates"]) {
      expect(
        PARTNER_GRADE_EVIDENCE_FIELDS as readonly string[],
        `${gone} is not persisted by the engine writer and must not be whitelisted`
      ).not.toContain(gone);
      expect(graderSource, `sanity: server/grader.ts really does not write ${gone}`).not.toContain(gone);
    }
  });

  // ── F1 regression — the crease probe, reproduced ────────────────────────────────────────

  it("F1: a crease-span body cannot suppress the structural ceiling (the scored/persisted split is closed)", async () => {
    const { cookie, certId } = await nextSharedCert();

    // Hostile review's PROBE-1: empty crease_lines + crease_span_pct 0 + hasCrease true.
    // Under v1 this scored as "no crease" (10) while the row said "crease, no span" (4.5).
    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: {
        ...PERFECT_CENTERING,
        crease_lines: [],
        crease_span_pct: 0,
        surface: { hasCrease: true, hasTear: false },
        overall_grade: "10",
        grade_centering: 10,
        grade_corners: 10,
        grade_edges: 10,
        grade_surface: 10,
        card_name: "F1 Probe",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = await authorityColumns(certId);
    expect(stored.card_name, "positive control").toBe("F1 Probe");
    // The unpersistable field never reached the row, and never reached the maths either.
    expect(stored.crease_span_pct, "crease_span_pct is not a column the engine writer persists").toBeNull();
    // The stored flag is honoured: the shared maths caps a creased card.
    const oracle = await assertRowMatchesSharedMaths(certId, "F1 crease probe");
    expect(Number(stored.grade), "a card the row says is creased cannot store a 10").toBeLessThan(10);
    expect(oracle.grade, "sanity: the shared maths really does cap this card").toBeLessThan(10);

    // Negative values behave identically (review confirmed -999 also worked under v1).
    const neg = await nextSharedCert();
    const negRes = await req("PUT", `/api/partner/grading/certificates/${neg.certId}/grade`, {
      cookie: neg.cookie,
      body: {
        ...PERFECT_CENTERING,
        crease_span_pct: -999,
        surface: { hasCrease: true, hasTear: false },
        overall_grade: "10",
      },
    });
    expect(negRes.status, JSON.stringify(negRes.body)).toBe(200);
    await assertRowMatchesSharedMaths(neg.certId, "F1 negative-span probe");
    expect(Number((await authorityColumns(neg.certId)).grade)).toBeLessThan(10);
  });

  // ── F2 regression — the ordinary no-pin workflow ────────────────────────────────────────

  it("F2: a card graded with the ZONE STEPPERS and no pins gets the HQ fallback grade, not an engine 10", async () => {
    const { cookie, certId } = await nextSharedCert();

    // Hostile review's PROBE-2, verbatim: corners all 4, edges all 5, no classified pin.
    const corners = { frontTL: 4, frontTR: 4, frontBL: 4, frontBR: 4, backTL: 4, backTR: 4, backBL: 4, backBR: 4 };
    const edges = {
      frontTop: 5,
      frontBottom: 5,
      frontLeft: 5,
      frontRight: 5,
      backTop: 5,
      backBottom: 5,
      backLeft: 5,
      backRight: 5,
    };
    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: { ...PERFECT_CENTERING, corners, edges, defects: [], overall_grade: "10", card_name: "F2 Probe" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = await authorityColumns(certId);
    expect(stored.card_name, "positive control").toBe("F2 Probe");

    // The zone values really are on the row — so the assertion below is about the MATHS,
    // not about the write being dropped.
    const zones = await admin.query<Record<string, any>>(
      "SELECT corner_values, edge_values FROM certificates WHERE id=$1",
      [certId]
    );
    expect(zones.rows[0].corner_values.frontTL, "the operator's corner stepper was persisted").toBe(4);
    expect(zones.rows[0].edge_values.frontTop, "the operator's edge stepper was persisted").toBe(5);

    // The HQ maths, run verbatim on the same sub-grades.
    const hqSubs = {
      centering: 10,
      corners: calcCornerSubgrade(corners).grade,
      edges: calcEdgeSubgrade(edges).grade,
      surface: 10,
    };
    const hqGrade = calculateOverallGrade(hqSubs, false, false);
    expect(hqGrade, "sanity: the HQ fallback rates this card well below 10").toBeLessThan(10);

    expect(Number(stored.grade), "the partner path used the SAME fallback the HQ panel uses").toBe(hqGrade);
    expect(Number(stored.grade), "and did NOT inflate a stepper-graded card to a bare engine 10").not.toBe(10);
    expect((res.body as any).authority.basis, "the response says which decision was used").toBe(
      "legacy-zone-fallback"
    );
    await assertRowMatchesSharedMaths(certId, "F2 zone-stepper probe");

    // Secondary from the review: the row must not carry the Pristine shape.
    const oracle = await engineOverPersistedEvidence(certId);
    expect(
      isBlackLabel(oracle.subgrades!, Number(stored.grade), oracle.deductions),
      "a visibly corner-damaged card must not carry the Black Label shape"
    ).toBe(false);
  });

  // ── F3 regression — the authentication verdict ──────────────────────────────────────────

  it("F3: an operator's Not-Original / Authentic-Altered verdict is HONOURED, not silently discarded", async () => {
    for (const [status, expected] of [
      ["not_original", "NO"],
      ["authentic_altered", "AA"],
    ] as const) {
      const { cookie, certId } = await nextSharedCert();

      const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
        cookie,
        body: {
          ...PERFECT_CENTERING,
          auth_status: status,
          // The panel derives overall_grade from the verdict; the server must derive it too,
          // and must not be taking the client's word for it.
          overall_grade: "10",
          grade_centering: 10,
          auth_notes: "partner-supplied private commentary",
          card_name: `F3 ${status}`,
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const stored = await authorityColumns(certId);
      expect(stored.card_name, "positive control").toBe(`F3 ${status}`);
      expect(stored.auth_status, "the operator's verdict was persisted").toBe(status);
      expect(stored.grade, "a non-numeric outcome stores no numeric grade").toBeNull();
      expect(stored.grade_type, "the row is reclassified by the SERVER from the verdict").not.toBe("numeric");
      expect((res.body as any).authority, "the partner is told the card is not graded").toMatchObject({
        notGraded: true,
        overallGrade: expected,
        basis: "authentication",
      });
      // auth_notes remains HQ-private and refused.
      const notes = await admin.query<{ auth_notes: string | null }>(
        "SELECT auth_notes FROM certificates WHERE id=$1",
        [certId]
      );
      expect(notes.rows[0].auth_notes, "auth_notes stays refused — the verdict is evidence, the notes are not").toBeNull();
      // grade_strength_score is left alone for a non-numeric card, matching the HQ approve route.
      expect(stored.grade_strength_score, "no strength score for a Not-Graded card").toBeNull();
      await assertRowMatchesSharedMaths(certId, `F3 ${status}`);
    }
  });

  // ── F4 regression — the response can never contradict the row ───────────────────────────

  it("F4: the response describes the POST-WRITE row, never a computation that did not land", async () => {
    const { cookie, certId } = await nextSharedCert();

    // Put the row into the non-numeric state first…
    const first = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: { ...PERFECT_CENTERING, auth_status: "authentic_altered", overall_grade: "AA" },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await authorityColumns(certId)).grade_type).not.toBe("numeric");

    // …then send flawless evidence and a numeric claim. Under v1 this returned
    // overallGrade "10" / tier "Gem Mint" / notGraded false with HTTP 200, while the row
    // kept grade_type authentic_altered and grade NULL.
    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: { ...PERFECT_CENTERING, defects: [], overall_grade: "10", grade_centering: 10, card_name: "F4 Probe" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = await authorityColumns(certId);
    expect(stored.card_name, "positive control: the evidence write did land").toBe("F4 Probe");
    const shown = (res.body as any).authority;
    expect(shown.notGraded, "the response reports the row's actual kind").toBe(true);
    expect(shown.overallGrade, "the response reports the row's actual grade").toBe("AA");
    expect(shown.tier, "no tier is claimed for a Not-Graded card").toBeNull();
    expect(stored.grade, "and the row really does carry no numeric grade").toBeNull();
    expect(stored.grade_strength_score, "no strength score written for a non-numeric row").toBeNull();
    await assertRowMatchesSharedMaths(certId, "F4 kind-contradiction probe");
  });

  // ── F7 regression — authority is a function of the row, not of the request ──────────────

  it("F7: evidence written between the computation and the write cannot leave a stale grade", async () => {
    const { cookie, certId } = await nextSharedCert();

    // Simulate the concurrent writer (a second tab, or the proxied manual-centering action)
    // by seeding evidence directly on the row that the request itself never mentions.
    await admin.query(
      `UPDATE certificates
          SET centering_front_lr='90/10', centering_front_tb='90/10',
              centering_back_lr='90/10', centering_back_tb='90/10'
        WHERE id=$1`,
      [certId]
    );

    // A request that says nothing about centering at all.
    const res = await req("PUT", `/api/partner/grading/certificates/${certId}/grade`, {
      cookie,
      body: { defects: SEVERE_SURFACE_PIN, overall_grade: "10", card_name: "F7 Probe" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = await authorityColumns(certId);
    expect(stored.card_name, "positive control").toBe("F7 Probe");
    expect(stored.centering_front_lr, "the concurrent writer's evidence is still on the row").toBe("90/10");
    // The grade follows the ROW's centering, not the request's silence about it.
    await assertRowMatchesSharedMaths(certId, "F7 concurrent-evidence probe");
    expect(Number(stored.grade), "the stored grade reflects the row's real centering").toBeLessThan(10);
  });

  // ── F8 — a tampered save is distinguishable from an honest one ──────────────────────────

  it("F8: the audit trail records WHAT the client tried to author, not just what the server decided", async () => {
    const { cookie: tCookie, certId: tCert } = await nextSharedCert();
    expect(
      (
        await req("PUT", `/api/partner/grading/certificates/${tCert}/grade`, {
          cookie: tCookie,
          body: { ...PERFECT_CENTERING, overall_grade: "10", grade_centering: 10, private_notes: "leak me" },
        })
      ).status
    ).toBe(200);

    const tAudit = await admin.query<{ after_value: Record<string, any> }>(
      `SELECT after_value FROM partner_audit_events
        WHERE record_type='certificate' AND record_id=$1 AND action='grading.draft_saved'
        ORDER BY created_at DESC LIMIT 1`,
      [String(tCert)]
    );
    const claim = tAudit.rows[0].after_value.rejected_client_claim;
    expect(claim, "the rejected claim is recorded").toBeTruthy();
    expect(claim.overall_grade, "including the grade the client tried to author").toBe("10");
    expect(claim.grade_centering).toBe(10);
    // The PII redactor still applies to the recorded claim.
    expect(claim.private_notes, "a recorded claim must never carry the private note itself").toBe("[redacted]");

    // An honest save records no claim, so tampering stands out.
    const { cookie: hCookie, certId: hCert } = await nextSharedCert();
    expect(
      (
        await req("PUT", `/api/partner/grading/certificates/${hCert}/grade`, {
          cookie: hCookie,
          body: { ...PERFECT_CENTERING, defects: [] },
        })
      ).status
    ).toBe(200);
    const hAudit = await admin.query<{ after_value: Record<string, any> }>(
      `SELECT after_value FROM partner_audit_events
        WHERE record_type='certificate' AND record_id=$1 AND action='grading.draft_saved'
        ORDER BY created_at DESC LIMIT 1`,
      [String(hCert)]
    );
    expect(hAudit.rows[0].after_value.rejected_client_claim, "an honest save records no claim").toBeNull();
  });
});
