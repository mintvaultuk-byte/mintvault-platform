/**
 * P0 review-revision binding proof.
 *
 * The application assertions below pin the shipped route/service contract.  The
 * database cases deliberately execute the same single-statement CAS shape
 * against a disposable PostgreSQL 17 instance: a stale reviewer must not be
 * able to publish a newer grade they have not inspected, and concurrent
 * approvals have exactly one winner.  This is not a mocked approval result.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const GRADER = read("server/grader.ts");
const ROUTES = read("server/routes/grader.ts");
const ADMIN_ROUTES = read("server/routes.ts");
const SCHEMA = read("shared/schema.ts");
const MIGRATION = read("migrations/0048_grading_review_revision.sql");

let cluster: DisposablePostgres17;
let pool: pg.Pool;

async function approveAtRevision(id: number, expectedRevision: number): Promise<number> {
  const result = await pool.query(
    `UPDATE certificates
       SET grade_approved_at = NOW(), grade_approved_by = 'reviewer', status = 'active',
           grader_status = 'approved', graded_at = NOW(), updated_at = NOW(),
           print_state = CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing' ELSE print_state END
     WHERE id = $1 AND grader_status = 'pending_review' AND grading_revision = $2
     RETURNING id`,
    [id, expectedRevision]
  );
  return result.rowCount ?? 0;
}

async function state() {
  const result = await pool.query<{
    grade: string;
    grading_revision: number;
    grader_status: string;
    status: string;
    grade_approved_at: Date | null;
    print_state: string;
    nfc_written_at: Date | null;
    claim_code_hash: string | null;
    partner_credit_settled: boolean;
  }>(
    `SELECT grade::text AS grade, grading_revision, grader_status, status, grade_approved_at,
            print_state, nfc_written_at, claim_code_hash, partner_credit_settled
       FROM certificates WHERE id = 1`
  );
  return result.rows[0];
}

beforeAll(async () => {
  cluster = await startPostgres17("grading-review-revision-cas");
  pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
  // Intentionally production-shaped only for the columns touched by the P0
  // transition.  The migration itself must add the revision to this existing
  // certificate table without rewriting or issuing any certificate.
  await pool.query(`
    CREATE TABLE certificates (
      id integer PRIMARY KEY,
      certificate_number text NOT NULL,
      grade numeric(4,1) NOT NULL,
      centering_score numeric(4,1),
      defects jsonb,
      auth_status text,
      is_black_label boolean,
      card_name text,
      grader_status text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      grade_approved_at timestamptz,
      grade_approved_by text,
      graded_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      print_state text NOT NULL DEFAULT 'awaiting_approval',
      nfc_written_at timestamptz,
      claim_code_hash text,
      partner_credit_settled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE audit_log (id bigserial PRIMARY KEY, action text NOT NULL);
  `);
  await pool.query(MIGRATION);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

beforeEach(async () => {
  await pool.query("DELETE FROM audit_log");
  await pool.query("DELETE FROM certificates");
  await pool.query(
    `INSERT INTO certificates (id, certificate_number, grade, grader_status, status)
     VALUES (1, 'MV-REVISION-1', 7.0, 'pending_review', 'pending')`
  );
});

describe("grading review revision contract", () => {
  it("ships an explicit schema/migration revision, advances it on an authoritative draft, and returns it", () => {
    expect(SCHEMA).toContain('gradingRevision: integer("grading_revision")');
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS grading_revision INTEGER NOT NULL DEFAULT 1/i);
    expect(MIGRATION).toContain("CREATE TRIGGER trg_certificates_advance_grading_revision");
    expect(MIGRATION).toContain("NEW.grading_revision := GREATEST(COALESCE(OLD.grading_revision, 1), 1) + 1");
    expect(GRADER).toMatch(/RETURNING\s+grading_revision/i);
    expect(ROUTES).toMatch(/reviewRevision:\s*r\.revision/);
  });

  it("requires a positive safe expected revision at the HTTP boundary; it has no unsafe legacy fallback", () => {
    const approvalRoute = ROUTES.slice(
      ROUTES.indexOf('"/api/admin/certificates/:id/approve-grader-grade"'),
      ROUTES.indexOf('"/api/admin/certificates/:id/reject-grade"')
    );
    expect(approvalRoute).toContain("expectedRevision");
    expect(ROUTES).toMatch(/function expectedReviewRevision\(raw: unknown\): number \| null/);
    expect(ROUTES).toMatch(/Number\.isSafeInteger\(raw\)/);
    expect(ROUTES).toMatch(/raw < 1/);
    expect(approvalRoute).toMatch(/res\.status\(400\)/);
    expect(approvalRoute).toMatch(/approveGraderCert\(certId, adminUser, revision\)/);
    expect(approvalRoute).not.toMatch(/approveGraderCert\(certId, adminUser\)(?!\s*,)/);
  });

  it("binds the production publish CAS to pending_review AND the exact grading revision", () => {
    const publish = GRADER.slice(GRADER.indexOf("export async function approveCertGrade"), GRADER.indexOf("// ═", GRADER.indexOf("export async function approveCertGrade")));
    expect(publish).toMatch(/grader_status\s*=\s*'pending_review'/);
    expect(publish).toMatch(/grading_revision\s*=\s*\$\{expectedRevision\}/);
    expect(GRADER).toMatch(/code:\s*["']STALE_REVIEW["']/);
  });

  it("also binds Super Admin's non-grader approval route to the exact server revision", () => {
    const start = ADMIN_ROUTES.indexOf('app.put("/api/admin/certificates/:id/approve"');
    const route = ADMIN_ROUTES.slice(start, ADMIN_ROUTES.indexOf("app.", start + 80));
    expect(start).toBeGreaterThan(0);
    expect(route).toContain("expectedReviewRevision((req.body ?? {}).expectedRevision)");
    expect(route).toContain("res.status(400)");
    expect(route).toMatch(/grade_approved_at IS NULL[\s\S]*grading_revision = \$\{expectedRevision\}/);
    expect(route).toContain('code: "STALE_REVIEW"');
    const approvalUpdate = route.slice(route.indexOf("const approvalWrite"), route.indexOf("if (approvalWrite.rows.length === 0)"));
    // This route may transition state only. Any request-body grade/identity
    // write here could bypass the previewed revision immediately before CAS.
    for (const forbiddenSetField of [
      "grade =",
      "centering_score =",
      "corners_score =",
      "edges_score =",
      "surface_score =",
      "defects =",
      "auth_status =",
      "card_name =",
      "set_name =",
      "label_type =",
    ]) {
      expect(approvalUpdate, `Super Admin approve must not mutate ${forbiddenSetField}`).not.toContain(forbiddenSetField);
    }
  });
});

describe("grading review revision CAS — real PostgreSQL", () => {
  it("advances exactly once for each protected certificate-facing mutation, but not unrelated maintenance", async () => {
    const revision = async () => (await state()).grading_revision;
    expect(await revision()).toBe(1);

    // The trigger operates on the actual row, so every protected category that
    // could alter the human-visible certificate invalidates a prepared review.
    await pool.query("UPDATE certificates SET centering_score = 8.5 WHERE id = 1");
    expect(await revision()).toBe(2);
    await pool.query("UPDATE certificates SET defects = '[{\"type\":\"scratch\"}]'::jsonb WHERE id = 1");
    expect(await revision()).toBe(3);
    await pool.query("UPDATE certificates SET auth_status = 'authentic_altered' WHERE id = 1");
    expect(await revision()).toBe(4);
    await pool.query("UPDATE certificates SET is_black_label = true WHERE id = 1");
    expect(await revision()).toBe(5);
    await pool.query("UPDATE certificates SET card_name = 'Changed identity' WHERE id = 1");
    expect(await revision()).toBe(6);

    // A timestamp-only maintenance write must not manufacture a stale review.
    await pool.query("UPDATE certificates SET updated_at = NOW() WHERE id = 1");
    expect(await revision()).toBe(6);
  });

  it("rejects Reviewer A's stale approval after Reviewer B changes 7 -> 6, with zero approval side effects", async () => {
    const reviewedRevision = (await state()).grading_revision;
    expect(reviewedRevision).toBe(1);

    // Reviewer B's one logical authoritative grading mutation advances the
    // database token once; A's prepared preview is therefore stale.
    const save = await pool.query(
      "UPDATE certificates SET grade = $1, updated_at = NOW() WHERE id = $2 AND grader_status = 'pending_review' RETURNING grading_revision",
      [6, 1]
    );
    expect(save.rows[0].grading_revision).toBe(2);

    expect(await approveAtRevision(1, reviewedRevision)).toBe(0);
    expect(await state()).toMatchObject({
      grade: "6.0",
      grading_revision: 2,
      grader_status: "pending_review",
      status: "pending",
      grade_approved_at: null,
      print_state: "awaiting_approval",
      nfc_written_at: null,
      claim_code_hash: null,
      partner_credit_settled: false,
    });
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(0);

    // A must visibly reprepare the current revision before this succeeds.
    expect(await approveAtRevision(1, 2)).toBe(1);
    expect(await state()).toMatchObject({
      grade: "6.0",
      grading_revision: 2,
      grader_status: "approved",
      status: "active",
      print_state: "needs_printing",
    });
  });

  it("allows exactly one winner when two reviewers concurrently approve the same prepared revision", async () => {
    const preparedRevision = (await state()).grading_revision;
    const [a, b] = await Promise.all([approveAtRevision(1, preparedRevision), approveAtRevision(1, preparedRevision)]);
    expect([a, b].sort()).toEqual([0, 1]);

    const final = await state();
    expect(final.grader_status).toBe("approved");
    expect(final.grade_approved_at).not.toBeNull();
    // Replaying the formerly-valid approval cannot create another transition.
    expect(await approveAtRevision(1, preparedRevision)).toBe(0);
  });
});
