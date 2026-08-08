/**
 * Partner Public Network — BEHAVIOURAL proof of the rating evidence path, on a real PostgreSQL 17.
 *
 * WHY THIS SUITE EXISTS. Before it, the rating had two kinds of coverage and neither could catch a
 * denominator defect:
 *
 *   - tests/partner-public-network-rating.test.ts tests the ARITHMETIC with hand-supplied
 *     `RatingCounters`. It never calls `measureEvidence`, so the SQL that produces those counters
 *     — the entire denominator — had zero test callers.
 *   - tests/partner-public-network-migration.test.ts:231-263 runs a RE-TYPED copy of that SQL
 *     against an EMPTY `certificates` table and asserts `resolves.toBeTruthy()` / `approved === "0"`.
 *     Both assertions hold for any predicate, including `WHERE false`. Dropping
 *     `AND status = 'active'` or `AND deleted_at IS NULL` from PUBLIC_CARD_PREDICATE leaves the
 *     whole repository green.
 *
 * So this suite inserts REAL rows and calls the REAL exported functions — `measureEvidence`,
 * `recalculateRating`, `getShopProfile` — against a real database. Every assertion below fails if
 * the shipped predicate changes, which is the property the mutation matrix needs and did not have.
 *
 * It uses its own disposable PostgreSQL 17 cluster (startPostgres17), so it needs no env var and
 * CANNOT skip silently — the helper throws rather than skipping when no PG17 is available.
 *
 * NOTE ON THE MODULE IMPORT. `server/partner/db.ts` resolves its pool URLs lazily on first query,
 * and `partnerAdminQuery` asserts that the partner URLs and MINTVAULT_DATABASE_URL name the same
 * database. Both are pinned to this cluster in beforeAll BEFORE the service module is imported, so
 * the import is dynamic rather than top-level.
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

/** The live service module, imported after the pool URLs are pinned. */
let svc: typeof import("../server/partner/public-network-service");

const T_A = "aaaa0000-0000-0000-0000-0000000000b1";

/**
 * Insert one certificate representing one physical grading unit.
 *
 * Defaults describe an APPROVED, PUBLISHED, first-pass card — the shape that counts today. Each
 * test overrides exactly the field whose effect it is proving, so a failure names the property.
 */
async function insertCert(
  locationId: string,
  opts: {
    redoCount?: number;
    approved?: boolean;
    status?: string;
    deletedAt?: string | null;
    grade?: number | null;
    originType?: string;
    certNumber?: string;
    approvedAt?: string;
  } = {},
): Promise<number> {
  const {
    redoCount = 0,
    approved = true,
    status = "active",
    deletedAt = null,
    grade = 9.0,
    originType = "PARTNER",
    approvedAt = "now()",
  } = opts;
  // Migration 0035 constrains the origin snapshot as a unit, and the constraints are the real
  // production contract: PARTNER origin REQUIRES origin_partner_id, a non-blank partner name,
  // origin_captured_at and origin_snapshot_version; any non-PARTNER origin must leave every
  // partner/location column NULL (chk_certificates_origin_non_partner_clean). Honouring that here
  // is what makes these rows representative rather than convenient.
  const isPartner = originType === "PARTNER";
  const r = await admin.query<{ id: number }>(
    `INSERT INTO certificates
       (certificate_number, status, grade, grade_approved_at, deleted_at,
        origin_type, origin_partner_id, origin_partner_legal_name, origin_location_id,
        origin_captured_at, origin_snapshot_version, redo_count)
     VALUES ($1, $2, $3, ${approved ? approvedAt : "NULL"}, $4, $5, $6, $7, $8, now(), 1, $9)
     RETURNING id`,
    [
      opts.certNumber ?? `MV-${Math.floor(Math.random() * 1e9)}`,
      status,
      grade,
      deletedAt,
      originType,
      isPartner ? T_A : null,
      isPartner ? "Tenant A" : null,
      isPartner ? locationId : null,
      redoCount,
    ],
  );
  return r.rows[0].id;
}

