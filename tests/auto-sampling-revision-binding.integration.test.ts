/**
 * Model A auto-sampling proof: run the real revision-bound submit/publish
 * helpers against PostgreSQL. No mocked approval result is accepted here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { CERTIFICATES_PROTECTED_COLUMNS_SQL } from "./helpers/certificates-protected-columns";

const runtime = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../server/db", () => ({ db: { execute: runtime.execute } }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/r2", () => ({ getR2SignedUrl: vi.fn(async () => "https://example.invalid/signed") }));

import { approveCertGrade, autoApproveAssignedGradeAtRevision, submitAssignedGradeAtRevision } from "../server/grader";

let cluster: DisposablePostgres17;
let pool: pg.Pool;
const dialect = new PgDialect();

async function state() {
  const r = await pool.query<{
    grade: string;
    grading_revision: number;
    grader_status: string;
    status: string;
    review_required: boolean | null;
    grade_approved_at: Date | null;
    grade_approved_by: string | null;
    print_state: string;
    operator_grade: string | null;
    nfc_written_at: Date | null;
    claim_code_hash: string | null;
    partner_credit_settled: boolean;
  }>(`
    SELECT grade::text AS grade, grading_revision, grader_status, status,
           review_required, grade_approved_at, grade_approved_by, print_state,
           operator_grade::text AS operator_grade, nfc_written_at, claim_code_hash,
           partner_credit_settled
      FROM certificates WHERE id = 1
  `);
  return r.rows[0];
}

beforeAll(async () => {
  cluster = await startPostgres17("auto-sampling-revision-binding");
  pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
  await pool.query(`
    CREATE TABLE certificates (
      id integer PRIMARY KEY,
      assigned_grader_id text,
      graded_by text,
      grader_status text NOT NULL,
      grade numeric(4,1),
      centering_score numeric(4,1), corners_score numeric(4,1),
      edges_score numeric(4,1), surface_score numeric(4,1),
      operator_grade numeric(4,1), operator_subgrades jsonb,
      review_required boolean,
      status text NOT NULL DEFAULT 'pending',
      grade_approved_at timestamptz, grade_approved_by text, graded_at timestamptz,
      print_state text NOT NULL DEFAULT 'awaiting_approval',
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      nfc_written_at timestamptz, claim_code_hash text,
      partner_credit_settled boolean NOT NULL DEFAULT false
    );
  `);
  await pool.query(CERTIFICATES_PROTECTED_COLUMNS_SQL);
  await pool.query(readFileSync("migrations/0048_grading_review_revision.sql", "utf8"));
  runtime.execute.mockImplementation(async (statement: any) => {
    const query = dialect.sqlToQuery(statement.getSQL());
    const result = await pool.query(query.sql, query.params as unknown[]);
    return { rows: result.rows };
  });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

beforeEach(async () => {
  await pool.query("DELETE FROM certificates");
  await pool.query(`
    INSERT INTO certificates (
      id, assigned_grader_id, grader_status, grade,
      centering_score, corners_score, edges_score, surface_score
    ) VALUES (1, 'grader-1', 'assigned', 7.0, 8.0, 8.0, 8.0, 8.0)
  `);
});

describe("Model A sampled auto-approval revision binding", () => {
  it("refuses R7 after a concurrent authoritative R8 grade write with no publication side effects", async () => {
    const r7 = (await state()).grading_revision;
    await pool.query("UPDATE certificates SET grade = 6.0 WHERE id = 1");
    expect((await state()).grading_revision).toBe(r7 + 1);

    await expect(autoApproveAssignedGradeAtRevision(1, "grader@example.test", "grader-1", r7)).resolves.toBe(false);
    expect(await state()).toMatchObject({
      grade: "6.0",
      grading_revision: r7 + 1,
      grader_status: "assigned",
      status: "pending",
      review_required: null,
      grade_approved_at: null,
      grade_approved_by: null,
      print_state: "awaiting_approval",
      nfc_written_at: null,
      claim_code_hash: null,
      partner_credit_settled: false,
    });
  });

  it("publishes only the exact current persisted revision and snapshots that grade", async () => {
    const r7 = (await state()).grading_revision;
    await expect(autoApproveAssignedGradeAtRevision(1, "grader@example.test", "grader-1", r7)).resolves.toBe(true);
    expect(await state()).toMatchObject({
      grade: "7.0",
      operator_grade: "7.0",
      grader_status: "approved",
      status: "active",
      grade_approved_by: "grader@example.test",
      print_state: "needs_printing",
    });
  });

  it("permits exactly one concurrent auto-sampling transition at one revision", async () => {
    const revision = (await state()).grading_revision;
    const outcomes = await Promise.all([
      autoApproveAssignedGradeAtRevision(1, "a@example.test", "grader-1", revision),
      autoApproveAssignedGradeAtRevision(1, "b@example.test", "grader-1", revision),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await autoApproveAssignedGradeAtRevision(1, "replay@example.test", "grader-1", revision)).toBe(false);
    expect(await state()).toMatchObject({ grader_status: "approved", status: "active" });
  });

  it("makes simultaneous sampled-auto and human-review workflow claims mutually exclusive", async () => {
    const revision = (await state()).grading_revision;
    const outcomes = await Promise.all([
      autoApproveAssignedGradeAtRevision(1, "sampler@example.test", "grader-1", revision),
      submitAssignedGradeAtRevision(1, "grader-1", revision),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const current = await state();
    if (current.grader_status === "approved") {
      // A manual approval is never a second way to publish an auto-finalised row.
      await expect(approveCertGrade(1, "reviewer@example.test", revision)).resolves.toBe(false);
      expect((await state()).grade_approved_by).toBe("sampler@example.test");
    } else {
      expect(current).toMatchObject({ grader_status: "pending_review", status: "pending", grade_approved_at: null });
      // The human reviewer may publish only the same revision that won the review claim.
      await expect(approveCertGrade(1, "reviewer@example.test", revision)).resolves.toBe(true);
      expect((await state()).grader_status).toBe("approved");
    }
  });

  it("binds the mandatory-review transition to R and cannot turn a newer grade pending review", async () => {
    const r7 = (await state()).grading_revision;
    await pool.query("UPDATE certificates SET corners_score = 6.0 WHERE id = 1");
    await expect(submitAssignedGradeAtRevision(1, "grader-1", r7)).resolves.toBe(false);
    expect(await state()).toMatchObject({ grader_status: "assigned", grade_approved_at: null });

    const r8 = (await state()).grading_revision;
    await expect(submitAssignedGradeAtRevision(1, "grader-1", r8)).resolves.toBe(true);
    expect(await state()).toMatchObject({
      grader_status: "pending_review",
      review_required: true,
      operator_grade: "7.0",
      grade_approved_at: null,
      print_state: "awaiting_approval",
    });
  });
});
