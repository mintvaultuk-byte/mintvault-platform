/**
 * partner-review-clock.test.ts — BLOCKER B1, proven behaviourally.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 * PARTNER_QUALITY_V2 fixed the rating DENOMINATOR: a unit that entered review stays in the
 * population whether or not it was ever approved, so abandoning your worst work no longer raises
 * your score. It did not fix the CLOCK. The rolling 180-day window positioned each unit with
 *
 *     COALESCE(grade_approved_at, graded_at, status_updated_at, issued_at)
 *
 * and for the exact unit V2 exists to keep — reviewed, returned, abandoned — all three of the
 * first options are NULL:
 *
 *   grade_approved_at   NULL by definition; the unit was never approved.
 *   graded_at           server/grader.ts's rejection CAS sets it to NULL. Returning a card
 *                       DELETES the only grading timestamp it had.
 *   status_updated_at   written by exactly one route (shipping status), never by grading.
 *
 * So the clock fell through to `issued_at` — the moment the certificate row was created at
 * connector import. That is an INTAKE date, and the gap between intake and review is entirely
 * under the partner's control.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY ─────────────────────────────────────────────────────────
 * server/partner/public-network-service.ts names this file in a comment as the reproduction of
 * the exploit. A comment that names a test which does not exist is worse than no comment: it
 * asserts a proof that nobody can run. This file is that proof.
 *
 * Everything here executes against a REAL disposable PostgreSQL 17 cluster with the full migration
 * chain applied, and drives the REAL measurement function. Nothing re-implements the window
 * arithmetic in TypeScript — a test that restates the SQL proves only that two copies agree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  provisionRealisticRoles,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  migratorUrlFrom,
  applyEveryMigrationRealistic,
  pinAccountingTopologyTo,
} from "./helpers/partner-realistic-db";

let cluster: DisposablePostgres17;
let admin: Client;
let svc: typeof import("../server/partner/public-network-service");

const TENANT = "aaaa0000-0000-0000-0000-0000000000c1";

/**
 * One physical grading unit, with FULL control of the two timestamps that matter.
 *
 * `issuedAtDaysAgo` is the connector import date — the thing the old clock keyed on and the thing
 * a partner controls. `reviewEnteredDaysAgo` is the durable review clock 0063 added. Being able to
 * set them INDEPENDENTLY is the whole experiment: the exploit is precisely the case where they
 * disagree.
 */
async function insertUnit(
  locationId: string,
  opts: {
    issuedAtDaysAgo: number;
    reviewEnteredDaysAgo?: number | null;
    approvedDaysAgo?: number | null;
    redoCount?: number;
    grade?: number | null;
  },
): Promise<number> {
  const { issuedAtDaysAgo, reviewEnteredDaysAgo = null, approvedDaysAgo = null, redoCount = 0, grade = 9.0 } = opts;
  const r = await admin.query<{ id: number }>(
    `INSERT INTO certificates
       (certificate_number, status, grade, grade_approved_at, deleted_at,
        origin_type, origin_partner_id, origin_partner_legal_name, origin_location_id,
        origin_captured_at, origin_snapshot_version, redo_count,
        issued_at, review_entered_at, graded_at)
     VALUES ($1, 'active', $2,
             CASE WHEN $3::numeric IS NULL THEN NULL ELSE now() - ($3 || ' days')::interval END,
             NULL, 'PARTNER', $4, 'Tenant C', $5, now(), 1, $6,
             now() - ($7 || ' days')::interval,
             CASE WHEN $8::numeric IS NULL THEN NULL ELSE now() - ($8 || ' days')::interval END,
             -- graded_at is deliberately NULL on every abandoned unit, exactly as the real
             -- rejection CAS leaves it. Setting it here would hide the defect being tested.
             NULL)
     RETURNING id`,
    [
      `MV-${Math.floor(Math.random() * 1e9)}`,
      grade,
      approvedDaysAgo,
      TENANT,
      locationId,
      redoCount,
      String(issuedAtDaysAgo),
      reviewEnteredDaysAgo,
    ],
  );
  return r.rows[0].id;
}

