/**
 * HTTP-level proof for Super Admin Correction Mode.
 *
 * This starts the real route and real requireSuperAdmin middleware over a disposable local
 * PostgreSQL 17.10 database. The only transport double is R2, which records writes so rejected
 * targets can prove that no upload was attempted. Authentication is not mocked: a test-only
 * login endpoint stamps the same server-side session fields produced by the admin login flow.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const runtime = vi.hoisted(() => ({
  db: null as unknown,
  pool: null as unknown,
  uploads: [] as Array<{ key: string; contentType: string; bytes: number }>,
  uploadError: null as Error | null,
}));

// This is a connection substitution, not a fake database: all route/service SQL and transaction
// behaviour run against the disposable PostgreSQL cluster below. server/db.ts always configures
// TLS, which a locally-started test server does not expose.
vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("Route test database was used before setup");
    return runtime.db;
  },
  get pool() {
    if (!runtime.pool) throw new Error("Route test pool was used before setup");
    return runtime.pool;
  },
}));

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async (key: string, body: Buffer, contentType: string) => {
    runtime.uploads.push({ key, contentType, bytes: body.length });
    if (runtime.uploadError) throw runtime.uploadError;
    return key;
  }),
}));

const CERT_ID = 4242;
const SUPER_ADMIN_EMAIL = "mintvaultuk@gmail.com";
const NORMAL_ADMIN_EMAIL = "normal-admin@example.test";

let cluster: DisposablePostgres17;
let pool: pg.Pool;
let server: Server;
let base: string;
let errorSpy: ReturnType<typeof vi.spyOn>;
let registerCorrectionModeRoutes: typeof import("../server/correction-mode").registerCorrectionModeRoutes;

async function seedCertificate(options: { id?: number; approved?: boolean; deleted?: boolean } = {}): Promise<number> {
  const id = options.id ?? CERT_ID;
  const approved = options.approved ?? true;
  const deleted = options.deleted ?? false;
  await pool.query("DELETE FROM audit_log");
  await pool.query("DELETE FROM certificates");
  await pool.query(
    `INSERT INTO certificates (
      id, certificate_number, card_game, set_name, card_name, card_number_display, year_text,
      grade_type, grade, graded_by, ai_defect_candidates, grade_approved_at, deleted_at, grading_version, updated_at
    ) VALUES ($1, 'MV-0000004242', 'Pokemon', 'Base Set', 'Charizard', '7', '1999',
      'numeric', 8.5, 'grader-1', '[]'::jsonb,
      CASE WHEN $2 THEN NOW() - INTERVAL '1 day' ELSE NULL END,
      CASE WHEN $3 THEN NOW() ELSE NULL END,
      1,
      NOW() - INTERVAL '1 hour')`,
    [id, approved, deleted]
  );
  const version = await pool.query<{ version: number }>(
    "SELECT grading_version AS version FROM certificates WHERE id = $1",
    [id]
  );
  return version.rows[0].version;
}

function correctionForm(
  version: number,
  options: {
    malformedGrading?: boolean;
    image?: boolean;
    changes?: Record<string, string>;
    grading?: Record<string, unknown>;
  } = {}
) {
  const data = new FormData();
  const fields: Record<string, string> = {
    expectedVersion: String(version),
    cardGame: "Pokemon",
    setName: "Base Set",
    cardName: "Charizard Corrected",
    cardNumber: "7",
    year: "1999",
    gradingPayload: options.malformedGrading ? "{not-json" : JSON.stringify(options.grading || {}),
    ...options.changes,
  };
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  if (options.image) data.append("frontImage", new Blob(["not-a-real-png"], { type: "image/png" }), "front.png");
  return data;
}

async function testSession(kind: "super" | "normal"): Promise<string> {
  const response = await fetch(`${base}/__test/admin-session/${kind}`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";", 1)[0];
}

function correctionRequest(path: string, body: FormData, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "PUT",
    headers: cookie ? { cookie } : {},
    body,
  });
}

describe("PUT /api/admin/certificates/:id/correction", () => {
  beforeAll(async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cluster = await startPostgres17("super-admin-correction-route");
    pool = new pg.Pool({ connectionString: cluster.url, max: 6 });
    runtime.pool = pool;
    runtime.db = drizzle(pool);

    await pool.query(`
      CREATE TABLE users (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE,
        first_name varchar, last_name varchar, profile_image_url varchar,
        role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        password_hash text, display_name text, email_verified boolean NOT NULL DEFAULT false,
        email_verified_at timestamp, last_login_at timestamp, last_login_ip text,
        failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp,
        last_failed_login_at timestamp, credential_version integer NOT NULL DEFAULT 1,
        admin_passphrase_hash text, pin_hash text, pin_set_at timestamp,
        pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp,
        public_name boolean NOT NULL DEFAULT false, can_grade boolean NOT NULL DEFAULT false,
        can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
        can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100
      )`);
    await pool.query(`
      CREATE TABLE certificates (
        id integer PRIMARY KEY,
        certificate_number text, card_game text, set_name text, card_name text, card_number_display text,
        year_text text, language text, notes text,
        rarity text, rarity_other text, variant text, variant_other text,
        collection text, collection_code text, collection_other text, designations jsonb,
        grade_type text, grade numeric,
        centering_score numeric, corners_score numeric, edges_score numeric, surface_score numeric,
        centering_front_lr text, centering_front_tb text, centering_back_lr text, centering_back_tb text,
        corner_values jsonb, edge_values jsonb, surface_values jsonb,
        defects jsonb, ai_defect_candidates jsonb,
        auth_status text, auth_notes text, grade_explanation text,
        dark_border_front boolean, dark_border_back boolean, dark_border boolean,
        eye_appeal_modifier integer, whitening_lines jsonb, crease_lines jsonb,
        crease_span_pct numeric, wrinkle_severity text, tear_severity text,
        front_image_path text, back_image_path text,
        graded_by text, grade_approved_at timestamp, deleted_at timestamp,
        grading_version integer NOT NULL DEFAULT 1,
        updated_at timestamp NOT NULL DEFAULT now()
      )`);
    await pool.query(`
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
        admin_user text, details jsonb, created_at timestamp NOT NULL DEFAULT now()
      )`);
    await pool.query("INSERT INTO users (email, role, credential_version) VALUES ($1, 'admin', 1)", [
      SUPER_ADMIN_EMAIL,
    ]);

    // Preserve M3: this correction mode has exactly the single configured admin as Super Admin.
    process.env.SUPER_ADMIN_EMAILS = SUPER_ADMIN_EMAIL;
    ({ registerCorrectionModeRoutes } = await import("../server/correction-mode"));

    const app = express();
    app.use(
      session({
        name: "mv.sid",
        secret: "super-admin-correction-route-test-secret",
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax", secure: false },
      })
    );
    // Test-only session issuer. It exercises the unmocked requireAdmin/requireSuperAdmin
    // middleware with the same authenticated session fields production reads.
    app.post("/__test/admin-session/:kind", (req, res) => {
      const email = req.params.kind === "super" ? SUPER_ADMIN_EMAIL : NORMAL_ADMIN_EMAIL;
      Object.assign(req.session, {
        isAdmin: true,
        adminEmail: email,
        credentialVersion: 1,
        authenticatedAt: Date.now(),
      });
      req.session.save((error) => {
        if (error) return res.status(500).json({ error: error.message });
        return res.json({ ok: true });
      });
    });
    registerCorrectionModeRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  beforeEach(async () => {
    runtime.uploads.length = 0;
    runtime.uploadError = null;
    await pool.query("ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS reject_correction_audit");
    await seedCertificate();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end().catch(() => {});
    runtime.db = null;
    runtime.pool = null;
    await cluster?.stop();
    errorSpy?.mockRestore();
  });

  it("rejects unauthenticated and non-Super-Admin sessions before any upload", async () => {
    const version = await seedCertificate();
    const unauthenticated = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { image: true })
    );
    expect(unauthenticated.status).toBe(401);
    expect(runtime.uploads).toEqual([]);

    const normalAdmin = await testSession("normal");
    const rejected = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { image: true }),
      normalAdmin
    );
    expect(rejected.status).toBe(403);
    expect(runtime.uploads).toEqual([]);
  });

  it("rejects missing, deleted, unapproved, and stale targets before R2 is attempted", async () => {
    const cookie = await testSession("super");

    let response = await correctionRequest(
      "/api/admin/certificates/999999/correction",
      correctionForm(1, { image: true }),
      cookie
    );
    expect(response.status).toBe(404);
    expect(runtime.uploads).toEqual([]);

    let version = await seedCertificate({ deleted: true });
    response = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { image: true }),
      cookie
    );
    expect(response.status).toBe(404);
    expect(runtime.uploads).toEqual([]);

    version = await seedCertificate({ approved: false });
    response = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { image: true }),
      cookie
    );
    expect(response.status).toBe(409);
    expect(runtime.uploads).toEqual([]);

    version = await seedCertificate();
    response = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version + 1, { image: true }),
      cookie
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "GRADING_VERSION_CONFLICT",
      expectedVersion: version + 1,
      currentVersion: version,
      reload: true,
    });
    expect(runtime.uploads).toEqual([]);
  });

  it("returns 400 for malformed grading JSON before R2 is attempted", async () => {
    const cookie = await testSession("super");
    const version = await seedCertificate();
    const response = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { malformedGrading: true, image: true }),
      cookie
    );

    expect(response.status).toBe(400);
    expect(runtime.uploads).toEqual([]);
  });

  it("uses the authenticated Super Admin and server-derived certificate number for a successful multipart correction", async () => {
    const cookie = await testSession("super");
    const version = await seedCertificate();
    const response = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, {
        image: true,
        changes: {
          actor: "attacker@example.test",
          adminEmail: "attacker@example.test",
          isAdmin: "false",
          certId: "../../attacker-controlled",
          certificateNumber: "../../attacker-controlled",
        },
      }),
      cookie
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, noChange: false });
    expect(runtime.uploads).toHaveLength(1);
    expect(runtime.uploads[0]).toMatchObject({
      key: expect.stringMatching(/^corrections\/MV4242\/front\/[0-9a-f-]+\.png$/),
      contentType: "image/png",
    });
    expect(runtime.uploads[0].key).not.toContain("attacker-controlled");

    const certificate = await pool.query("SELECT card_name, front_image_path FROM certificates WHERE id = $1", [
      CERT_ID,
    ]);
    expect(certificate.rows[0]).toMatchObject({
      card_name: "Charizard Corrected",
      front_image_path: runtime.uploads[0].key,
    });
    const audit = await pool.query("SELECT admin_user FROM audit_log");
    expect(audit.rows).toEqual([{ admin_user: SUPER_ADMIN_EMAIL }]);
  });

  it("keeps writer A's grade when stale writer B submits a later grade", async () => {
    const cookie = await testSession("super");
    const version = await seedCertificate();

    const writerA = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { grading: { overall_grade: "7" } }),
      cookie
    );
    expect(writerA.status).toBe(200);
    expect(await writerA.json()).toMatchObject({ gradingVersion: version + 1 });

    const writerB = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { grading: { overall_grade: "9" } }),
      cookie
    );
    expect(writerB.status).toBe(409);
    expect(await writerB.json()).toMatchObject({ code: "GRADING_VERSION_CONFLICT" });

    const stored = await pool.query("SELECT grade, grading_version FROM certificates WHERE id = $1", [CERT_ID]);
    expect(Number(stored.rows[0].grade)).toBe(7);
    expect(Number(stored.rows[0].grading_version)).toBe(version + 1);
  });

  it("does not report success when the mandatory audit/database write fails", async () => {
    const cookie = await testSession("super");
    const version = await seedCertificate();
    await pool.query("ALTER TABLE audit_log ADD CONSTRAINT reject_correction_audit CHECK (false) NOT VALID");

    const response = await correctionRequest(
      `/api/admin/certificates/${CERT_ID}/correction`,
      correctionForm(version, { image: true }),
      cookie
    );

    expect(response.status).toBe(500);
    expect(await response.json()).not.toMatchObject({ ok: true });
    // Upload happens only after target preflight; this test proves the later database failure
    // cannot be converted into a false HTTP success.
    expect(runtime.uploads).toHaveLength(1);
    expect((await pool.query("SELECT card_name FROM certificates WHERE id = $1", [CERT_ID])).rows[0].card_name).toBe(
      "Charizard"
    );
    expect((await pool.query("SELECT id FROM audit_log")).rows).toHaveLength(0);
  });
});