async function seedListing(tenantId: string, name: string, slug: string): Promise<{ listingId: string; locationId: string }> {
  const loc = await admin.query<{ id: string }>(
    "INSERT INTO partner_locations (tenant_id, partner_id, name) VALUES ($1,$1,$2) RETURNING id",
    [tenantId, name],
  );
  const locationId = loc.rows[0].id;
  const ins = await admin.query<{ id: string }>(
    `INSERT INTO partner_public_listings (tenant_id, location_id, slug, public_display_name, listing_status)
     VALUES ($1,$2,$3,$4,'DRAFT') RETURNING id`,
    [tenantId, locationId, slug, name],
  );
  const listingId = ins.rows[0].id;
  // Walk the legal transition path; the ENABLE ALWAYS trigger refuses shortcuts.
  await admin.query("UPDATE partner_public_listings SET listing_status='PENDING_REVIEW' WHERE id=$1", [listingId]);
  await admin.query(
    `UPDATE partner_public_listings
        SET listing_status='ACTIVE', approved_at=now(), approved_by='hq@test', public_since=now()
      WHERE id=$1`,
    [listingId],
  );
  return { listingId, locationId };
}

/**
 * Build the minimum real FK chain a `partner_grading_work_items` row requires, and return the
 * partner submission id plus a setter for the work item's status.
 *
 * Direct inserts rather than the real submit route: the guard under test reads exactly one table,
 * and driving submit would drag in MinIO and the wallet without making the proof stronger. Every
 * NOT NULL FK in 0049's chain is still satisfied by a genuine row, so the query is exercised
 * against the real schema — which is the part that catches a wrong column name.
 */
async function seedWorkItem(
  locationId: string,
  status: string,
  tag: string,
): Promise<{ partnerSubmissionId: string }> {
  const u = await admin.query<{ id: string }>(
    `INSERT INTO partner_users (tenant_id, partner_id, email, status, password_hash)
     VALUES ($1,$1,$2,'ACTIVE','x') RETURNING id`,
    [T_A, `cancel-${tag}@test.local`],
  );
  const userId = u.rows[0].id;
  const ps = await admin.query<{ id: string }>(
    `INSERT INTO partner_submissions (tenant_id, location_id, created_by, status)
     VALUES ($1,$2,$3,'submitted_to_mintvault') RETURNING id`,
    [T_A, locationId, userId],
  );
  const partnerSubmissionId = ps.rows[0].id;
  const card = await admin.query<{ id: string }>(
    `INSERT INTO partner_submission_cards
       (tenant_id, submission_id, sequence_number, card_name, quantity, front_image_key, back_image_key)
     VALUES ($1,$2,1,'Cancel Card',1,$3,$4) RETURNING id`,
    [T_A, partnerSubmissionId, `f/${tag}.jpg`, `b/${tag}.jpg`],
  );
  const ho = await admin.query<{ id: string }>(
    `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot)
     VALUES ($1,$2,'applied','{}'::jsonb) RETURNING id`,
    [T_A, partnerSubmissionId],
  );
  const cr = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records (tenant_id, partner_submission_id, handoff_id, state, attempt_count)
     VALUES ($1,$2,$3,'imported',1) RETURNING id`,
    [T_A, partnerSubmissionId, ho.rows[0].id],
  );
  const vr = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_validation_runs
       (connector_record_id, validation_attempt, source_submission_version, source_handoff_status,
        source_fingerprint, source_fingerprint_version, outcome, blocking_error_count, warning_count, completed_at)
     VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
    [cr.rows[0].id, "a".repeat(64)],
  );
  const dest = await admin.query<{ id: number }>(
    `INSERT INTO submissions (user_id, tracking_number, status) VALUES ('cancel-owner',$1,'draft') RETURNING id`,
    [`MV-CANCEL-${tag}`],
  );
  const imp = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_imports
       (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id,
        partner_handoff_id, validation_run_id, source_fingerprint, source_fingerprint_version,
        mapping_version, import_attempt, state, destination_submission_id, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'completed',$8, now()) RETURNING id`,
    [cr.rows[0].id, T_A, locationId, partnerSubmissionId, ho.rows[0].id, vr.rows[0].id, "a".repeat(64), dest.rows[0].id],
  );
  const item = await admin.query<{ id: number }>(
    "INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id",
    [dest.rows[0].id],
  );
  await admin.query(
    `INSERT INTO partner_grading_work_items
       (tenant_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_submission_card_id,
        partner_handoff_id, connector_import_id, connector_record_id, validation_run_id,
        destination_submission_id, submission_item_id, card_ordinal, status, front_image_key, back_image_key)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13)`,
    [
      T_A,
      locationId,
      partnerSubmissionId,
      card.rows[0].id,
      ho.rows[0].id,
      imp.rows[0].id,
      cr.rows[0].id,
      vr.rows[0].id,
      dest.rows[0].id,
      item.rows[0].id,
      status,
      // 0049 constrains both keys to encode tenant/submission/card, so a work item can never point
      // at another tenant's object. Built from the real ids rather than a placeholder.
      `partner-submissions/${T_A}/${partnerSubmissionId}/${card.rows[0].id}/front-${tag}.jpg`,
      `partner-submissions/${T_A}/${partnerSubmissionId}/${card.rows[0].id}/back-${tag}.jpg`,
    ],
  );
  return { partnerSubmissionId };
}

