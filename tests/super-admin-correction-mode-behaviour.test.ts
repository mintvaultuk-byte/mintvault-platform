/**
 * BEHAVIOURAL tests for Super Admin Correction Mode — real PostgreSQL, real transactions.
 *
 * These execute the actual applySuperAdminCorrection() implementation against a live local
 * throwaway database. Nothing about the transaction, the row lock, the optimistic-version
 * check or the audit insert is mocked or simulated.
 *
 * Only the CONNECTION is substituted (local DSN, ssl:false) — server/db.ts hardcodes
 * ssl:{rejectUnauthorized:false} for Neon, which a local Postgres refuses. The drizzle
 * instance handed to the code under test is a genuine node-postgres pool, so
 * db.transaction() is a genuine interactive transaction and FOR UPDATE genuinely locks.
 *
 * This file exists because the previous test suite mocked db.transaction with vi.fn(),
 * leaving the entire transactional path unexecuted while asserting on source text.
 *
 * Requires a local Postgres. Skips cleanly if CORRECTION_TEST_DATABASE_URL is unset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

const TEST_URL = process.env.CORRECTION_TEST_DATABASE_URL || "";

/** Fail-closed: refuse to run against anything that is not an obvious local throwaway. */
function assertLocalThrowaway(url: string): void {
  const parsed = new URL(url);
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  const throwawayName = parsed.pathname.includes("mintvault_correction_test");
  if (!localHost || !throwawayName) {
    throw new Error(
      `REFUSED: CORRECTION_TEST_DATABASE_URL must be a local mintvault_correction_test database, got ${parsed.hostname}${parsed.pathname}`
    );
  }
}

if (TEST_URL) assertLocalThrowaway(TEST_URL);

// Real drizzle over a real local pool. Only the DSN/ssl differ from production wiring.
vi.mock("../server/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pgmod = (await import("pg")).default;
  const pool = new pgmod.Pool({ connectionString: TEST_URL, ssl: false, max: 6 });
  return { db: drizzle(pool), pool };
});

// R2 is not exercised by applySuperAdminCorrection; stub the module so importing
// correction-mode.ts does not require R2 credentials.
vi.mock("../server/r2", () => ({ uploadToR2: vi.fn(async () => undefined), getR2SignedUrl: vi.fn(async () => "") }));

const describeDb = TEST_URL ? describe : describe.skip;

