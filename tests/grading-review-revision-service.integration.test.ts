/**
 * P0 integration proof: run the real `approveGraderCert` implementation over a
 * disposable PostgreSQL 17 database.  The db adapter below only compiles the
 * Drizzle SQL emitted by production code; it does not fake approval outcomes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { CERTIFICATES_PROTECTED_COLUMNS_SQL } from "./helpers/certificates-protected-columns";

const runtime = vi.hoisted(() => ({
  execute: vi.fn(),
  getCertificate: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("../server/db", () => ({ db: { execute: runtime.execute } }));
vi.mock("../server/storage", () => ({
  storage: { getCertificate: runtime.getCertificate, writeAuditLog: runtime.writeAuditLog },
}));
vi.mock("../server/r2", () => ({ getR2SignedUrl: vi.fn(async () => "https://example.invalid/signed") }));

import { approveGraderCert } from "../server/grader";

let cluster: DisposablePostgres17;
let pool: pg.Pool;
const dialect = new PgDialect();

async function certificate() {
  const result = await pool.query<{
    grade: string;
    grading_revision: number;
    grader_status: string;
    status: string;
    grade_approved_at: Date | null;
    print_state: string;
  }>(
    "SELECT grade::text AS grade, grading_revision, grader_status, status, grade_approved_at, print_state FROM certificates WHERE id = 1"
  );
  return result.rows[0];
}

beforeAll(async () => {
  cluster = await startPostgres17("grading-review-revision-service");
  pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
  await pool.query(`
    CREATE TABLE certificates (
      id integer PRIMARY KEY,
      deleted_at timestamptz,
      assigned_grader_id text,
      graded_by text,
      grader_status text NOT NULL,
      redo_count integer NOT NULL DEFAULT 0,
      rejection_reason text,
      certificate_number text NOT NULL,
      grade numeric(4,1),
      grade_type text NOT NULL DEFAULT 'numeric',
      centering_score numeric(4,1), corners_score numeric(4,1),
      edges_score numeric(4,1), surface_score numeric(4,1),
      status text NOT NULL DEFAULT 'pending',
      grade_approved_at timestamptz,
      grade_approved_by text,
      graded_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      print_state text NOT NULL DEFAULT 'awaiting_approval'
    );
    CREATE TABLE audit_log (id bigserial PRIMARY KEY, action text NOT NULL);
  `);
  await pool.query(CERTIFICATES_PROTECTED_COLUMNS_SQL);
  await pool.query(await import("node:fs").then(({ readFileSync }) => readFileSync("migrations/0048_grading_review_revision.sql", "utf8")));

  runtime.execute.mockImplementation(async (statement: any) => {
    const query = dialect.sqlToQuery(statement.getSQL());
    const result = await pool.query(query.sql, query.params as unknown[]);
    return { rows: result.rows };
  });
  runtime.getCertificate.mockImplementation(async () => {
    const row = await certificate();
    return {
      gradeOverall: row.grade,
      gradeCentering: "8.0",
      gradeCorners: "8.0",
      gradeEdges: "8.0",
      gradeSurface: "8.0",
    };
  });
  runtime.writeAuditLog.mockImplementation(async (_type: string, _id: string, action: string) => {
    await pool.query("INSERT INTO audit_log (action) VALUES ($1)", [action]);
  });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

beforeEach(async () => {
  runtime.writeAuditLog.mockClear();
  await pool.query("DELETE FROM audit_log");
  await pool.query("DELETE FROM certificates");
  await pool.query(`
    INSERT INTO certificates (
      id, certificate_number, grade, grade_type, centering_score, corners_score, edges_score, surface_score,
      grader_status, status
    ) VALUES (1, 'MV-SERVICE-CAS', 7.0, 'numeric', 8.0, 8.0, 8.0, 8.0, 'pending_review', 'pending')
  `);
});

describe("approveGraderCert revision binding — real service + real PostgreSQL", () => {
  it("refuses a stale prepared approval and performs no approval/audit/print side effect", async () => {
    const prepared = (await certificate()).grading_revision;
    await pool.query("UPDATE certificates SET grade = 6.0 WHERE id = 1"); // trigger advances revision
    expect((await certificate()).grading_revision).toBe(prepared + 1);

    await expect(approveGraderCert(1, "reviewer-a", prepared)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "STALE_REVIEW",
    });
    expect(await certificate()).toMatchObject({
      grade: "6.0",
      grader_status: "pending_review",
      status: "pending",
      grade_approved_at: null,
      print_state: "awaiting_approval",
    });
    expect(runtime.writeAuditLog).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(0);
  });

  it("allows exactly one concurrent approval of the same server revision and rejects replay", async () => {
    const revision = (await certificate()).grading_revision;
    const [a, b] = await Promise.all([approveGraderCert(1, "reviewer-a", revision), approveGraderCert(1, "reviewer-b", revision)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((result) => !result.ok)).toMatchObject({ status: 409, code: "STALE_REVIEW" });
    expect(await certificate()).toMatchObject({ grader_status: "approved", status: "active", print_state: "needs_printing" });
    expect(runtime.writeAuditLog).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'grade_approve'")).rows[0].n).toBe(1);

    await expect(approveGraderCert(1, "reviewer-a", revision)).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(runtime.writeAuditLog).toHaveBeenCalledTimes(1);
  });
});
