/**
 * P0-C — partner-origin mandatory review, proven over REAL HTTP.
 *
 * Boots the REAL grader router (registerGraderRoutes) on an Express app with a real
 * session, against a DISPOSABLE local PostgreSQL 17 cluster. Every assertion goes
 * through an actual HTTP request to POST /api/grader/certificates/:id/submit — never a
 * direct call into the service layer — and is then re-checked against the database row,
 * because a 200 response is not proof that a cert did or did not publish.
 *
 * The only synthetic element is a TEST-ONLY login route that stamps exactly the session
 * the real staff login produces. requireCapability("grade") runs fully, including its
 * per-request database re-validation.
 *
 * NOTHING in the MVGS engine is exercised or mocked here: these tests seed already-computed
 * grades and assert only on WHO may publish and WHEN.
 *
 * SCHEMA NOTE — the partner-origin marker is `certificates.origin_type`, a closed
 * vocabulary ('PARTNER' | 'HQ' | NULL) introduced by migration 0035, which IS present on
 * this integrated branch. The post-0035 block applies the REAL migration file to its
 * throwaway cluster rather than synthesising a fixture column, so the gate is proven
 * against the schema that actually ships — including 0035's CHECK constraints and its
 * set-once immutability trigger.
 *
 * Three origin states are distinguished, and the distinction is load-bearing:
 *   • column ABSENT (pre-0035)        -> "unknown" -> FAIL CLOSED, mandatory review
 *   • origin_type = 'PARTNER'         -> mandatory review, no sampling bypass
 *   • origin_type = 'HQ'              -> normal HQ sampling
 *   • origin_type IS NULL (legacy row)-> HQ policy, so the pre-0035 back catalogue is
 *                                        not dragged into mandatory review
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { Client } = pg;

const GRADER_ID = "11111111-1111-1111-1111-111111111111";
const GRADER_EMAIL = "grader@example.test";

/**
 * Minimal production-shaped schema: only the tables and columns the grader submit path
 * actually reads or writes. Deliberately created WITHOUT the partner-origin column, so the
 * pre-0035 fail-closed behaviour is provable before the column is added.
 */
const BASE_DDL = `
  CREATE TABLE users (
    id varchar PRIMARY KEY,
    email varchar UNIQUE,
    role varchar(20) NOT NULL DEFAULT 'customer',
    deleted_at timestamp,
    credential_version integer NOT NULL DEFAULT 1,
    can_grade boolean NOT NULL DEFAULT false,
    can_scan boolean NOT NULL DEFAULT false,
    can_print boolean NOT NULL DEFAULT false,
    can_edit_sets boolean NOT NULL DEFAULT false,
    review_rate integer NOT NULL DEFAULT 100
  );
  CREATE TABLE certificates (
    id serial PRIMARY KEY,
    certificate_number text UNIQUE NOT NULL,
    card_name text,
    grade numeric(4,1),
    grade_type text NOT NULL DEFAULT 'numeric',
    centering_score numeric(4,1),
    corners_score numeric(4,1),
    edges_score numeric(4,1),
    surface_score numeric(4,1),
    grade_approved_at timestamptz,
    grade_approved_by text,
    assigned_grader_id varchar,
    grader_status varchar(20) NOT NULL DEFAULT 'unassigned',
    assigned_at timestamptz,
    graded_at timestamptz,
    rejection_reason text,
    redo_count integer NOT NULL DEFAULT 0,
    graded_by varchar,
    operator_grade numeric,
    operator_subgrades jsonb,
    review_required boolean,
    status varchar(10) NOT NULL DEFAULT 'pending',
    print_state varchar(24) NOT NULL DEFAULT 'awaiting_approval',
    deleted_at timestamptz,
    updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
  );
`;

let cluster: DisposablePostgres17;
let client: InstanceType<typeof Client>;
let server: http.Server;
let base: string;
let cookie = "";
let resetPartnerOriginSchemaCache: () => void;

/** Seed one certificate assigned to the grader, ready to submit. */
async function seedCert(opts: {
  certNumber: string;
  cardName?: string | null;
  grade?: string | null;
  gradeType?: string;
  corners?: string | null;
}): Promise<number> {
  const r = await client.query<{ id: number }>(
    `INSERT INTO certificates
       (certificate_number, card_name, grade, grade_type,
        centering_score, corners_score, edges_score, surface_score,
        assigned_grader_id, grader_status, status)
     VALUES ($1,$2,$3,$4, 9.0, $5, 9.0, 9.0, $6, 'assigned', 'pending')
     RETURNING id`,
    [
      opts.certNumber,
      opts.cardName === undefined ? "CHARIZARD" : opts.cardName,
      opts.grade === undefined ? "8.5" : opts.grade,
      opts.gradeType ?? "numeric",
      opts.corners === undefined ? "9.0" : opts.corners,
      GRADER_ID,
    ]
  );
  return r.rows[0].id;
}

