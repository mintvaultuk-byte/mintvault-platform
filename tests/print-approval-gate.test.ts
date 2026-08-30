/**
 * P0-D — print approval gate, proven over REAL HTTP against the REAL production handler.
 *
 * This boots the actual application router (registerRoutes from server/routes.ts) — not a
 * re-implementation — on a DISPOSABLE local PostgreSQL 17 cluster, and drives
 * POST /api/admin/print-batch by DIRECT API CALL. That matters: the defect was that the
 * endpoint itself had no approval gate, so any proof that relies on the UI hiding a button
 * would prove nothing.
 *
 * What is asserted:
 *   • an unapproved certificate cannot be printed (422 NOT_APPROVED_FOR_PRINT);
 *   • a cert still in review, or bounced back to the grader for correction, cannot be
 *     printed even when it carries a stale grade_approved_at;
 *   • a voided certificate cannot be printed;
 *   • an approved, printable certificate still prints normally (no regression);
 *   • ALL-OR-NOTHING is preserved: one blocked cert refuses the whole batch AND mints no
 *     claim code for the good cert in it (verified against the database, not the response);
 *   • the pre-existing grade-printability pre-pass (the 2026-07-02 "0 / POOR" incident fix)
 *     still fires and still runs FIRST.
 *
 * Artefact generation and R2 upload are stubbed — this suite tests the GATE, and rendering
 * a real PDF/PNG is covered by tests/printable-grade-safety.test.ts. Nothing in the MVGS
 * engine is touched: grades are seeded already-computed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createHash } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const r2Objects = new Map<string, Buffer>();
vi.mock("../server/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/r2")>();
  return {
    ...actual,
    inspectR2ObjectIntegrity: vi.fn(async (key: string) => {
      const body = r2Objects.get(key);
      return body
        ? { exists: true, byteLength: body.length, sha256: createHash("sha256").update(body).digest("hex") }
        : { exists: false };
    }),
    uploadCreateOnlyToR2: vi.fn(async (key: string, body: Buffer) => {
      if (r2Objects.has(key)) throw new Error("conditional create collision");
      r2Objects.set(key, Buffer.from(body));
    }),
    deleteFromR2: vi.fn(async (key: string) => {
      r2Objects.delete(key);
    }),
  };
});

// Stub only the expensive artefact/upload surface. deriveBatchId, the layout constants and
// the pure cut-SVG generator stay REAL so the handler's real control flow is exercised.
vi.mock("../server/print-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/print-batch")>();
  return {
    ...actual,
    generatePrintBatchPDF: vi.fn(async () => Buffer.from("%PDF-stub")),
    generatePrintBatchPNG: vi.fn(async () => Buffer.from("PNG-stub")),
    generatePrintBatchPrintPNG: vi.fn(async () => Buffer.from("PRINTPNG-stub")),
    generateCricutSVG: vi.fn(() => "<svg/>"),
    uploadPrintBatchArtifacts: vi.fn(async () => undefined),
    uploadPrintBatchPDF: vi.fn(async () => undefined),
    uploadCricutSvg: vi.fn(async () => undefined),
  };
});

const { Client } = pg;

let cluster: DisposablePostgres17;
let client: InstanceType<typeof Client>;
let server: http.Server;
let base: string;
let cookie = "";
let ADMIN_EMAIL = "";

/**
 * Build permissive DDL straight from the Drizzle table definition so every column the
 * storage layer selects exists. Constraints are deliberately omitted (all columns
 * nullable): this fixture only has to satisfy reads/writes, not model production
 * integrity rules.
 */