describeDb("Super Admin Correction Mode — real PostgreSQL behaviour", () => {
  let pool: pg.Pool;
  let applySuperAdminCorrection: typeof import("../server/correction-mode").applySuperAdminCorrection;

  const CERT_ID = 4242;

  beforeAll(async () => {
    ({ applySuperAdminCorrection } = await import("../server/correction-mode"));
    pool = new pg.Pool({ connectionString: TEST_URL, ssl: false, max: 4 });
    await pool.query(`DROP TABLE IF EXISTS certificates, audit_log`);
    await pool.query(`
      CREATE TABLE certificates (
        id integer PRIMARY KEY,
        certificate_number text,
        card_game text, set_name text, card_name text, card_number_display text,
        year_text text, language text, notes text,
        rarity text, rarity_other text, variant text, variant_other text,
        collection text, collection_code text, collection_other text,
        designations jsonb,
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
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS certificates, audit_log`);
    await pool.end();
  });

  /** Reset to a known approved cert with a deterministic integer grading token. */
  async function seed(): Promise<number> {
    await pool.query(`DELETE FROM audit_log`);
    await pool.query(`DELETE FROM certificates`);
    await pool.query(
      `INSERT INTO certificates (id, certificate_number, card_game, set_name, card_name,
         card_number_display, year_text, grade_type, grade, graded_by,
         ai_defect_candidates, grade_approved_at, updated_at)
       VALUES ($1,'MV-0000004242','Pokemon','Base Set','Charizard','7','1999','numeric',8.5,'grader-1',
         '[]'::jsonb, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour')`,
      [CERT_ID]
    );
    const r = await pool.query(`SELECT grading_version AS v FROM certificates WHERE id=$1`, [CERT_ID]);
    return Number(r.rows[0].v);
  }

  const baseMetadata = {
    cardGame: "Pokemon",
    setName: "Base Set",
    cardName: "Charizard",
    cardNumber: "7",
    year: "1999",
  };

  function input(version: number, metadata: Record<string, unknown> = {}, grading: Record<string, unknown> = {}) {
    return {
      certId: CERT_ID,
      actor: "mintvaultuk@gmail.com",
      expectedVersion: version,
      metadata: { ...baseMetadata, ...metadata },
      grading,
      images: {},
    };
  }

  beforeEach(async () => {
    await seed();
  });

  it("persists a correction and writes exactly one audit row inside the same transaction", async () => {
    const version = await seed();
    const result = await applySuperAdminCorrection(input(version, { cardName: "Charizard Corrected" }));

    expect(result.noChange).toBe(false);
    expect(result.changedFields).toContain("cardName");

    const cert = await pool.query(`SELECT card_name FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(cert.rows[0].card_name).toBe("Charizard Corrected");

    const audit = await pool.query(`SELECT action, admin_user, details FROM audit_log`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("cert_live_record_edit");
    expect(audit.rows[0].admin_user).toBe("mintvaultuk@gmail.com");
    expect(audit.rows[0].details.changes.cardName).toEqual({ before: "Charizard", after: "Charizard Corrected" });
  });

  it("rejects a stale expectedVersion with GRADING_VERSION_CONFLICT and leaves the row untouched", async () => {
    await seed();
    await expect(applySuperAdminCorrection(input(999, { cardName: "Should Not Persist" }))).rejects.toMatchObject({
      status: 409,
      code: "GRADING_VERSION_CONFLICT",
    });

    const cert = await pool.query(`SELECT card_name FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(cert.rows[0].card_name).toBe("Charizard");
    const audit = await pool.query(`SELECT id FROM audit_log`);
    expect(audit.rows).toHaveLength(0);
  });

  it("changes the correction token after every successful correction", async () => {
    const v1 = await seed();
    const first = await applySuperAdminCorrection(input(v1, { cardName: "First" }));
    expect(first.gradingVersion).toBe(v1 + 1);
    // The now-stale original token must be rejected.
    await expect(applySuperAdminCorrection(input(v1, { cardName: "Second" }))).rejects.toMatchObject({
      code: "GRADING_VERSION_CONFLICT",
    });
    // The fresh token is accepted.
    const second = await applySuperAdminCorrection(input(first.gradingVersion, { cardName: "Second" }));
    expect(second.noChange).toBe(false);
  });

  it("preserves writer A's grade when writer B submits a stale token", async () => {
    const version = await seed();
    await applySuperAdminCorrection(input(version, {}, { overall_grade: "7" }));
    await expect(applySuperAdminCorrection(input(version, {}, { overall_grade: "9" }))).rejects.toMatchObject({
      status: 409,
      code: "GRADING_VERSION_CONFLICT",
    });
    const cert = await pool.query(`SELECT grade FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(Number(cert.rows[0].grade)).toBe(7);
  });

  it("CONCURRENCY: two simultaneous corrections from the same version — exactly one wins", async () => {
    const version = await seed();

    const results = await Promise.allSettled([
      applySuperAdminCorrection(input(version, { cardName: "Writer A" })),
      applySuperAdminCorrection(input(version, { cardName: "Writer B" })),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "GRADING_VERSION_CONFLICT" });

    // Exactly one write, exactly one audit row — no lost update, no double-apply.
    const cert = await pool.query(`SELECT card_name FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(["Writer A", "Writer B"]).toContain(cert.rows[0].card_name);
    const audit = await pool.query(`SELECT id FROM audit_log`);
    expect(audit.rows).toHaveLength(1);
  });

  it("ROLLBACK: if the audit insert fails, the certificate update is rolled back entirely", async () => {
    const version = await seed();
    // Force the audit INSERT to fail inside the transaction, after the UPDATE has run.
    await pool.query(`ALTER TABLE audit_log ADD CONSTRAINT reject_all CHECK (false) NOT VALID`);
    try {
      await expect(applySuperAdminCorrection(input(version, { cardName: "Must Roll Back" }))).rejects.toBeTruthy();

      const cert = await pool.query(
        `SELECT card_name, grading_version AS v
                                     FROM certificates WHERE id=$1`,
        [CERT_ID]
      );
      // The live record must be untouched — no partial correction may survive.
      expect(cert.rows[0].card_name).toBe("Charizard");
      expect(Number(cert.rows[0].v)).toBe(version);
    } finally {
      await pool.query(`ALTER TABLE audit_log DROP CONSTRAINT reject_all`);
    }

    const audit = await pool.query(`SELECT id FROM audit_log`);
    expect(audit.rows).toHaveLength(0);
  });

  it("AUDIT TRUTHFULNESS: a mutated ai_defect_candidates is reported as changed, not silently dropped", async () => {
    const version = await seed();
    const result = await applySuperAdminCorrection(input(version, {}, { ai_defect_candidates: [{ type: "scratch" }] }));

    // The column really did change...
    const cert = await pool.query(`SELECT ai_defect_candidates FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(cert.rows[0].ai_defect_candidates).toEqual([{ type: "scratch" }]);

    // ...so the audit must say so. Previously this field was written but excluded from the
    // diff, letting an audit row claim changed_fields: [] while the row had been mutated.
    const audit = await pool.query(`SELECT details FROM audit_log`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details.changed_fields).toContain("aiDefectCandidates");
    // Recorded as a bounded shape summary, not a verbatim blob.
    expect(audit.rows[0].details.changes.aiDefectCandidates).toMatchObject({ summarized: true, after: "array(1)" });
    expect(result.changedFields).toContain("aiDefectCandidates");
  });

  it("does not silently drop a text correction that looks numeric (007 vs 7)", async () => {
    const version = await seed();
    const result = await applySuperAdminCorrection(input(version, { cardNumber: "007" }));

    // Number("007") === Number("7"), so an earlier revision classified this as a no-op,
    // returned success, wrote nothing and recorded no audit row.
    expect(result.noChange).toBe(false);
    const cert = await pool.query(`SELECT card_number_display FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(cert.rows[0].card_number_display).toBe("007");
    const audit = await pool.query(`SELECT details FROM audit_log`);
    expect(audit.rows[0].details.changes.cardNumber).toEqual({ before: "7", after: "007" });
  });

  it("still treats numeric-column reformatting (8.5 vs 8.50) as a genuine no-op", async () => {
    const version = await seed();
    const result = await applySuperAdminCorrection(input(version, {}, { overall_grade: "8.50" }));
    expect(result.noChange).toBe(true);
    const audit = await pool.query(`SELECT id FROM audit_log`);
    expect(audit.rows).toHaveLength(0);
  });

  it("writes no audit row and no update for a true no-op save", async () => {
    const version = await seed();
    const result = await applySuperAdminCorrection(input(version));
    expect(result.noChange).toBe(true);
    const audit = await pool.query(`SELECT id FROM audit_log`);
    expect(audit.rows).toHaveLength(0);
    const cert = await pool.query(`SELECT grading_version AS v FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(Number(cert.rows[0].v)).toBe(version);
  });

  it("cannot reassign the certificate number or other immutable identifiers via the body", async () => {
    const version = await seed();
    await applySuperAdminCorrection(
      input(version, {
        certificateNumber: "MV-0000009999",
        certificate_number: "MV-0000009999",
        id: 1,
        graded_by: "attacker",
        grade_approved_at: "2000-01-01",
        cardName: "Charizard Corrected",
      })
    );
    const cert = await pool.query(`SELECT certificate_number, id, graded_by FROM certificates WHERE id=$1`, [CERT_ID]);
    expect(cert.rows[0].certificate_number).toBe("MV-0000004242");
    expect(Number(cert.rows[0].id)).toBe(CERT_ID);
    expect(cert.rows[0].graded_by).toBe("grader-1");
  });

  it("refuses to correct an unapproved certificate", async () => {
    const version = await seed();
    await pool.query(`UPDATE certificates SET grade_approved_at = NULL WHERE id=$1`, [CERT_ID]);
    await expect(applySuperAdminCorrection(input(version, { cardName: "Nope" }))).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses to correct a soft-deleted certificate", async () => {
    const version = await seed();
    await pool.query(`UPDATE certificates SET deleted_at = NOW() WHERE id=$1`, [CERT_ID]);
    await expect(applySuperAdminCorrection(input(version, { cardName: "Nope" }))).rejects.toMatchObject({
      status: 404,
    });
  });
});