async function submit(certId: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/grader/certificates/${certId}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function certRow(certId: number) {
  const r = await client.query(
    `SELECT grader_status, status, grade_approved_by, grade_approved_at, review_required, print_state
       FROM certificates WHERE id = $1`,
    [certId]
  );
  return r.rows[0];
}

async function lastAudit(certId: number) {
  const r = await client.query(
    `SELECT action, details FROM audit_log
      WHERE entity_type = 'certificate' AND entity_id = $1
      ORDER BY id DESC LIMIT 1`,
    [String(certId)]
  );
  return r.rows[0];
}

beforeAll(async () => {
  cluster = await startPostgres17("partner-origin-approval-gate");
  client = new Client({ connectionString: cluster.url });
  await client.connect();
  await client.query(BASE_DDL);
  await client.query(`INSERT INTO users (id, email, role, can_grade, review_rate) VALUES ($1,$2,'customer',true,0)`, [
    GRADER_ID,
    GRADER_EMAIL,
  ]);

  // server/db.ts reads the URL at import time — set it BEFORE any server module loads.
  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";

  const express = (await import("express")).default;
  const session = (await import("express-session")).default;
  const graderModule = await import("../server/grader");
  resetPartnerOriginSchemaCache = graderModule.resetPartnerOriginSchemaCache;
  const { registerGraderRoutes } = await import("../server/routes/grader");

  const app = express();
  app.use(express.json());
  app.use(
    session({
      name: "mv.sid",
      secret: process.env.SESSION_SECRET!,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax" },
    })
  );
  // TEST-ONLY: stamps the same session shape the real staff login produces.
  app.post("/__test/grader-login", (req, res) => {
    const s = req.session as unknown as Record<string, unknown>;
    s.isStaff = true;
    s.staffId = GRADER_ID;
    s.graderId = GRADER_ID;
    s.graderEmail = GRADER_EMAIL;
    s.capGrade = true;
    s.credentialVersion = 1;
    s.authenticatedAt = Date.now();
    req.session.save(() => res.json({ ok: true }));
  });
  registerGraderRoutes(app);

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/__test/grader-login`, { method: "POST" });
  expect(login.status).toBe(200);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toMatch(/^mv\.sid=/);
}, 180_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await client?.end().catch(() => {});
  await cluster?.stop();
});

describe("origin seam FAILS CLOSED before migration 0035 exists", () => {
  it("refuses to auto-publish anything while the partner-origin column is absent", async () => {
    resetPartnerOriginSchemaCache();
    // review_rate = 0 means the sampler alone would auto-approve this card.
    const id = await seedCert({ certNumber: "MV-PRE-0035" });

    const { status, body } = await submit(id);

    expect(status).toBe(200);
    expect(body.gradingStatus).toBe("pending_review");
    expect(body.reviewRequired).toBe(true);
    expect(body.autoApproved).toBeUndefined();

    const row = await certRow(id);
    expect(row.grader_status).toBe("pending_review");
    expect(row.grade_approved_by).toBeNull();
    expect(row.grade_approved_at).toBeNull();
    expect(row.status).not.toBe("active");

    // Origin is UNKNOWN, and unknown is treated as partner-originated.
    expect((await lastAudit(id)).details.forced).toBe("partner_origin");
  }, 60_000);
});

describe("P0-C partner-origin mandatory review (post-0035 column present)", () => {
  beforeAll(async () => {
    // Apply the REAL migration 0035 — not a synthesised fixture column. This is the
    // whole point of the post-integration regression: the gate must key off the
    // canonical `origin_type` vocabulary that ships, including its CHECK constraints
    // and set-once immutability trigger.
    const sql035 = readFileSync(resolve(__dirname, "../migrations/0035_partner_certificate_origin.sql"), "utf8");
    await client.query(sql035);
    resetPartnerOriginSchemaCache();
  });

  it("a PARTNER-originated cert cannot auto-approve even at review_rate = 0", async () => {
    const rate = await client.query(`SELECT review_rate FROM users WHERE id = $1`, [GRADER_ID]);
    expect(Number(rate.rows[0].review_rate)).toBe(0);

    const id = await seedCert({ certNumber: "MV-PARTNER-1" });
    await client.query(
      `UPDATE certificates
          SET origin_type = 'PARTNER',
              origin_partner_id = gen_random_uuid(),
              origin_partner_public_ref = 'PN-TEST-0001',
              origin_partner_legal_name = 'Kent Card Emporium Ltd',
              origin_partner_trading_name = 'Kent Card Emporium',
              origin_location_id = gen_random_uuid(),
              origin_location_public_ref = 'PL-TEST-0001',
              origin_location_name = 'Canterbury Store',
              origin_location_address = '12 High Street, Canterbury, CT1 2AB',
              origin_captured_at = now(),
              origin_snapshot_version = 1
        WHERE id = $1`,
      [id]
    );

    const { status, body } = await submit(id);

    expect(status).toBe(200);
    expect(body.gradingStatus).toBe("pending_review");
    expect(body.reviewRequired).toBe(true);
    expect(body.autoApproved).toBeUndefined();

    const row = await certRow(id);
    expect(row.grader_status).toBe("pending_review");
    expect(row.grade_approved_by).toBeNull();
    expect(row.grade_approved_at).toBeNull();
    expect(row.status).not.toBe("active");
    expect(row.print_state).toBe("awaiting_approval");
    expect(row.review_required).toBe(true);

    const audit = await lastAudit(id);
    expect(audit.action).toBe("grade_submit");
    expect(audit.details.forced).toBe("partner_origin");
    expect(Number(audit.details.review_rate)).toBe(0);
  }, 60_000);

  it("a LEGACY row (0035 applied, origin_type NULL) follows HQ policy and still auto-approves", async () => {
    // Controller decision at integration: the two "no value" cases are NOT the same.
    //   • column ABSENT  = schema ambiguity        -> "unknown" -> FAIL CLOSED (review)
    //   • column present but NULL = known legacy   -> "legacy"  -> HQ policy
    // Every pre-0035 certificate is NULL. Treating those as partner-originated would
    // silently drag the entire back catalogue into mandatory review, which the owner
    // explicitly ruled out ("do not change the normal HQ workflow unless necessary").
    const id = await seedCert({ certNumber: "MV-LEGACY-1" }); // origin_type deliberately left NULL

    const pre = await client.query(`SELECT origin_type FROM certificates WHERE id = $1`, [id]);
    expect(pre.rows[0].origin_type).toBeNull();

    const { status, body } = await submit(id);

    expect(status).toBe(200);
    expect(body.gradingStatus).toBe("approved");
    expect(body.autoApproved).toBe(true);

    const row = await certRow(id);
    expect(row.grade_approved_by).toBe("auto");
    expect(row.grader_status).toBe("approved");
  }, 60_000);

  it("an HQ-originated cert with a clean grade still auto-approves (sampling unchanged)", async () => {
    const id = await seedCert({ certNumber: "MV-HQ-1" });
    await client.query(
      `UPDATE certificates SET origin_type = 'HQ', origin_captured_at = now(), origin_snapshot_version = 1 WHERE id = $1`,
      [id]
    );

    const { status, body } = await submit(id);

    expect(status).toBe(200);
    expect(body.gradingStatus).toBe("approved");
    expect(body.autoApproved).toBe(true);

    const row = await certRow(id);
    expect(row.grader_status).toBe("approved");
    expect(row.grade_approved_by).toBe("auto");
    expect(row.status).toBe("active");
  }, 60_000);

  it("a numeric grade with a NULL sub-grade cannot auto-publish", async () => {
    const id = await seedCert({ certNumber: "MV-HQ-NULLSUB", corners: null });

    const { status, body } = await submit(id);

    expect(status).toBe(200);
    expect(body.gradingStatus).toBe("pending_review");
    expect(body.reviewRequired).toBe(true);

    const row = await certRow(id);
    expect(row.grade_approved_by).toBeNull();
    expect(row.grade_approved_at).toBeNull();
    expect(row.status).not.toBe("active");

    const audit = await lastAudit(id);
    expect(audit.details.forced).toBe("publish_gate");
    expect(audit.details.publish_gate_code).toBe("incomplete_subgrades");
  }, 60_000);

  it("a non-printable grade cannot auto-publish", async () => {
    // Authentication-only kind carrying a numeric grade: checkPrintableGrade calls this a
    // kind/grade contradiction, so no human could approve it — nor may the sampler.
    const id = await seedCert({ certNumber: "MV-HQ-CONTRADICT", gradeType: "NO" });

    const { status, body } = await submit(id);

    expect(status).toBe(200);
    expect(body.gradingStatus).toBe("pending_review");
    expect(body.reviewRequired).toBe(true);

    const row = await certRow(id);
    expect(row.grade_approved_by).toBeNull();
    expect(row.status).not.toBe("active");

    const audit = await lastAudit(id);
    expect(audit.details.forced).toBe("publish_gate");
    expect(audit.details.publish_gate_code).toBe("kind_grade_contradiction");
  }, 60_000);

  it("an off-ladder numeric grade cannot auto-publish", async () => {
    const id = await seedCert({ certNumber: "MV-HQ-OFFLADDER", grade: "8.3" });

    const { status, body } = await submit(id);

    expect(status).toBe(200);
    expect(body.gradingStatus).toBe("pending_review");

    const row = await certRow(id);
    expect(row.grade_approved_by).toBeNull();
    expect(row.status).not.toBe("active");
    expect((await lastAudit(id)).details.publish_gate_code).toBe("off_ladder_numeric_grade");
  }, 60_000);
});