function ddlFromSchema(table: unknown, extraCols: string[] = []): string {
  const cfg = getTableConfig(table as never);
  const cols = cfg.columns.map((c) => {
    // `serial` already implies NOT NULL DEFAULT nextval(...). pgvector types are
    // downgraded to text — the extension is not installed on the disposable cluster and
    // no code path under test reads an embedding.
    const type = /^vector\b/i.test(c.getSQLType()) ? "text" : c.getSQLType();
    return `"${c.name}" ${type}`;
  });
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (${[...cols, ...extraCols].join(", ")})`;
}

type SeedOpts = {
  certNumber: string;
  grade?: string | null;
  gradeType?: string;
  approvedAt?: string | null;
  graderStatus?: string;
  status?: string;
  ownershipStatus?: string;
};

async function seedCert(o: SeedOpts) {
  await client.query(
    `INSERT INTO certificates
       (certificate_number, card_name, set_name, year_text, card_number_display,
        grade, grade_type, centering_score, corners_score, edges_score, surface_score,
        grade_approved_at, grade_approved_by, grader_status, status, ownership_status, print_state)
     VALUES ($1,'CHARIZARD','Base Set','1999','4',
        $2,$3, 9.0, 9.0, 9.0, 9.0,
        $4, $5, $6, $7, $8, 'awaiting_approval')`,
    [
      o.certNumber,
      o.grade === undefined ? "8.5" : o.grade,
      o.gradeType ?? "numeric",
      o.approvedAt === undefined ? new Date().toISOString() : o.approvedAt,
      o.approvedAt === null ? null : "admin@example.test",
      o.graderStatus ?? "approved",
      o.status ?? "active",
      o.ownershipStatus ?? "unclaimed",
    ]
  );
}

async function printBatch(certIds: string[]): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/admin/print-batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "Idempotency-Key": `approval-gate:${certIds.join(",")}`,
    },
    body: JSON.stringify({ certIds }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function claimCodeOf(certNumber: string): Promise<string | null> {
  const r = await client.query(`SELECT claim_code FROM certificates WHERE certificate_number = $1`, [certNumber]);
  return r.rows[0]?.claim_code ?? null;
}

async function printBatchAuditCount(): Promise<number> {
  const r = await client.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'print_batch_generated'`);
  return r.rows[0].n;
}

beforeAll(async () => {
  cluster = await startPostgres17("print-approval-gate");
  client = new Client({ connectionString: cluster.url });
  await client.connect();

  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  process.env.SESSION_SECRET = "synthetic-test-session-secret-not-committed";
  process.env.SKIP_BACKFILL = "true";

  const schema = await import("@shared/schema");
  // `claim_code` is a live production column that predates the Drizzle model (the storage
  // layer reads/writes it via raw SQL), so it is added explicitly.
  await client.query(ddlFromSchema(schema.certificates, [`"claim_code" text`]));
  await client.query(ddlFromSchema(schema.users));
  await client.query(ddlFromSchema(schema.auditLog));
  await client.query(ddlFromSchema(schema.labelPrints));
  await client.query(ddlFromSchema(schema.labelOverrides));
  await client.query(`
    CREATE TABLE submissions(
      id serial PRIMARY KEY,tracking_number text NOT NULL UNIQUE,status text NOT NULL,
      status_history jsonb NOT NULL DEFAULT '[]'::jsonb,on_receipt_photo_urls text,
      received_at timestamptz,deleted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE partner_organisations(id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION partner_current_tenant()
    RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
      SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid
    $fn$;
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_certificates_certno ON certificates (certificate_number)`);
  // label_prints.cert_id is UNIQUE in production — the batch dual-write upserts on it.
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_label_prints_cert ON label_prints (cert_id)`);
  const migration = (filename: string) => listMigrationFiles().find((entry) => entry.filename === filename)!;
  await applyMigrations(client, [
    migration("0022_print_workflow_lifecycle.sql"),
    migration("0121_main_runtime_role_authority.sql"),
    migration("0122_object_write_intent_reconciliation.sql"),
  ]);

  const authMod = await import("../server/auth");
  ADMIN_EMAIL = authMod.ADMIN_EMAIL;
  await client.query(
    `INSERT INTO users (id, email, role, credential_version) VALUES (gen_random_uuid(),$1,'admin',1)`,
    [ADMIN_EMAIL.toLowerCase()]
  );

  // ── Fixtures ──────────────────────────────────────────────────────────────
  await seedCert({ certNumber: "MV9001" }); // fully approved + printable
  await seedCert({ certNumber: "MV9002", approvedAt: null, graderStatus: "unassigned" }); // never approved
  await seedCert({ certNumber: "MV9003", graderStatus: "pending_review" }); // stale approval, in review
  await seedCert({ certNumber: "MV9004", graderStatus: "assigned" }); // bounced back for correction
  await seedCert({ certNumber: "MV9005", status: "voided" }); // approved but voided
  await seedCert({ certNumber: "MV9006", grade: null }); // approved but NO grade
  await seedCert({ certNumber: "MV9007" }); // second good cert, for the all-or-nothing test

  const express = (await import("express")).default;
  const session = (await import("express-session")).default;
  const { registerRoutes } = await import("../server/routes");

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
  // TEST-ONLY: stamps the session the real two-step admin login produces. requireAdmin
  // itself runs unmodified, including its per-request database re-validation.
  app.post("/__test/admin-login", (req, res) => {
    const s = req.session as unknown as Record<string, unknown>;
    s.isAdmin = true;
    s.adminEmail = ADMIN_EMAIL;
    s.credentialVersion = 1;
    s.authenticatedAt = Date.now();
    req.session.save(() => res.json({ ok: true }));
  });

  server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/__test/admin-login`, { method: "POST" });
  expect(login.status).toBe(200);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toMatch(/^mv\.sid=/);
}, 300_000);

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  // Drain the app's own pool before stopping the cluster, otherwise pg_ctl waits on it.
  await import("../server/db").then((m) => m.pool.end()).catch(() => {});
  await client?.end().catch(() => {});
  await cluster?.stop();
}, 120_000);

