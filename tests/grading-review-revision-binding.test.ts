/**
 * Review revision / evidence revision proof (Phase 4).
 *
 * This suite runs the actual review writer over a disposable PostgreSQL 17 cluster.  It does not
 * copy the approval SQL: `approveGraderCert`, `adminReviewSaveDraft` and `approveCertGrade` are
 * imported from server/grader.ts after the local database is provisioned.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { alignCertificatesTableToSchema, createMintvaultCertificatesTable } from "./helpers/partner-realistic-db";
import { setupPartnerTestStorage, type PartnerTestStorage } from "./helpers/partner-test-storage";

const runtime = vi.hoisted(() => ({
  getCertificate: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("../server/storage", () => ({ storage: runtime }));

let cluster: DisposablePostgres17;
let admin: Client;
let reviewer: typeof import("../server/grader");
let scanner: typeof import("../server/scan-ingest-service");
let storage: PartnerTestStorage;
let closePool: (() => Promise<void>) | undefined;
let nextId = 0;

const REVIEWED_CERT = {
  gradeType: "numeric",
  gradeOverall: "9.0",
  gradeCentering: "9.0",
  gradeCorners: "9.0",
  gradeEdges: "9.0",
  gradeSurface: "9.0",
  cardName: "Revision Proof Card",
  language: "English",
};

const migration = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

beforeAll(async () => {
  cluster = await startPostgres17("grading-review-revision-binding");
  admin = new Client({ connectionString: cluster.url });
  await admin.connect();
  await createMintvaultCertificatesTable(admin);
  await alignCertificatesTableToSchema(admin);
  await admin.query(
    "CREATE TABLE audit_log (id serial primary key, entity_type text, entity_id text, action text, admin_user text, details jsonb, created_at timestamptz not null default now())"
  );
  // 0067 correctly revokes the restricted Partner role even though this focused HQ-review
  // fixture does not mount the portal.  Model the role so the real migration can execute its
  // privilege assertions rather than being weakened for the test.
  await admin.query("CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS");

  // Exercise the shipped migration files, including the immutable ledger they are designed to
  // bind.  No application credential or non-local database is involved.
  await admin.query(migration("0067_certificate_immutable_evidence_ledger.sql"));
  await admin.query(migration("0071_certificate_review_revision_binding.sql"));

  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  // This helper reads only the dedicated disposable proof variables, configures the application's
  // R2 client for an isolated MinIO bucket, and cleans only its own keys after the test.
  storage = await setupPartnerTestStorage({ bucketSuffix: "reviewrev" });
  storage.trackPrefix("evidence/masters/");
  reviewer = await import("../server/grader");
  scanner = await import("../server/scan-ingest-service");
  const dbModule = await import("../server/db");
  closePool = () => dbModule.pool.end();
}, 180_000);

afterAll(async () => {
  await storage?.cleanup().catch(() => {});
  await closePool?.();
  await admin?.end();
  await cluster?.stop();
});

beforeEach(() => {
  runtime.getCertificate.mockReset();
  runtime.writeAuditLog.mockReset();
  runtime.getCertificate.mockResolvedValue({ ...REVIEWED_CERT });
});

async function seedPendingReview(): Promise<number> {
  nextId += 1;
  const row = await admin.query<{ id: number }>(
    `INSERT INTO certificates (
       cert_id, status, grade_type, card_name, grader_status, print_state,
       grade, centering_score, corners_score, edges_score, surface_score,
       grading_revision, evidence_revision, review_grading_revision, review_evidence_revision
     ) VALUES ($1, 'pending', 'numeric', 'Revision Proof Card', 'pending_review', 'awaiting_approval',
               9, 9, 9, 9, 9, 1, 1, 1, 1)
     RETURNING id`,
    [`MV-REV-${nextId}`]
  );
  return row.rows[0].id;
}

async function row(id: number) {
  return (
    await admin.query<{
      grader_status: string;
      status: string;
      grade_approved_at: Date | null;
      grading_revision: number;
      evidence_revision: number;
      review_grading_revision: number | null;
      review_evidence_revision: number | null;
      approved_grading_revision: number | null;
      approved_evidence_revision: number | null;
    }>(
      `SELECT grader_status, status, grade_approved_at, grading_revision, evidence_revision,
              review_grading_revision, review_evidence_revision,
              approved_grading_revision, approved_evidence_revision
         FROM certificates WHERE id=$1`,
      [id]
    )
  ).rows[0];
}

async function appendEvidenceRevision(id: number): Promise<void> {
  // The immutable master is deliberately appended, never overwritten.  The following bounded
  // update is the same certificate-row mutation scanner ingestion performs after a new master
  // has been accepted, including its unapproved guard.
  const hash = `${id}`.padStart(64, "a").slice(-64);
  await admin.query("BEGIN");
  try {
    await admin.query(
      `INSERT INTO certificate_image_masters
         (certificate_id, side, object_key, sha256, byte_length, format, mime_type,
          pixel_width, pixel_height, evidence_version, revision, actor)
       VALUES ($1, 'front', $2, $3, 64, 'tiff', 'image/tiff', 10, 10, 1, 1, 'scanner')`,
      [id, `evidence/masters/${id}/front/${hash}.tif`, hash]
    );
    const advanced = await admin.query(
      "UPDATE certificates SET evidence_revision=evidence_revision+1 WHERE id=$1 AND grade_approved_at IS NULL",
      [id]
    );
    expect(advanced.rowCount, "an unapproved evidence append must advance the review-visible revision").toBe(1);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function seedUnapprovedScannerCert(): Promise<number> {
  nextId += 1;
  const inserted = await admin.query<{ id: number }>(
    `INSERT INTO certificates (cert_id, status, grade_type, card_name, grader_status, print_state)
     VALUES ($1, 'pending', 'numeric', 'Scanner Revision Proof', 'assigned', 'awaiting_approval')
     RETURNING id`,
    [`MV-SCAN-REV-${nextId}`]
  );
  return inserted.rows[0].id;
}

describe("review approval binds the exact grade and evidence revisions", () => {
  it("advances the certificate evidence revision only for a new scanner master, while an approved retry stays idempotent", async () => {
    const id = await seedUnapprovedScannerCert();
    const master = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#102030" } })
      .tiff()
      .withMetadata({ density: 900 })
      .toBuffer();

    await scanner.uploadRawScansToR2(id, { buffer: master, mimeType: "image/tiff", ext: "tif" }, null);
    expect(await row(id)).toMatchObject({ evidence_revision: 1 });
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM certificate_image_masters WHERE certificate_id=$1", [id]))
        .rows[0].n
    ).toBe(1);

    // A scanner retry has the same content-addressed object key. It cannot create a second master
    // or advance the review-visible revision, even after this card has been approved.
    await admin.query("UPDATE certificates SET grade_approved_at=NOW() WHERE id=$1", [id]);
    await scanner.uploadRawScansToR2(id, { buffer: master, mimeType: "image/tiff", ext: "tif" }, null);
    expect(await row(id)).toMatchObject({ evidence_revision: 1 });
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM certificate_image_masters WHERE certificate_id=$1", [id]))
        .rows[0].n
    ).toBe(1);
  });

  it("rejects stale approval after an immutable master append and leaves the grade unpublished", async () => {
    const id = await seedPendingReview();
    await appendEvidenceRevision(id);

    const result = await reviewer.approveGraderCert(id, "reviewer@example.test");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result).toMatchObject({ error: expect.stringMatching(/changed after this review was prepared/i) });

    expect(await row(id)).toMatchObject({
      grader_status: "pending_review",
      status: "pending",
      grade_approved_at: null,
      evidence_revision: 2,
      review_evidence_revision: 1,
    });
  });

  it("an admin re-review snapshots the current revisions, then the real approval CAS records them", async () => {
    const id = await seedPendingReview();
    await appendEvidenceRevision(id);

    const saved = await reviewer.adminReviewSaveDraft(
      id,
      { overall_grade: "9", grade_centering: "9", grade_corners: "9", grade_edges: "9", grade_surface: "9" },
      "reviewer@example.test"
    );
    expect(saved).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({
      grading_revision: 2,
      evidence_revision: 2,
      review_grading_revision: 2,
      review_evidence_revision: 2,
    });

    expect(await reviewer.approveGraderCert(id, "reviewer@example.test")).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({
      grader_status: "approved",
      status: "active",
      approved_grading_revision: 2,
      approved_evidence_revision: 2,
    });
  });

  it("concurrent approval and evidence append have exactly one valid winner", async () => {
    const id = await seedPendingReview();
    const reviewed = {
      gradingRevision: 1,
      evidenceRevision: 1,
      reviewGradingRevision: 1,
      reviewEvidenceRevision: 1,
    };

    // Both writers use a predicate on the same certificate row.  The test races the production
    // approval function against scanner ingestion's final revision advance; whichever locks first
    // leaves a self-consistent terminal state, never an approval bound to changed evidence.
    const [approved, evidence] = await Promise.all([
      reviewer.approveCertGrade(id, "reviewer@example.test", reviewed),
      admin.query(
        "UPDATE certificates SET evidence_revision=evidence_revision+1 WHERE id=$1 AND grade_approved_at IS NULL",
        [id]
      ),
    ]);

    const after = await row(id);
    const approvalWon = approved && evidence.rowCount === 0;
    const evidenceWon = !approved && evidence.rowCount === 1;
    expect(approvalWon || evidenceWon, "one CAS must win and the other must observe that committed state").toBe(true);
    if (approvalWon) {
      expect(after).toMatchObject({
        grader_status: "approved",
        status: "active",
        evidence_revision: 1,
        approved_evidence_revision: 1,
      });
    } else {
      expect(after).toMatchObject({
        grader_status: "pending_review",
        status: "pending",
        grade_approved_at: null,
        evidence_revision: 2,
        review_evidence_revision: 1,
      });
    }
  });
});