describe("Partner public network — behavioural rating evidence (disposable PostgreSQL 17)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-public-network-behavioural");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();

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

    // The shared stub omits `grade` and `redo_count`; both exist on the real table, and the entire
    // rating rests on redo_count. Added after the migrations so 0058's index build sees them.
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade numeric(4,1)");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS redo_count integer NOT NULL DEFAULT 0");

    await admin.query("INSERT INTO partner_organisations (id, legal_name) VALUES ($1,'Tenant A')", [T_A]);

    // Point every pool this service uses at the disposable cluster, THEN import it.
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    pinAccountingTopologyTo(cluster.url);
    svc = await import("../server/partner/public-network-service");
  }, 300_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop?.();
  });

  describe("measureEvidence — the denominator, executed not re-typed", () => {
    it("counts an approved partner-originated card, and reports it first-pass when never bounced", async () => {
      const { locationId } = await seedListing(T_A, "Evidence Basic", "evidence-basic");
      await insertCert(locationId, { redoCount: 0 });

      const ev = await svc.measureEvidence(locationId);
      const volume = ev.metrics.find((m) => m.metric === "completed_volume");
      const firstPass = ev.metrics.find((m) => m.metric === "first_pass_approval_rate");

      expect(volume?.rawValue).toBe(1);
      expect(firstPass?.normalised).toBe(1);
    });

    it("EXCLUDES a voided card — dropping `status = 'active'` from the predicate turns this red", async () => {
      const { locationId } = await seedListing(T_A, "Evidence Voided", "evidence-voided");
      await insertCert(locationId, { status: "active" });
      await insertCert(locationId, { status: "voided" });

      const ev = await svc.measureEvidence(locationId);
      expect(ev.sampleSize).toBe(1);
    });

    it("EXCLUDES a soft-deleted card — dropping `deleted_at IS NULL` turns this red", async () => {
      const { locationId } = await seedListing(T_A, "Evidence Deleted", "evidence-deleted");
      await insertCert(locationId, {});
      await insertCert(locationId, { deletedAt: new Date().toISOString() });

      const ev = await svc.measureEvidence(locationId);
      expect(ev.sampleSize).toBe(1);
    });

    it("EXCLUDES an unapproved card — dropping `grade_approved_at IS NOT NULL` turns this red", async () => {
      const { locationId } = await seedListing(T_A, "Evidence Unapproved", "evidence-unapproved");
      await insertCert(locationId, {});
      await insertCert(locationId, { approved: false });

      const ev = await svc.measureEvidence(locationId);
      expect(ev.sampleSize).toBe(1);
    });

    it("EXCLUDES a non-partner card — dropping the origin_type = PARTNER filter turns this red", async () => {
      const { locationId } = await seedListing(T_A, "Evidence Origin", "evidence-origin");
      await insertCert(locationId, {});
      await insertCert(locationId, { originType: "HQ" });

      const ev = await svc.measureEvidence(locationId);
      expect(ev.sampleSize).toBe(1);
    });

    it("attributes only this location's cards", async () => {
      const a = await seedListing(T_A, "Evidence Loc A", "evidence-loc-a");
      const b = await seedListing(T_A, "Evidence Loc B", "evidence-loc-b");
      await insertCert(a.locationId, {});
      await insertCert(a.locationId, {});
      await insertCert(b.locationId, {});

      expect((await svc.measureEvidence(a.locationId)).sampleSize).toBe(2);
      expect((await svc.measureEvidence(b.locationId)).sampleSize).toBe(1);
    });

    it("sums redo_count into rework intensity, and a bounced card is not first-pass", async () => {
      const { locationId } = await seedListing(T_A, "Evidence Redos", "evidence-redos");
      await insertCert(locationId, { redoCount: 0 });
      await insertCert(locationId, { redoCount: 2 });

      const ev = await svc.measureEvidence(locationId);
      // 1 of 2 clean -> 0.5; avg redos 1.0 of a 2.0 ceiling -> 1 - 0.5 = 0.5
      expect(ev.metrics.find((m) => m.metric === "first_pass_approval_rate")?.normalised).toBeCloseTo(0.5, 5);
      expect(ev.metrics.find((m) => m.metric === "rework_intensity")?.normalised).toBeCloseTo(0.5, 5);
    });
  });

  /**
   * THE GAMING VECTOR, REPRODUCED THROUGH THE REAL ENGINE.
   *
   * This is limitation L1 (docs/partner-public-network-0058.md:261) executed end to end rather than
   * argued on paper. It pins the CURRENT behaviour so the V2 fix has a measured "before".
   *
   * A unit that reached HQ review, was returned for change, and was then abandoned has
   * `grade_approved_at IS NULL` and `redo_count >= 1`. It therefore leaves BOTH the numerator and
   * the denominator, which improves both scored components at once.
   */
  describe("L1 — abandonment gaming vector, measured on the real engine", () => {
    it("scores 20 honest cards (10 bounced once) at 2.9", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Gaming Honest", "gaming-honest");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 0 });
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1 });

      const res = await svc.recalculateRating(listingId, "test@hq");
      expect(res.computed.sampleSize).toBe(20);
      expect(res.computed.publicRating).toBeCloseTo(2.9, 5);
      expect(res.computed.ratingAvailable).toBe(true);
    });

    it("scores the SAME body of work at 5.0 once the 10 bounced units are abandoned", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Gaming Abandoned", "gaming-abandoned");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 0 });
      // Reached review, bounced, never resubmitted: unapproved and invisible to today's denominator.
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1, approved: false });

      const res = await svc.recalculateRating(listingId, "test@hq");
      expect(res.computed.sampleSize).toBe(10);
      expect(res.computed.publicRating).toBeCloseTo(5.0, 5);
      // The abandoned units are durably present and identifiable — the evidence exists, the
      // denominator simply declines to look at it. This is the predicate gap the V2 fix closes.
      const durable = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM certificates
          WHERE origin_location_id = $1 AND origin_type = 'PARTNER'
            AND deleted_at IS NULL AND grade_approved_at IS NULL AND redo_count > 0`,
        [locationId],
      );
      expect(Number(durable.rows[0].n)).toBe(10);
    });
  });

  /**
   * The cancellation state machine — the anti-laundering control.
   *
   * Closing the rating denominator alone would NOT have closed the gaming vector: a shop could see
   * a card come back at `returned_for_change`, cancel the submission, and re-submit the same
   * physical card with a fresh `redo_count` of 0. Every surrogate key in the chain is minted at
   * intake, so the second attempt is a different card to every table in the system. Governance of
   * the lifecycle is what makes the evidence unerasable.
   */
  describe("cancellation state machine — grading evidence lock", () => {
    let guard: typeof import("../server/partner/grading-assignment");

    beforeAll(async () => {
      guard = await import("../server/partner/grading-assignment");
    });

    it("A — ALLOWS cancellation before grading starts (ready_for_assignment)", async () => {
      const { locationId } = await seedListing(T_A, "Cancel Pre", "cancel-pre");
      const { partnerSubmissionId } = await seedWorkItem(locationId, "ready_for_assignment", "pre");

      await expect(
        guard.assertCancellationLeavesNoGradingEvidence(admin, partnerSubmissionId),
      ).resolves.toBeUndefined();
    });

    it("B — REFUSES cancellation once a card is assigned to a grader", async () => {
      const { locationId } = await seedListing(T_A, "Cancel Assigned", "cancel-assigned");
      const { partnerSubmissionId } = await seedWorkItem(locationId, "assigned", "assigned");

      await expect(
        guard.assertCancellationLeavesNoGradingEvidence(admin, partnerSubmissionId),
      ).rejects.toThrow(/Grading has already started/);
    });

    it("B — REFUSES cancellation at pending_review, and carries a named domain code", async () => {
      const { locationId } = await seedListing(T_A, "Cancel Review", "cancel-review");
      const { partnerSubmissionId } = await seedWorkItem(locationId, "pending_review", "review");

      const err = await guard
        .assertCancellationLeavesNoGradingEvidence(admin, partnerSubmissionId)
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(guard.PartnerGradingEvidenceLockError);
      expect((err as { code: string }).code).toBe("grading_already_started");
    });

    it("B — REFUSES cancellation at returned_for_change, which is the laundering entry point", async () => {
      const { locationId } = await seedListing(T_A, "Cancel Returned", "cancel-returned");
      const { partnerSubmissionId } = await seedWorkItem(locationId, "returned_for_change", "returned");

      await expect(
        guard.assertCancellationLeavesNoGradingEvidence(admin, partnerSubmissionId),
      ).rejects.toThrow(/Grading has already started/);
    });

    it("B — REFUSES cancellation after approval", async () => {
      const { locationId } = await seedListing(T_A, "Cancel Approved", "cancel-approved");
      const { partnerSubmissionId } = await seedWorkItem(locationId, "approved", "approved");

      await expect(
        guard.assertCancellationLeavesNoGradingEvidence(admin, partnerSubmissionId),
      ).rejects.toThrow(/Grading has already started/);
    });

    it("scopes the refusal to the submission being cancelled, not the whole tenant", async () => {
      const { locationId } = await seedListing(T_A, "Cancel Scope", "cancel-scope");
      await seedWorkItem(locationId, "pending_review", "scope-busy");
      const quiet = await seedWorkItem(locationId, "ready_for_assignment", "scope-quiet");

      // A different submission mid-review must not block this one.
      await expect(
        guard.assertCancellationLeavesNoGradingEvidence(admin, quiet.partnerSubmissionId),
      ).resolves.toBeUndefined();
    });
  });

  describe("sample gate and public exposure", () => {
    it("withholds a public rating below the minimum sample, and says so", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Gate Low", "gate-low");
      for (let i = 0; i < 9; i++) await insertCert(locationId, { redoCount: 0 });

      const res = await svc.recalculateRating(listingId, "test@hq");
      expect(res.computed.sampleSize).toBe(9);
      expect(res.computed.publicRating).toBeNull();
      expect(res.computed.ratingAvailable).toBe(false);
      expect(res.computed.ratingLabel).toBe("Rating building");
    });

    it("publishes the persisted snapshot through the anonymous profile DTO", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Profile Pub", "profile-pub");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 0 });
      await svc.recalculateRating(listingId, "test@hq");

      const profile = await svc.getShopProfile("profile-pub");
      expect(profile).not.toBeNull();
      expect(profile!.rating.available).toBe(true);
      expect(profile!.rating.rating).toBeCloseTo(5.0, 5);
      expect(profile!.stats.cardsGraded).toBe(10);
    });

    it("never leaks a private column into the public profile DTO", async () => {
      const { locationId } = await seedListing(T_A, "Profile Priv", "profile-priv");
      await insertCert(locationId, {});

      const profile = await svc.getShopProfile("profile-priv");
      const keys = Object.keys(profile as object);
      for (const forbidden of ["id", "tenantId", "tenant_id", "locationId", "location_id", "createdBy", "approvedBy", "verifiedBy", "publicRef"]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });
});