describe("P0-D print approval gate on the REAL POST /api/admin/print-batch", () => {
  it("requires an admin session at all (the gate is not the only thing protecting this)", async () => {
    const res = await fetch(`${base}/api/admin/print-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ certIds: ["MV9001"] }),
    });
    expect(res.status).toBe(401);
  }, 60_000);

  it("REFUSES an unapproved certificate by direct API call", async () => {
    const { status, body } = await printBatch(["MV9002"]);
    expect(status).toBe(422);
    expect(body.code).toBe("NOT_APPROVED_FOR_PRINT");
    expect(body.blockedCertIds).toEqual(["MV9002"]);
    expect(body.blocked[0].code).toBe("not_approved");
    // No side effects: no claim code minted, no batch audit row.
    expect(await claimCodeOf("MV9002")).toBeNull();
  }, 60_000);

  it("REFUSES a certificate still in grading review even with a stale grade_approved_at", async () => {
    const { status, body } = await printBatch(["MV9003"]);
    expect(status).toBe(422);
    expect(body.code).toBe("NOT_APPROVED_FOR_PRINT");
    expect(body.blocked[0].code).toBe("grade_review_incomplete");
    expect(await claimCodeOf("MV9003")).toBeNull();
  }, 60_000);

  it("REFUSES a certificate bounced back to the grader for correction", async () => {
    const { status, body } = await printBatch(["MV9004"]);
    expect(status).toBe(422);
    expect(body.blocked[0].code).toBe("grade_review_incomplete");
    expect(await claimCodeOf("MV9004")).toBeNull();
  }, 60_000);

  it("REFUSES a voided certificate", async () => {
    const { status, body } = await printBatch(["MV9005"]);
    expect(status).toBe(422);
    expect(body.blocked[0].code).toBe("cert_not_active");
  }, 60_000);

  it("still enforces the grade-printability pre-pass, and runs it FIRST", async () => {
    // Approved and active, but carrying no numeric grade — the 2026-07-02 incident shape.
    const { status, body } = await printBatch(["MV9006"]);
    expect(status).toBe(422);
    expect(body.code).toBe("UNPRINTABLE_GRADE");
    expect(body.blocked[0].code).toBe("missing_numeric_grade");
    expect(await claimCodeOf("MV9006")).toBeNull();
  }, 60_000);

  it("PRINTS an approved, printable certificate normally", async () => {
    const before = await printBatchAuditCount();
    const { status, body } = await printBatch(["MV9001"]);
    expect(status).toBe(200);
    expect(body.batchId).toBeTruthy();
    expect(body.certIds).toEqual(["MV9001"]);
    // Proof it really went through the full path: a claim code was minted and the batch
    // was recorded.
    expect(await claimCodeOf("MV9001")).toBeTruthy();
    expect(await printBatchAuditCount()).toBe(before + 1);
  }, 120_000);

  it("is ALL-OR-NOTHING: one blocked cert refuses the batch and mints nothing for the good one", async () => {
    const beforeAudit = await printBatchAuditCount();
    const { status, body } = await printBatch(["MV9007", "MV9002"]);
    expect(status).toBe(422);
    expect(body.code).toBe("NOT_APPROVED_FOR_PRINT");
    expect(body.blockedCertIds).toEqual(["MV9002"]);
    // The GOOD cert in the refused batch must be untouched — no claim code minted.
    expect(await claimCodeOf("MV9007")).toBeNull();
    expect(await printBatchAuditCount()).toBe(beforeAudit);
  }, 60_000);
});