async function seedLocation(name: string): Promise<string> {
  const loc = await admin.query<{ id: string }>(
    "INSERT INTO partner_locations (tenant_id, partner_id, name, status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
    [TENANT, name],
  );
  return loc.rows[0].id;
}

describe("PARTNER_QUALITY_V2 review clock — B1 (disposable PostgreSQL 17)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("review-clock");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    // Same realistic estate as partner-public-network-behavioural: real roles, the real
    // certificates table, and the full migration chain applied as the NON-SUPERUSER migrator.
    // Deliberately not a hand-rolled subset — the point of this suite is that the review clock
    // works on the schema the migrations actually produce.
    await provisionRealisticRoles(admin);
    await createMintvaultCertificatesTable(admin);
    await admin.query("CREATE TABLE IF NOT EXISTS users (id varchar primary key, email varchar unique)");
    await admin.query(`CREATE TABLE IF NOT EXISTS submissions (
      id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
      tracking_number text unique, deleted_at timestamptz, grading_status varchar(30),
      assigned_grader_id varchar, scan_status varchar(30), scan_assigned_to varchar,
      shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
      return_tracking text, return_carrier text, return_service text,
      status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now())`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)",
    );
    await createMintvaultLabelPrintsTable(admin);
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial primary key, entity_type text not null, entity_id text not null, action text not null,
      admin_user text, details jsonb, created_at timestamptz not null default now())`);
    for (const t of ["users", "submissions", "submission_items", "label_prints", "audit_log", "certificates"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }
    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      await applyEveryMigrationRealistic(migrator);
    } finally {
      await migrator.end();
    }
    // NOTE what is NOT here: no `ALTER TABLE certificates ADD COLUMN review_entered_at`. The whole
    // point of migration 0063 is that the column arrives through the migration chain. A fixture
    // that added it would prove only that the fixture works.
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade numeric(4,1)");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS redo_count integer NOT NULL DEFAULT 0");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS graded_at timestamptz");

    await admin.query("INSERT INTO partner_organisations (id, legal_name, status) VALUES ($1,'Tenant C','ACTIVE')", [
      TENANT,
    ]);
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    process.env.PARTNER_PUBLIC_DATABASE_URL = cluster.url;
    pinAccountingTopologyTo(cluster.url);
    svc = await import("../server/partner/public-network-service");
  }, 300_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop?.();
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — the exploit itself
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it("B1: a unit imported 200 days ago but REVIEWED today stays in the 180-day population", async () => {
    const loc = await seedLocation("Late Reviewer");
    // Twelve units the shop wants counted: imported long ago, reviewed and approved recently.
    for (let i = 0; i < 12; i++) {
      await insertUnit(loc, { issuedAtDaysAgo: 200, approvedDaysAgo: 5, reviewEnteredDaysAgo: 5, redoCount: 0 });
    }
    // Eight units it does not: imported in the same batch 200 days ago, bounced and ABANDONED —
    // but the bounce happened 5 days ago. Under the old clock every one of these was dated from
    // import, fell outside the window, and vanished from the denominator.
    for (let i = 0; i < 8; i++) {
      await insertUnit(loc, {
        issuedAtDaysAgo: 200,
        approvedDaysAgo: null,
        reviewEnteredDaysAgo: 5,
        redoCount: 2,
        grade: null,
      });
    }

    const evidence = await svc.measureEvidence(loc);

    // The window supplied the population — not the all-time fallback. If this were null the test
    // would be passing for the wrong reason (the fallback also counts everything).
    expect(evidence.windowDays, "the rolling window must have supplied the population").toBe(180);
    expect(evidence.sampleSize, "all 20 reviewed units must be inside the window").toBe(20);

    const firstPass = evidence.metrics.find((m) => m.metric === "first_pass_approval_rate");
    expect(firstPass?.available).toBe(true);
    // 12 of 20 first-pass. Under the defect the 8 abandoned units aged out and this read 12/12.
    expect(firstPass?.rawValue).toBeCloseTo(12 / 20, 6);

    const abandoned = evidence.metrics.find((m) => m.metric === "abandoned_unit_rate");
    expect(abandoned?.rawValue, "the abandoned units must still be visible as evidence").toBeCloseTo(8 / 20, 6);
  }, 60_000);

  it("B1 control: the SAME units dated only from import DO age out — the window really is 180 days", async () => {
    // NON-VACUITY. If the window did not exclude anything, scenario 1 would pass no matter what the
    // clock did. Here nothing was ever reviewed recently: import 200 days ago, review 200 days ago.
    const loc = await seedLocation("Genuinely Dormant");
    for (let i = 0; i < 12; i++) {
      await insertUnit(loc, { issuedAtDaysAgo: 200, approvedDaysAgo: 200, reviewEnteredDaysAgo: 200 });
    }
    const evidence = await svc.measureEvidence(loc);
    // Zero fell inside the window, so the engine fell back to all-time rather than publishing a
    // rating built on nothing. windowDays === null IS the fallback signal.
    expect(evidence.windowDays, "a genuinely dormant shop must fall back to all-time").toBeNull();
    expect(evidence.sampleSize).toBe(12);
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — delaying submission must not expire bad evidence early
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it("B1: delaying submission by 6 months does NOT let poor review evidence expire early", async () => {
    const loc = await seedLocation("Sandbagger");
    // The gaming attempt: the shop holds a batch for 179 days before submitting anything, so that
    // by the time HQ bounces the bad ones, import is nearly out of window. It then abandons them.
    for (let i = 0; i < 6; i++) {
      await insertUnit(loc, { issuedAtDaysAgo: 179, approvedDaysAgo: 1, reviewEnteredDaysAgo: 1 });
    }
    for (let i = 0; i < 6; i++) {
      await insertUnit(loc, { issuedAtDaysAgo: 179, reviewEnteredDaysAgo: 1, redoCount: 3, grade: null });
    }

    const before = await svc.measureEvidence(loc);
    expect(before.sampleSize).toBe(12);
    expect(before.metrics.find((m) => m.metric === "first_pass_approval_rate")?.rawValue).toBeCloseTo(0.5, 6);

    // Now push every IMPORT date past the boundary, changing nothing about the review. Under the
    // old clock this single UPDATE would have wiped the bad half out of the population. Under the
    // review clock it must change nothing at all — which is the entire anti-gaming property.
    await admin.query(
      "UPDATE certificates SET issued_at = now() - interval '400 days' WHERE origin_location_id = $1",
      [loc],
    );

    const after = await svc.measureEvidence(loc);
    expect(after.windowDays, "review-dated units must stay in the window whatever import says").toBe(180);
    expect(after.sampleSize, "moving the IMPORT date must not change the population").toBe(12);
    expect(after.metrics.find((m) => m.metric === "first_pass_approval_rate")?.rawValue).toBeCloseTo(0.5, 6);
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — approved and abandoned units use comparable review-age semantics
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it("B1: an approved unit and an abandoned unit reviewed on the SAME day are treated the same", async () => {
    const locA = await seedLocation("Comparable Approved");
    const locB = await seedLocation("Comparable Abandoned");
    // Identical in every respect except outcome, and reviewed 90 days ago — comfortably inside the
    // window by review date, comfortably OUTSIDE it by import date.
    for (let i = 0; i < 10; i++) {
      await insertUnit(locA, { issuedAtDaysAgo: 300, approvedDaysAgo: 90, reviewEnteredDaysAgo: 90 });
      await insertUnit(locB, { issuedAtDaysAgo: 300, reviewEnteredDaysAgo: 90, redoCount: 1, grade: null });
    }

    const a = await svc.measureEvidence(locA);
    const b = await svc.measureEvidence(locB);

    // Both populations must be measured the same way. The old clock kept the approved side (it has
    // grade_approved_at) and dropped the abandoned side (it did not), so the two were incomparable
    // by construction — which is exactly how abandonment paid.
    expect(a.windowDays, "approved units are inside the window by review date").toBe(180);
    expect(b.windowDays, "abandoned units must be inside the window by the SAME rule").toBe(180);
    expect(a.sampleSize).toBe(10);
    expect(b.sampleSize).toBe(10);
    // And the outcome difference shows up where it should — in the score, not in the denominator.
    expect(a.metrics.find((m) => m.metric === "first_pass_approval_rate")?.rawValue).toBeCloseTo(1, 6);
    expect(b.metrics.find((m) => m.metric === "first_pass_approval_rate")?.rawValue).toBeCloseTo(0, 6);
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 — the clock survives the return/resubmit cycle, and takes the LATEST event
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it("B1: GREATEST(approval, review entry) — a later approval wins, an earlier bounce does not shrink it", async () => {
    const loc = await seedLocation("Bounced Then Approved");
    // Bounced 300 days ago, finally approved 10 days ago. The unit is RECENT work by its latest
    // review event. COALESCE(grade_approved_at, ...) would also get this right; GREATEST is what
    // makes it right in BOTH orders, which the next assertion covers.
    for (let i = 0; i < 10; i++) {
      await insertUnit(loc, { issuedAtDaysAgo: 400, approvedDaysAgo: 10, reviewEnteredDaysAgo: 300, redoCount: 1 });
    }
    const e = await svc.measureEvidence(loc);
    expect(e.windowDays).toBe(180);
    expect(e.sampleSize).toBe(10);
  }, 60_000);

  it("B1: a unit approved long ago but RE-ENTERED review recently is counted as recent", async () => {
    // The order the other way round: approval is old, the review re-entry is new. COALESCE would
    // take grade_approved_at and date this unit 300 days ago, dropping recent rework out of the
    // window. GREATEST takes the later of the two, which is the direction that costs the shop.
    const loc = await seedLocation("Reopened");
    for (let i = 0; i < 10; i++) {
      await insertUnit(loc, { issuedAtDaysAgo: 400, approvedDaysAgo: 300, reviewEnteredDaysAgo: 3, redoCount: 2 });
    }
    const e = await svc.measureEvidence(loc);
    expect(e.windowDays, "the LATEST review event must position the unit").toBe(180);
    expect(e.sampleSize).toBe(10);
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // The clock feeds the reconciler's clock-driven eligibility (H6), so it must come back out
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it("measureEvidence reports the oldest included unit, so the window boundary can be scheduled", async () => {
    const loc = await seedLocation("Boundary");
    for (let i = 0; i < 10; i++) {
      await insertUnit(loc, { issuedAtDaysAgo: 400, approvedDaysAgo: 100 + i, reviewEnteredDaysAgo: 100 + i });
    }
    const e = await svc.measureEvidence(loc);
    expect(e.oldestEvidenceInWindow, "the boundary must be reported, not inferred").toBeTruthy();
    const ageDays = (Date.now() - Date.parse(e.oldestEvidenceInWindow as string)) / 86_400_000;
    // The oldest of the ten is 109 days old. Loose bounds so this cannot fail on clock skew.
    expect(ageDays).toBeGreaterThan(105);
    expect(ageDays).toBeLessThan(115);
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // The column is HQ evidence. A partner that could write it could hold its own work in or out.
  // ═════════════════════════════════════════════════════════════════════════════════════════

  it("neither partner role may write review_entered_at, and the public reader may not read it", async () => {
    const { rows } = await admin.query<{ role: string; can: boolean }>(
      `SELECT r.rolname AS role,
              has_column_privilege(r.rolname, 'public.certificates', 'review_entered_at', 'UPDATE') AS can
         FROM pg_roles r
        WHERE r.rolname IN ('partner_runtime','partner_connector_runtime')`,
    );
    expect(rows.length, "the partner roles must exist in this estate").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.can, `${r.role} can move its own review clock`).toBe(false);
    }
    const reader = await admin.query<{ can: boolean }>(
      `SELECT has_column_privilege('partner_public_reader', 'public.certificates', 'review_entered_at', 'SELECT') AS can`,
    );
    // A visitor able to read this could infer which of a shop's cards were bounced.
    expect(reader.rows[0].can, "the anonymous reader can see the review clock").toBe(false);
  }, 60_000);
});
