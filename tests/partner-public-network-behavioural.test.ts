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
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
/** The rollout gate + readiness module (H12/H13/H14). Same late-import discipline. */
let gate: typeof import("../server/partner/public-network-gate");

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
    "INSERT INTO partner_locations (tenant_id, partner_id, name, status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
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

    // grade, redo_count, graded_at and status_updated_at now live in the shared stub (they exist on
    // the real table and PARTNER_QUALITY_V2 reads all four). These ALTERs are kept as idempotent
    // belt-and-braces so this suite still stands up if the shared stub is ever narrowed again.
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade numeric(4,1)");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS redo_count integer NOT NULL DEFAULT 0");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS graded_at timestamptz");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS status_updated_at timestamptz");

    await admin.query("INSERT INTO partner_organisations (id, legal_name, status) VALUES ($1,'Tenant A','ACTIVE')", [T_A]);

    // Point every pool this service uses at the disposable cluster, THEN import it.
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    // The public pool (0061) connects on the SAME disposable cluster but drops to
    // partner_public_reader via SET ROLE on every connection, so what actually executes the public
    // SQL in this suite is the restricted identity — not the superuser the URL authenticates as.
    process.env.PARTNER_PUBLIC_DATABASE_URL = cluster.url;
    pinAccountingTopologyTo(cluster.url);
    svc = await import("../server/partner/public-network-service");
    gate = await import("../server/partner/public-network-gate");
    // The public network is DEFAULT OFF (H14). Every pre-existing test in this suite predates the
    // kill switch and asserts the behaviour of a LIVE network, so the flag is enabled once here for
    // the suite as a whole. The gate's own OFF behaviour is proven in its dedicated block below,
    // which toggles it deliberately — not by leaving the rest of the suite in the off state, which
    // would silently turn 60 behavioural assertions into "everything 404s" and still pass.
    await setPublicNetworkFlag(true);
  }, 300_000);

  /** Global (tenant_id IS NULL) rollout flag, the shape resolveGlobalFlag reads. */
  async function setPublicNetworkFlag(enabled: boolean): Promise<void> {
    await admin.query("DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL", [
      "partner_public_network_enabled",
    ]);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL, NULL, $1, $2)",
      ["partner_public_network_enabled", enabled],
    );
    // The gate caches a TRUE verdict for 5s; drop it so a toggle is observable immediately.
    gate.__resetPartnerPublicNetworkFlagCache();
  }

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

    it("counts an ungraded approved card as a reviewed unit but NEVER as first-pass", async () => {
      // Under V1 this asserted PUBLIC_CARD_PREDICATE's `grade IS NOT NULL` conjunct, which had no
      // other killer test. V2 moves that conjunct from the DENOMINATOR to the FIRST-PASS NUMERATOR,
      // and the distinction is the whole point:
      //   - the unit DID go through review, so removing it from the denominator would be the same
      //     flattering erasure that L1 exploited;
      //   - but we cannot prove it was cleanly approved with no grade on it, and "we don't know"
      //     must never be scored as "clean".
      // So it stays in the population and costs the shop, exactly as an unknown should.
      // PUBLIC_CARD_PREDICATE still enforces `grade IS NOT NULL` for public CARD DISPLAY; that is a
      // different question ("may this be shown") and keeps its own tests above.
      const { locationId } = await seedListing(T_A, "Evidence No Grade", "evidence-no-grade");
      await insertCert(locationId, {});
      await insertCert(locationId, { grade: null });

      const ev = await svc.measureEvidence(locationId);
      expect(ev.sampleSize).toBe(2);
      const firstPass = ev.metrics.find((m) => m.metric === "first_pass_approval_rate")!;
      // 1 of 2 — deleting `grade IS NOT NULL` from the numerator makes this 1.0 and turns it red.
      expect(firstPass.rawValue).toBeCloseTo(0.5, 5);
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

    it("V2: abandoning the 10 bounced units changes NOTHING — same sample, same 2.9", async () => {
      // THE FIX, stated as an equality rather than a threshold. Under V1 this same fixture scored
      // 5.0 with sampleSize 10: the abandoned units left the numerator and the denominator at once.
      // Under V2 the shop is graded on identical evidence whether it resubmits its bad work or
      // walks away from it, so abandonment stops being a strategy at all.
      const { listingId, locationId } = await seedListing(T_A, "Gaming Abandoned", "gaming-abandoned");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 0 });
      // Reached review, bounced, never resubmitted: unapproved, and STILL in the V2 population.
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1, approved: false });

      const res = await svc.recalculateRating(listingId, "test@hq");
      expect(res.computed.sampleSize).toBe(20);
      expect(res.computed.publicRating).toBeCloseTo(2.9, 5);
      expect(res.computed.version).toBe("PARTNER_QUALITY_V2");

      // Abandonment is still visible to HQ as its own evidence line, not just absorbed into the score.
      const aband = res.evidence.metrics.find((m) => m.metric === "abandoned_unit_rate")!;
      expect(aband.rawValue).toBeCloseTo(0.5, 5);

      const durable = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM certificates
          WHERE origin_location_id = $1 AND origin_type = 'PARTNER'
            AND deleted_at IS NULL AND grade_approved_at IS NULL AND redo_count > 0`,
        [locationId],
      );
      expect(Number(durable.rows[0].n)).toBe(10);
    });

    /**
     * REVIEW-DUP1's target: a physical unit is counted ONCE however many times it goes round.
     *
     * One certificate row IS one physical unit, and server/grader.ts increments redo_count on that
     * same row at each rejection. So return/resubmit/return/resubmit/approve is one unit carrying
     * two redos, not three samples — the sample size cannot be inflated by churning a card, while
     * the churn itself still costs the shop through rework intensity.
     */
    it("counts one physical unit ONCE across returned -> resubmitted -> returned -> resubmitted -> approved", async () => {
      const { locationId } = await seedListing(T_A, "Resubmit Cycle", "resubmit-cycle");
      await insertCert(locationId, { redoCount: 2, approved: true });

      const ev = await svc.measureEvidence(locationId);
      expect(ev.sampleSize).toBe(1);
      const rework = ev.metrics.find((m) => m.metric === "rework_intensity")!;
      // Two redos on ONE unit, not two units averaging one redo.
      expect(rework.rawValue).toBeCloseTo(2.0, 5);
      const firstPass = ev.metrics.find((m) => m.metric === "first_pass_approval_rate")!;
      expect(firstPass.rawValue).toBeCloseTo(0.0, 5);
    });
  });

  /**
   * RATING AUTOMATION (0062) — dirty marking, non-blocking refresh, bounded reconciliation.
   */
  describe("rating lifecycle automation", () => {
    let life: typeof import("../server/partner/public-network-rating-lifecycle");

    beforeAll(async () => {
      life = await import("../server/partner/public-network-rating-lifecycle");
    });

    async function dirtyState(listingId: string) {
      const r = await admin.query<{
        rating_dirty: boolean; rating_failure_count: number;
        rating_last_error_code: string | null; rating_last_success_at: Date | null;
      }>(
        `SELECT rating_dirty, rating_failure_count, rating_last_error_code, rating_last_success_at
           FROM partner_public_listings WHERE id = $1`,
        [listingId],
      );
      return r.rows[0];
    }

    it("RATING-AUTO1: marking dirty is idempotent and does not move the queue position", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Dirty Idem", "dirty-idem");
      // Forcing the listing clean now has to move the GENERATIONS too, not just the flag: 0066's
      // chk_partner_public_listings_rating_generations makes rating_dirty a derived fact
      // (clean_generation < dirty_generation) rather than an independently-settable boolean. That
      // constraint is the point — it is what stops the flag and the counters disagreeing — so the
      // fixture is what changes, not the invariant.
      await admin.query(
        `UPDATE partner_public_listings
            SET rating_dirty=false, rating_dirty_since=NULL,
                rating_clean_generation = rating_dirty_generation
          WHERE id=$1`, [listingId]);

      await life.markRatingDirty(admin, locationId);
      const first = await admin.query<{ since: Date; gen: string }>(
        "SELECT rating_dirty_since AS since, rating_dirty_generation::text AS gen FROM partner_public_listings WHERE id=$1", [listingId]);
      expect((await dirtyState(listingId)).rating_dirty).toBe(true);

      await life.markRatingDirty(admin, locationId);
      const second = await admin.query<{ since: Date; gen: string }>(
        "SELECT rating_dirty_since AS since, rating_dirty_generation::text AS gen FROM partner_public_listings WHERE id=$1", [listingId]);
      // Monotonic: a shop under constant activity cannot keep pushing itself to the back of the
      // oldest-first queue and starve a quieter one.
      expect(second.rows[0].since.getTime()).toBe(first.rows[0].since.getTime());
      // BUT the generation MUST move on the second mark, even though the listing was already
      // dirty. That is the H2 repair: the old implementation carried `AND rating_dirty = false`,
      // so a second event on an already-dirty listing left no trace — and an in-flight
      // recalculation would then CAS it clean and erase the event. Idempotent POSITION, not
      // idempotent GENERATION.
      expect(BigInt(second.rows[0].gen)).toBeGreaterThan(BigInt(first.rows[0].gen));
    });

    it("a reconciler tick refreshes a dirty listing and marks it clean", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Recon One", "recon-one");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1 });
      await life.markRatingDirty(admin, locationId);

      const result = await life.runRatingReconciler({ limit: 50 });
      expect(result.processed).toBeGreaterThan(0);
      expect(result.failed).toBe(0);

      const after = await dirtyState(listingId);
      expect(after.rating_dirty).toBe(false);
      expect(after.rating_last_success_at).not.toBeNull();
      // And the rating actually moved — the refresh did work, not just flip a flag.
      const profile = await svc.getShopProfile("recon-one");
      expect(profile?.rating.available).toBe(true);
      expect(profile?.rating.sampleSize).toBe(10);
    });

    it("is bounded: a tick never processes more than its batch limit", async () => {
      for (let i = 0; i < 4; i++) {
        const { locationId } = await seedListing(T_A, `Batch ${i}`, `batch-${i}`);
        await life.markRatingDirty(admin, locationId);
      }
      const result = await life.runRatingReconciler({ limit: 2 });
      expect(result.processed).toBe(2);
    });

    it("one poisoned listing does not stop the rest of the batch", async () => {
      const good = await seedListing(T_A, "Recon Good", "recon-good");
      const bad = await seedListing(T_A, "Recon Bad", "recon-bad");
      await life.markRatingDirty(admin, good.locationId);
      await life.markRatingDirty(admin, bad.locationId);
      // Break exactly ONE listing, genuinely and at the database level: a CHECK that rejects a
      // snapshot insert for this listing id makes its recalculation fail for real. tenant_id and
      // location_id are immutable by trigger (correctly), so the failure has to be induced somewhere
      // the recalculation actually writes.
      await admin.query(
        `ALTER TABLE partner_public_rating_snapshots
           ADD CONSTRAINT chk_poison_one_listing CHECK (listing_id <> '${bad.listingId}'::uuid)`,
      );
      let result: Awaited<ReturnType<typeof life.runRatingReconciler>>;
      try {
        result = await life.runRatingReconciler({ limit: 50 });
      } finally {
        await admin.query("ALTER TABLE partner_public_rating_snapshots DROP CONSTRAINT chk_poison_one_listing");
      }
      // The healthy one still got done — a single bad row must not freeze every rating in the estate.
      expect(result.refreshed).toBeGreaterThan(0);
      expect((await dirtyState(good.listingId)).rating_dirty).toBe(false);
      // And the broken one is retained as dirty with a CLASSIFIED code, never driver text.
      const b = await dirtyState(bad.listingId);
      expect(b.rating_dirty).toBe(true);
      expect(b.rating_failure_count).toBeGreaterThan(0);
      if (b.rating_last_error_code !== null) {
        expect(b.rating_last_error_code).toMatch(/^[a-z_]+$/);
      }
    });

    it("two concurrent reconcilers take disjoint work and neither corrupts the other", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { listingId, locationId } = await seedListing(T_A, `Conc ${i}`, `conc-${i}`);
        await life.markRatingDirty(admin, locationId);
        ids.push(listingId);
      }
      const [a, b] = await Promise.all([
        life.runRatingReconciler({ limit: 10, actor: "recon-a" }),
        life.runRatingReconciler({ limit: 10, actor: "recon-b" }),
      ]);
      expect(a.failed + b.failed).toBe(0);
      // FOR UPDATE SKIP LOCKED means the two runners claim disjoint rows rather than both doing
      // everything — and every listing still ends up clean, so no work is lost either.
      for (const id of ids) {
        expect((await dirtyState(id)).rating_dirty, `listing ${id} left dirty`).toBe(false);
      }
    });

    it("RATING-FAIL1: a genuine recalculation failure resolves instead of throwing", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Fail Iso", "fail-iso");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1 });

      // A REAL failure, at the database, for exactly this listing. Not an early return and not a
      // mock: the snapshot insert genuinely raises. If refreshRatingAfterCommit ever propagated,
      // this is the shape of error that would take an HQ approval down with it.
      await admin.query(
        `ALTER TABLE partner_public_rating_snapshots
           ADD CONSTRAINT chk_fail_iso CHECK (listing_id <> '${listingId}'::uuid)`,
      );
      try {
        await expect(life.refreshRatingAfterCommit(locationId, "test")).resolves.toEqual({
          refreshed: false,
          reason: "recalculation_failed",
        });
      } finally {
        await admin.query("ALTER TABLE partner_public_rating_snapshots DROP CONSTRAINT chk_fail_iso");
      }

      // The obligation survived the failure: still dirty, so the reconciler will retry it.
      expect((await dirtyState(listingId)).rating_dirty).toBe(true);

      // And with the fault removed a real refresh succeeds — so the test is not passing merely
      // because everything is broken.
      await expect(life.refreshRatingAfterCommit(locationId, "test")).resolves.toMatchObject({
        refreshed: true,
      });
      expect((await dirtyState(listingId)).rating_dirty).toBe(false);
    });

    it("only surfaces a rating in Needs Attention after the retry threshold", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Attn", "attn");
      await life.markRatingDirty(admin, locationId);
      // One failure is unlucky, not a human problem.
      await admin.query("UPDATE partner_public_listings SET rating_failure_count=1 WHERE id=$1", [listingId]);
      expect((await life.ratingsNeedingAttention()).some((r) => r.listingId === listingId)).toBe(false);

      await admin.query("UPDATE partner_public_listings SET rating_failure_count=$2 WHERE id=$1",
        [listingId, life.RATING_FAILURE_ATTENTION_THRESHOLD]);
      const attention = await life.ratingsNeedingAttention();
      const row = attention.find((r) => r.listingId === listingId);
      expect(row, "a persistently failing rating must reach Needs Attention").toBeDefined();
      expect(row!.slug).toBe("attn");
    });
  });

  /**
   * PUBLIC READER ISOLATION (0061) — least privilege, proven by refusal.
   *
   * Every other test in this file would pass just as happily if the public path were still running
   * on the owner connection: they assert what comes BACK, and an over-privileged connection returns
   * the same rows. These assert what the public identity CANNOT do, which is the only way to prove
   * privilege was actually dropped rather than merely intended.
   */
  describe("public reader — least privilege", () => {
    let db: typeof import("../server/partner/db");
    let routes: typeof import("../server/partner/public-network-routes");

    beforeAll(async () => {
      db = await import("../server/partner/db");
      routes = await import("../server/partner/public-network-routes");
    });

    it("executes public SQL AS partner_public_reader, not as the connecting login role", async () => {
      // The pool authenticates as the cluster superuser in this suite and drops to the group role
      // via SET ROLE on connect. If that ever silently failed, every functional test would still
      // pass while the public path held owner privileges — so assert the identity itself.
      const r = await db.partnerPublicQuery<{ who: string; su: boolean }>(
        "SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su",
      );
      expect(r.rows[0].who).toBe("partner_public_reader");
      expect(r.rows[0].su).toBe(false);
    });

    it("the role is NOLOGIN, NOSUPERUSER and NOBYPASSRLS", async () => {
      const r = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
        "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='partner_public_reader'",
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].rolsuper).toBe(false);
      expect(r.rows[0].rolbypassrls).toBe(false);
      expect(r.rows[0].rolcanlogin).toBe(false);
    });

    /**
     * REGRESSION: postcode search must actually work through the projection.
     *
     * findShops filters on postcode_normalised / postcode_outward — GENERATED columns on the base
     * table. When the public reads moved onto partner_public_shop_projection those columns were not
     * carried across, so every postcode search raised 42703 and fell through to a 500. Nothing
     * caught it because no test had ever exercised postcode search against a real database: the
     * whole feature had zero behavioural callers.
     */
    it("postcode search works through the public projection (full and outward)", async () => {
      const { listingId } = await seedListing(T_A, "Postcode Shop", "postcode-shop");
      await admin.query("UPDATE partner_public_listings SET postcode='ME2 2NG' WHERE id=$1", [listingId]);

      const full = await svc.findShops({ postcode: "ME2 2NG", page: 1, pageSize: 20 });
      expect(full.rows.some((r) => r.slug === "postcode-shop"), "full postcode found nothing").toBe(true);

      const outward = await svc.findShops({ postcode: "ME2", page: 1, pageSize: 20 });
      expect(outward.rows.some((r) => r.slug === "postcode-shop"), "outward code found nothing").toBe(true);
    });

    it("can read the two public projections and nothing else", async () => {
      await expect(
        db.partnerPublicQuery("SELECT count(*) FROM partner_public_shop_projection"),
      ).resolves.toBeTruthy();
      await expect(
        db.partnerPublicQuery("SELECT count(*) FROM partner_public_card_projection"),
      ).resolves.toBeTruthy();
    });

    /**
     * PUBLIC-PRIV1's target. Granting the reader any one of these turns this red.
     *
     * `certificates` and `partner_public_listings` are in the list deliberately: the reader reaches
     * both ONLY through a view whose WHERE clause is the publication gate. Direct table access would
     * hand anonymous traffic every unapproved card and every suspended shop.
     */
    it.each([
      "certificates",
      "partner_public_listings",
      "partner_public_rating_overrides",
      "partner_public_rating_snapshots",
      "partner_users",
      "partner_customers",
      "partner_submissions",
      "partner_wallets",
      "partner_credit_ledger",
      "partner_organisations",
      "partner_locations",
      "partner_audit_events",
      "partner_security_events",
      "partner_grading_work_items",
    ])("is REFUSED direct access to %s", async (table) => {
      await expect(db.partnerPublicQuery(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it("the card projection hides everything the publication gate excludes", async () => {
      const { locationId } = await seedListing(T_A, "Proj Gate", "proj-gate");
      await insertCert(locationId, {}); // publishable
      await insertCert(locationId, { approved: false }); // never approved
      await insertCert(locationId, { grade: null }); // approved but ungraded
      await insertCert(locationId, { status: "void" }); // voided
      await insertCert(locationId, { deletedAt: "now()" }); // soft-deleted
      await insertCert(locationId, { originType: "HQ" });     // not partner-originated

      const r = await db.partnerPublicQuery<{ n: string }>(
        "SELECT count(*)::text n FROM partner_public_card_projection WHERE origin_location_id = $1",
        [locationId],
      );
      // Six inserted, exactly one publishable. The gate is in the VIEW, so this holds no matter what
      // the application query asks for.
      expect(Number(r.rows[0].n)).toBe(1);
    });

    /**
     * PUBLIC-POOL1's target, and the only test here that proves the SERVICE — not just the pool —
     * is on the public identity.
     *
     * Removing PARTNER_PUBLIC_DATABASE_URL makes the public pool fail closed. If findShops or
     * getShopProfile were routed through partnerAdminQuery they would keep working, because that
     * helper falls back to MINTVAULT_DATABASE_URL. So "these two throw" IS the proof that anonymous
     * reads no longer touch privileged infrastructure.
     */
    it("the public SERVICE endpoints depend on the public pool, not the admin pool", async () => {
      const saved = process.env.PARTNER_PUBLIC_DATABASE_URL;
      await db.__resetPartnerPublicPoolForTests();
      delete process.env.PARTNER_PUBLIC_DATABASE_URL;
      try {
        await expect(svc.findShops({ page: 1, pageSize: 10 })).rejects.toThrow(/fail closed/i);
        await expect(svc.getShopProfile("proj-gate")).rejects.toThrow(/fail closed/i);
      } finally {
        process.env.PARTNER_PUBLIC_DATABASE_URL = saved;
        await db.__resetPartnerPublicPoolForTests();
      }
      // And the ADMIN path is unaffected by the public pool being down — isolation in the direction
      // that matters operationally: a public outage must not take Super Admin with it.
      const adminStillWorks = await admin.query<{ n: string }>(
        "SELECT count(*)::text n FROM partner_public_listings",
      );
      expect(Number(adminStillWorks.rows[0].n)).toBeGreaterThan(0);
    });

    /**
     * POOL EXHAUSTION, with real connections.
     *
     * Nothing here is mocked: six genuine clients are checked out of the real public pool and held,
     * then a seventh request is made. The assertion is on the OBSERVED elapsed time against the
     * configured acquire bound — not on vitest's own timeout, which would prove only that the test
     * runner gave up.
     */
    it("bounds a request that arrives with every public connection held, and leaves Admin healthy", async () => {
      const pool = db.__partnerPublicPoolForTests();
      const held: Array<{ release: () => void }> = [];
      try {
        for (let i = 0; i < 6; i++) held.push(await pool.connect());

        const started = Date.now();
        let failure: unknown;
        try {
          await svc.findShops({ page: 1, pageSize: 5 });
        } catch (e) {
          failure = e;
        }
        const elapsed = Date.now() - started;

        // It must FAIL — a seventh caller cannot be served — and fail QUICKLY. The 1s acquire bound
        // plus generous slack; anything near "forever" means the bound is not being applied.
        expect(failure, "a request with no free connection must fail, not queue indefinitely").toBeDefined();
        expect(elapsed, `expected a bounded failure, took ${elapsed}ms`).toBeLessThan(4000);
        // And it must be classified as unavailable, so the route answers 503 rather than 500.
        expect(routes.isPublicDbUnavailable(failure)).toBe(true);

        // THE ISOLATION CLAIM. While the public pool is fully saturated, Super Admin's own
        // connection is unaffected — that is the entire operational point of a separate pool.
        const adminOk = await admin.query<{ n: string }>(
          "SELECT count(*)::text n FROM partner_public_listings",
        );
        expect(Number(adminOk.rows[0].n)).toBeGreaterThan(0);
      } finally {
        for (const c of held) c.release();
      }

      // The pool is reusable afterwards: exhaustion is a transient state, not a permanent wedge.
      await expect(svc.findShops({ page: 1, pageSize: 5 })).resolves.toBeTruthy();
    });

    /**
     * LOCK WAIT, with a real lock.
     *
     * A competing session takes ACCESS EXCLUSIVE on partner_public_listings — exactly what a
     * migration or a stuck writer does — which blocks the public read through its view. The public
     * request must give up on its own configured bound.
     */
    it("bounds a public read blocked by a real ACCESS EXCLUSIVE lock", async () => {
      const blocker = new Client({ connectionString: cluster.url });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE partner_public_listings IN ACCESS EXCLUSIVE MODE");

        // RACE, not a bare await. If the bounds are removed the call simply never returns, and a
        // bare await would surface as vitest's own timeout — which proves nothing about the
        // application's contract. Racing against an explicit deadline turns "it never came back"
        // into a real assertion failure naming the missing bound. That is what makes
        // PUBLIC-TIMEOUT1 a genuine RED rather than a runner artefact.
        const DEADLINE_MS = 6000;
        const started = Date.now();
        const TIMED_OUT = Symbol("no-bound");
        let failure: unknown;
        const outcome = await Promise.race([
          svc.getShopProfile("proj-gate").then(
            () => "resolved" as const,
            (e) => {
              failure = e;
              return "rejected" as const;
            },
          ),
          new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), DEADLINE_MS)),
        ]);
        const elapsed = Date.now() - started;

        expect(
          outcome,
          `the public read was still waiting after ${DEADLINE_MS}ms — lock_timeout/statement_timeout is not being applied`,
        ).not.toBe(TIMED_OUT);
        expect(outcome, "a public read behind ACCESS EXCLUSIVE must fail, not succeed").toBe("rejected");
        expect(failure, "a public read behind ACCESS EXCLUSIVE must not wait forever").toBeDefined();
        // lock_timeout 1s / statement_timeout 2s / query_timeout 2s — whichever fires first, the
        // request is bounded well inside this. PUBLIC-TIMEOUT1 removes those bounds and this
        // becomes an unbounded wait, which is the RED.
        expect(elapsed, `expected a bounded failure, took ${elapsed}ms`).toBeLessThan(6000);
        expect(routes.isPublicDbUnavailable(failure)).toBe(true);

        // Admin is not starved by the public path giving up.
        await expect(admin.query("SELECT 1")).resolves.toBeTruthy();
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end().catch(() => {});
      }

      // Connection returned usable once the lock is gone.
      await expect(svc.getShopProfile("proj-gate")).resolves.toBeTruthy();
    }, 30_000);

    /**
     * THE 503 CONTRACT, over real HTTP.
     *
     * Asserted through an actual Express server rather than by calling the handler, because the
     * status code and the serialised body ARE the contract Codex will build against. Also asserts
     * what must NOT be in the body: a pg connection error's message routinely carries the host and
     * port, so echoing it would publish the database endpoint to anonymous callers.
     */
    it("answers 503 with a safe body when the public database is unavailable", async () => {
      const express = (await import("express")).default;
      const app = express();
      routes.registerPartnerNetworkPublicRoutes(app);
      const server = app.listen(0);
      await new Promise((r) => server.once("listening", r));
      const port = (server.address() as { port: number }).port;

      const saved = process.env.PARTNER_PUBLIC_DATABASE_URL;
      await db.__resetPartnerPublicPoolForTests();
      delete process.env.PARTNER_PUBLIC_DATABASE_URL;
      try {
        for (const path of ["/api/shops?page=1&pageSize=5", "/api/shops/proj-gate"]) {
          const res = await fetch(`http://127.0.0.1:${port}${path}`);
          expect(res.status, `${path} must answer 503`).toBe(503);
          const body = await res.json();
          expect(body).toEqual({
            error: {
              code: "public_service_unavailable",
              message: "Shop finder is temporarily unavailable. Please try again shortly.",
            },
          });
          // Nothing about the database may reach an anonymous caller.
          const raw = JSON.stringify(body).toLowerCase();
          for (const leak of ["postgres", "postgresql", "5432", "partner_public_reader", "sqlstate", "select ", "127.0.0.1", "password"]) {
            expect(raw, `503 body leaked ${leak}`).not.toContain(leak);
          }
        }
      } finally {
        process.env.PARTNER_PUBLIC_DATABASE_URL = saved;
        await db.__resetPartnerPublicPoolForTests();
        await new Promise((r) => server.close(r));
      }
    }, 30_000);

    it("FAILS CLOSED when the public database URL is absent — it does not fall back", async () => {
      const saved = process.env.PARTNER_PUBLIC_DATABASE_URL;
      await db.__resetPartnerPublicPoolForTests();
      delete process.env.PARTNER_PUBLIC_DATABASE_URL;
      try {
        // partnerAdminQuery would happily fall back to MINTVAULT_DATABASE_URL here. This must not.
        await expect(db.partnerPublicQuery("SELECT 1")).rejects.toThrow(/fail closed/i);
      } finally {
        process.env.PARTNER_PUBLIC_DATABASE_URL = saved;
        await db.__resetPartnerPublicPoolForTests();
      }
    });
  });

  /**
   * OVERRIDE EXPIRY — a time-boxed exception must actually end.
   *
   * `expires_at` used to be read only inside recalculateRating's transaction, and every public read
   * consumes the denormalised current_* columns that transaction wrote. Nothing recalculates on a
   * schedule, so an expired override kept being published verbatim, indefinitely, until a Super
   * Admin happened to press Recalculate.
   *
   * These tests move the CLOCK, not the data: after the recalculation that installs the override,
   * nothing writes to the listing again. If the public rating changes, it changed by comparison at
   * read time — which is the whole property.
   */
  describe("rating override expiry", () => {
    async function installOverride(listingId: string, rating: string, expiresAt: string | null) {
      await admin.query(
        `INSERT INTO partner_public_rating_overrides
           (tenant_id, listing_id, override_public_rating, override_rating_label, reason, created_by, expires_at,
            computed_public_rating, computed_rating_label)
         VALUES ($1,$2,$3,'Exceptional','pilot goodwill','hq@test',${expiresAt ?? "NULL"},
                 (SELECT current_computed_public_rating FROM partner_public_listings WHERE id=$2),
                 (SELECT current_computed_rating_label FROM partner_public_listings WHERE id=$2))`,
        [T_A, listingId, rating],
      );
    }

    it("serves the override while it is in force", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Ovr Live", "ovr-live");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1 });
      await svc.recalculateRating(listingId, "test@hq");
      await installOverride(listingId, "4.8", "now() + interval '30 days'");
      await svc.recalculateRating(listingId, "test@hq");

      const p = await svc.getShopProfile("ovr-live");
      expect(p?.rating.isOverride).toBe(true);
      expect(p?.rating.rating).toBeCloseTo(4.8, 5);
      // A hand-set number must never be attributed to the formula.
      expect(p?.rating.version).toBeNull();
    });

    it("OVERRIDE-EXPIRY1: stops serving the override the moment it expires, with NO recalculation", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Ovr Expiry", "ovr-expiry");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1 });
      await svc.recalculateRating(listingId, "test@hq");
      const computed = await svc.getShopProfile("ovr-expiry");
      const computedRating = computed!.rating.rating;
      expect(computedRating).not.toBeNull();

      await installOverride(listingId, "5.0", "now() + interval '30 days'");
      await svc.recalculateRating(listingId, "test@hq");
      expect((await svc.getShopProfile("ovr-expiry"))!.rating.rating).toBeCloseTo(5.0, 5);

      // Move the clock past the expiry. NOTHING else is written — no recalculation, no job, no human.
      await admin.query(
        "UPDATE partner_public_listings SET current_override_expires_at = now() - interval '1 second' WHERE id=$1",
        [listingId],
      );

      const after = await svc.getShopProfile("ovr-expiry");
      expect(after!.rating.isOverride).toBe(false);
      expect(after!.rating.rating).toBeCloseTo(computedRating!, 5);
      // The formula is answering again, so the version is attributable again.
      expect(after!.rating.version).toBe("PARTNER_QUALITY_V2");
    });

    it("expiry reaches the finder's ranking too, not just the profile", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Ovr Finder", "ovr-finder");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1 });
      await svc.recalculateRating(listingId, "test@hq");
      await installOverride(listingId, "5.0", "now() + interval '30 days'");
      await svc.recalculateRating(listingId, "test@hq");

      const before = await svc.findShops({ page: 1, pageSize: 50 });
      expect(before.rows.find((r) => r.slug === "ovr-finder")!.rating.rating).toBeCloseTo(5.0, 5);

      await admin.query(
        "UPDATE partner_public_listings SET current_override_expires_at = now() - interval '1 second' WHERE id=$1",
        [listingId],
      );
      const after = await svc.findShops({ page: 1, pageSize: 50 });
      const row = after.rows.find((r) => r.slug === "ovr-finder")!;
      expect(row.rating.isOverride).toBe(false);
      expect(row.rating.rating).toBeLessThan(5.0);
    });

    it("preserves the override RECORD after expiry — the effect lapses, the history does not", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Ovr Audit", "ovr-audit");
      for (let i = 0; i < 10; i++) await insertCert(locationId, { redoCount: 1 });
      await svc.recalculateRating(listingId, "test@hq");
      await installOverride(listingId, "5.0", "now() - interval '1 day'");
      await svc.recalculateRating(listingId, "test@hq");

      // Nothing retired, deleted or rewrote the row: reason, actor and expiry all survive.
      const row = await admin.query<{ reason: string; created_by: string; removed_at: Date | null }>(
        "SELECT reason, created_by, removed_at FROM partner_public_rating_overrides WHERE listing_id=$1",
        [listingId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].reason).toBe("pilot goodwill");
      expect(row.rows[0].created_by).toBe("hq@test");
      expect(row.rows[0].removed_at).toBeNull();
      // ...and it is not being served.
      expect((await svc.getShopProfile("ovr-audit"))!.rating.isOverride).toBe(false);
    });
  });

  /**
   * PUBLIC ELIGIBILITY — suspension must propagate without a second manual action.
   *
   * A listing is a deliberate SNAPSHOT of a location, not a view over it (0058), so nothing carried
   * the tenant's or the location's current standing onto it. `listing_status='ACTIVE'` was the only
   * public gate, and a Super Admin suspending an organisation left its shop advertised, rated and
   * "verified" on the public finder until somebody remembered to flip the listing too.
   *
   * Note WHY the eligibility is denormalised onto the listing rather than joined at read time: the
   * public queries run on `partner_runtime` with NO tenant GUC, and both partner_organisations and
   * partner_locations are ENABLE + FORCE RLS with a tenant-isolation policy and no public branch
   * (0001). An EXISTS join against them from the anonymous connection matches zero rows, so it would
   * not hide suspended shops — it would hide EVERY shop, behind an HTTP 200.
   */
  describe("public eligibility — organisation and location suspension", () => {
    async function visible(slug: string): Promise<boolean> {
      const profile = await svc.getShopProfile(slug);
      const finder = await svc.findShops({ page: 1, pageSize: 50 });
      const inFinder = finder.rows.some((s) => s.slug === slug);
      // Visible means visible ANYWHERE public — a gate that closed the profile but left the shop
      // on the finder would still be advertising a suspended partner.
      return profile !== null || inFinder;
    }

    /** Always restore, even when an expectation throws, so one failure cannot cascade. */
    async function withOrgStatus(status: string, body: () => Promise<void>): Promise<void> {
      await admin.query("UPDATE partner_organisations SET status=$1 WHERE id=$2", [status, T_A]);
      try {
        await body();
      } finally {
        await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [T_A]);
      }
    }

    it("hides the shop when the ORGANISATION is suspended, with the listing left ACTIVE", async () => {
      const { locationId } = await seedListing(T_A, "Susp Org", "susp-org");
      expect(await visible("susp-org")).toBe(true);

      await withOrgStatus("SUSPENDED", async () => {
        // PUBLIC-SUSPEND1: the listing is untouched and still ACTIVE. Only the org changed.
        const still = await admin.query<{ s: string }>(
          "SELECT listing_status AS s FROM partner_public_listings WHERE slug='susp-org'",
        );
        expect(still.rows[0].s).toBe("ACTIVE");
        expect(await visible("susp-org")).toBe(false);
      });
      expect(await visible("susp-org")).toBe(true);
      expect(locationId).toBeTruthy();
    });

    it("hides the shop when the ORGANISATION is revoked", async () => {
      await seedListing(T_A, "Revoked Org", "revoked-org");
      await withOrgStatus("REVOKED", async () => {
        expect(await visible("revoked-org")).toBe(false);
      });
    });

    it("hides the shop when the LOCATION is suspended", async () => {
      const { locationId } = await seedListing(T_A, "Susp Loc", "susp-loc");
      expect(await visible("susp-loc")).toBe(true);
      await admin.query("UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1", [locationId]);
      expect(await visible("susp-loc")).toBe(false);
    });

    /**
     * The SECOND layer, proven on its own.
     *
     * Every other test here goes through the application predicate, so they all stay green even if
     * the RLS policy is gutted — defence in depth means either layer alone hides the shop, which is
     * exactly why neither layer can be proven by a test that exercises both. This one takes the
     * application out of the picture: it runs a bare SELECT as the RLS-bound runtime role with no
     * predicate at all, so only the 0059 policy can refuse it.
     */
    it("RLS alone refuses a suspended shop, with no application predicate involved", async () => {
      const { locationId } = await seedListing(T_A, "Rls Susp", "rls-susp");
      const asRuntime = async () => {
        await admin.query("SET ROLE partner_runtime");
        try {
          const r = await admin.query<{ slug: string }>(
            "SELECT slug FROM partner_public_listings WHERE slug = 'rls-susp'",
          );
          return r.rows.length;
        } finally {
          await admin.query("RESET ROLE");
        }
      };

      expect(await asRuntime()).toBe(1);
      await admin.query("UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1", [locationId]);
      // No WHERE listing_status, no service call — if this is 1, the policy is not carrying the gate.
      expect(await asRuntime()).toBe(0);
    });

    it("does not let the verified flag outlive eligibility", async () => {
      const { locationId } = await seedListing(T_A, "Verified Susp", "verified-susp");
      await admin.query("UPDATE partner_public_listings SET verified_at=now() WHERE slug='verified-susp'");
      const before = await svc.getShopProfile("verified-susp");
      expect(before?.verified).toBe(true);

      await admin.query("UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1", [locationId]);
      // Gone entirely rather than returned with verified:true — a denormalised badge must never
      // outlive the standing it attests to.
      expect(await svc.getShopProfile("verified-susp")).toBeNull();
    });
  });

  /**
   * THE 180-DAY WINDOW AND ITS FALLBACK.
   *
   * These two tests are a matched pair and neither means much alone: the first proves the window
   * bites, the second proves it cannot bite so hard that it manufactures a tiny-sample rating.
   */
  describe("PARTNER_QUALITY_V2 — 180-day recency window", () => {
    const OLD = "now() - interval '400 days'";

    it("lets recent poor work move the rating even against a large old clean history (RECENCY1/RECENCY2)", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Recency Decline", "recency-decline");
      // 40 spotless units from over a year ago — the history a declining shop would hide behind.
      for (let i = 0; i < 40; i++) await insertCert(locationId, { redoCount: 0, approvedAt: OLD });
      // 12 recent units, every one bounced twice. This is what the shop is doing NOW.
      for (let i = 0; i < 12; i++) await insertCert(locationId, { redoCount: 2 });

      const res = await svc.recalculateRating(listingId, "test@hq");
      // The window holds 12 units — at or above the minimum, so it is used and the old 40 are out.
      expect(res.computed.sampleSize).toBe(12);
      expect(res.evidence.windowDays).toBe(180);
      expect(res.computed.ratingAvailable).toBe(true);
      // Deleting the window (RECENCY1) pulls all 52 units in and lifts this to roughly 3.8;
      // letting old volume outweigh recent work (RECENCY2) does the same. Both turn this red.
      expect(res.computed.publicRating).toBeLessThan(1.5);
    });

    it("falls back to the all-time population when the window is too thin to judge", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Recency Fallback", "recency-fallback");
      // Only 4 units inside the window — below MINIMUM_PUBLIC_SAMPLE, so the window alone cannot rate.
      for (let i = 0; i < 4; i++) await insertCert(locationId, { redoCount: 0 });
      for (let i = 0; i < 20; i++) await insertCert(locationId, { redoCount: 0, approvedAt: OLD });

      const res = await svc.recalculateRating(listingId, "test@hq");
      // Widened to all-time rather than publishing a rating built on 4 cards.
      expect(res.computed.sampleSize).toBe(24);
      expect(res.evidence.windowDays).toBeNull();
      expect(res.computed.ratingAvailable).toBe(true);
    });

    it("still withholds a rating entirely when even the all-time population is too small", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Recency Tiny", "recency-tiny");
      for (let i = 0; i < 5; i++) await insertCert(locationId, { redoCount: 0 });

      const res = await svc.recalculateRating(listingId, "test@hq");
      // A thin window must never become a small rating. It becomes NO rating.
      expect(res.computed.sampleSize).toBe(5);
      expect(res.computed.ratingAvailable).toBe(false);
      expect(res.computed.publicRating).toBeNull();
      expect(res.computed.ratingLabel).toBe("Rating building");
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

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // ROLLOUT GATE AND READINESS — H14 (kill switch), H12 (readiness), H13 (reader membership)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  describe("public network rollout gate and readiness", () => {
    // Same late-import discipline as the least-privilege block: these modules memoise pool state
    // from the environment at first import, so they must be loaded AFTER the URLs are pinned.
    let db: typeof import("../server/partner/db");
    let routes: typeof import("../server/partner/public-network-routes");
    beforeAll(async () => {
      db = await import("../server/partner/db");
      routes = await import("../server/partner/public-network-routes");
    });

    /**
     * Mount the anonymous router on a throwaway Express app and drive it over real HTTP.
     *
     * Over HTTP rather than by calling the handler, because the GATE IS MIDDLEWARE — a handler-level
     * call would bypass the very thing under test, and would have passed even with no gate at all.
     */
    async function withPublicApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
      const express = (await import("express")).default;
      const app = express();
      routes.registerPartnerNetworkPublicRoutes(app);
      const server = app.listen(0);
      await new Promise((r) => server.once("listening", r));
      const port = (server.address() as { port: number }).port;
      try {
        return await fn(`http://127.0.0.1:${port}`);
      } finally {
        await new Promise((r) => server.close(() => r(null)));
      }
    }

    afterEach(async () => {
      // Every test in this block toggles a global. Leaving it off would silently 404 the rest of
      // the suite, which is exactly the failure mode the suite-level enable exists to avoid.
      await setPublicNetworkFlag(true);
    });

    it("H14: with the flag OFF the whole public network is invisible — finder AND profile", async () => {
      const { locationId } = await seedListing(T_A, "Gated Shop", "gated-shop");
      for (let i = 0; i < 10; i++) await insertCert(locationId, {});
      // Visible first, so the OFF assertion cannot pass because the shop was never listed.
      await expect(svc.getShopProfile("gated-shop")).resolves.toBeTruthy();

      await setPublicNetworkFlag(false);
      await withPublicApp(async (base) => {
        for (const path of ["/api/shops?page=1&pageSize=5", "/api/shops/gated-shop"]) {
          const res = await fetch(`${base}${path}`);
          // 404, NOT 503: an unlaunched surface must not advertise itself as "temporarily" down,
          // and it must be indistinguishable from a shop that is simply not listed.
          expect(res.status, `${path} must be 404 while the network is off`).toBe(404);
          expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Shop not found." } });
        }
      });
    }, 60_000);

    it("H14: an ABSENT flag row is OFF — the network is not live merely because the code deployed", async () => {
      await seedListing(T_A, "No Row Shop", "no-row-shop");
      // The rollout state on a freshly migrated estate: no flag row at all.
      await admin.query(
        "DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL",
        ["partner_public_network_enabled"],
      );
      gate.__resetPartnerPublicNetworkFlagCache();
      expect(await gate.partnerPublicNetworkEnabled(), "absent must mean OFF (fail closed)").toBe(false);
      await withPublicApp(async (base) => {
        expect((await fetch(`${base}/api/shops`)).status).toBe(404);
      });
    }, 60_000);

    it("H14: turning the flag ON exposes an eligible shop, and a SUSPENDED one stays hidden", async () => {
      const good = await seedListing(T_A, "Flag On Good", "flag-on-good");
      const bad = await seedListing(T_A, "Flag On Suspended", "flag-on-suspended");
      for (let i = 0; i < 10; i++) {
        await insertCert(good.locationId, {});
        await insertCert(bad.locationId, {});
      }
      // Suspension is an ELIGIBILITY rule (0059), and it must survive the kill switch being on.
      // A flag that resurrected suspended shops would be worse than no flag.
      await admin.query("UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1", [T_A]);
      await admin.query(
        "UPDATE partner_public_listings SET org_status='SUSPENDED' WHERE id=$1",
        [bad.listingId],
      );

      await setPublicNetworkFlag(true);
      await withPublicApp(async (base) => {
        const suspended = await fetch(`${base}/api/shops/flag-on-suspended`);
        expect(suspended.status, "a suspended shop must stay hidden with the flag ON").toBe(404);
      });
      // Restore, then prove the eligible one really is reachable — otherwise the assertion above
      // would pass on a network that is simply broken.
      await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [T_A]);
      await withPublicApp(async (base) => {
        const res = await fetch(`${base}/api/shops/flag-on-good`);
        expect(res.status, "an eligible shop must be reachable with the flag ON").toBe(200);
        expect((await res.json()).slug).toBe("flag-on-good");
      });
    }, 60_000);

    it("H12: readiness reports READY only when the reader can actually reach all three projections", async () => {
      gate.__resetPartnerPublicReadinessCache();
      const r = await gate.checkPartnerPublicNetworkReadiness({ force: true });
      expect(r.configured).toBe(true);
      expect(r.ready, `readiness said ${r.code}`).toBe(true);
      expect(r.code).toBeNull();
      // All three, named. 0061 without 0064 gives a working finder whose every image 503s — a
      // partial estate is the failure this exists to catch, so a partial pass is not a pass.
      expect(r.projectionsReachable.sort()).toEqual([
        "partner_public_card_projection",
        "partner_public_shop_projection",
        "public_slab_image_projection",
      ]);
    }, 60_000);

    it("H12: an unconfigured public DB is reported as not-ready, and is NOT cached", async () => {
      const saved = process.env.PARTNER_PUBLIC_DATABASE_URL;
      gate.__resetPartnerPublicReadinessCache();
      await db.__resetPartnerPublicPoolForTests();
      delete process.env.PARTNER_PUBLIC_DATABASE_URL;
      try {
        const r = await gate.checkPartnerPublicNetworkReadiness();
        expect(r.ready).toBe(false);
        expect(r.configured).toBe(false);
        expect(r.code).toBe("public_db_not_configured");
      } finally {
        process.env.PARTNER_PUBLIC_DATABASE_URL = saved;
        await db.__resetPartnerPublicPoolForTests();
      }
      // Re-probing must recover WITHOUT a restart: an unready verdict is never cached, because the
      // most likely moment it is returned is mid-rollout with an operator actively fixing it.
      const after = await gate.checkPartnerPublicNetworkReadiness({ force: true });
      expect(after.ready, "readiness must recover once the URL is restored").toBe(true);
    }, 60_000);

    it("H13: a login role WITHOUT partner_public_reader membership cannot become ready, and cannot serve", async () => {
      /**
       * THE STEP NO MIGRATION CAN PERFORM.
       *
       * 0061 creates partner_public_reader as a NOLOGIN GROUP role, per the house convention that a
       * real login role is granted membership out of band by infrastructure. Nothing in the
       * migration chain grants that membership, so a fully-migrated estate can still be unable to
       * serve — and before this test nothing anywhere proved what happens when it is missing.
       *
       * A dedicated login role with NO membership is the honest simulation. The suite's normal URL
       * authenticates as the cluster superuser, which can SET ROLE to anything and therefore could
       * never detect this.
       */
      await admin.query("DROP ROLE IF EXISTS pn_public_nomember");
      await admin.query("CREATE ROLE pn_public_nomember LOGIN PASSWORD 'nomember' NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT CONNECT ON DATABASE " + JSON.stringify(new URL(cluster.url).pathname.slice(1)).replace(/"/g, '"') + " TO pn_public_nomember");
      const saved = process.env.PARTNER_PUBLIC_DATABASE_URL;
      const u = new URL(cluster.url);
      u.username = "pn_public_nomember";
      u.password = "nomember";
      try {
        gate.__resetPartnerPublicReadinessCache();
        await db.__resetPartnerPublicPoolForTests();
        process.env.PARTNER_PUBLIC_DATABASE_URL = u.toString();

        const r = await gate.checkPartnerPublicNetworkReadiness({ force: true });
        expect(r.ready, "a role with no membership must not be reported ready").toBe(false);
        expect(r.configured, "the URL IS configured — this is a membership failure, not a missing var").toBe(true);
        expect(r.code).toBe("public_reader_role_unavailable");

        // And it must FAIL rather than silently serve on the login role. This is the fail-closed
        // half: the request errors, it does not quietly execute with more privilege than intended.
        await expect(db.partnerPublicQuery("SELECT 1")).rejects.toThrow();
      } finally {
        process.env.PARTNER_PUBLIC_DATABASE_URL = saved;
        await db.__resetPartnerPublicPoolForTests();
        gate.__resetPartnerPublicReadinessCache();
        await admin.query("DROP ROLE IF EXISTS pn_public_nomember").catch(() => {});
      }
      // Membership restored (the superuser URL) — ready again, so the assertion above was about
      // membership and not about a pool this test permanently broke.
      await expect(gate.checkPartnerPublicNetworkReadiness({ force: true })).resolves.toMatchObject({ ready: true });
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // MUTATION DETECTORS — every claim below was previously asserted only by a code comment
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  describe("rating lifecycle — the properties the mutation matrix targets", () => {
    let life: typeof import("../server/partner/public-network-rating-lifecycle");
    beforeAll(async () => {
      life = await import("../server/partner/public-network-rating-lifecycle");
    });
    afterEach(() => {
      life.__setRatingRefreshBarrierForTests(null);
    });

    /**
     * RATING-CAS1 — the lost update, made deterministic.
     *
     * The window is between the generation READ and the CAS write, and it spans a real aggregate
     * plus a snapshot transaction. Timing it with a sleep would produce a test that passes on a
     * fast machine with or without the CAS, which is the same as no test — so the competing event
     * is landed on a barrier at exactly the instant that matters.
     */
    it("RATING-CAS1: a quality event landing DURING a calculation is not erased by it", async () => {
      const { listingId, locationId } = await seedListing(T_A, "CAS Shop", "cas-shop");
      for (let i = 0; i < 10; i++) await insertCert(locationId, {});
      await life.markRatingDirty(admin, locationId);

      let barrierFired = false;
      life.__setRatingRefreshBarrierForTests(async () => {
        // The competing HQ approval, arriving mid-calculation.
        barrierFired = true;
        await life.markRatingDirty(admin, locationId);
      });

      const result = await life.refreshRatingAfterCommit(locationId, "test");
      expect(barrierFired, "the barrier must actually have run, or this proves nothing").toBe(true);
      // The calculation is NOT allowed to certify freshness it did not measure.
      expect(result).toMatchObject({ refreshed: false, reason: "superseded" });

      const after = await admin.query<{ dirty: boolean; dg: string; cg: string }>(
        `SELECT rating_dirty AS dirty, rating_dirty_generation::text AS dg, rating_clean_generation::text AS cg
           FROM partner_public_listings WHERE id = $1`, [listingId]);
      expect(after.rows[0].dirty, "the listing must still be dirty for the reconciler").toBe(true);
      expect(BigInt(after.rows[0].cg)).toBeLessThan(BigInt(after.rows[0].dg));

      // NON-VACUITY: with no competing event the very same call DOES clean it. Without this, the
      // assertion above would pass on a refresh that never cleans anything.
      life.__setRatingRefreshBarrierForTests(null);
      const clean = await life.refreshRatingAfterCommit(locationId, "test");
      expect(clean).toMatchObject({ refreshed: true });
      const settled = await admin.query<{ dirty: boolean }>(
        "SELECT rating_dirty AS dirty FROM partner_public_listings WHERE id=$1", [listingId]);
      expect(settled.rows[0].dirty).toBe(false);
    }, 60_000);

    /**
     * RATING-HOL1 — head-of-line starvation.
     *
     * A permanently failing listing keeps the OLDEST rating_dirty_since forever (deliberately —
     * that monotonicity is what stops a busy shop starving a quiet one), so without retry
     * eligibility it is first in every bounded batch, on every tick, permanently.
     */
    it("RATING-HOL1: poisoned listings back off, and healthy listings behind them are processed", async () => {
      // A REAL failure per listing, using the same technique as RATING-FAIL1: a CHECK constraint
      // on the snapshot table that names these listings. The first poison attempt tried to corrupt
      // location_id and was correctly refused by 0058's immutability trigger — which is the right
      // outcome and is why the poison is applied one level out, at the write the recalculation
      // actually performs.
      const poisoned: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { listingId, locationId } = await seedListing(T_A, `Poison ${i}`, `poison-${i}`);
        for (let c = 0; c < 10; c++) await insertCert(locationId, {});
        // Backdate so they are unambiguously FIRST in the oldest-first order — the whole defect is
        // that the oldest dirty row is permanently at the head of every bounded batch.
        await admin.query(
          `UPDATE partner_public_listings
              SET rating_dirty = true, rating_dirty_since = now() - interval '${100 + i} days',
                  rating_dirty_generation = rating_dirty_generation + 1
            WHERE id = $1`, [listingId]);
        await admin.query(
          `ALTER TABLE partner_public_rating_snapshots
             ADD CONSTRAINT chk_hol_${i} CHECK (listing_id <> '${listingId}'::uuid)`);
        poisoned.push(listingId);
      }
      const healthy = await seedListing(T_A, "Healthy Behind", "healthy-behind");
      for (let i = 0; i < 10; i++) await insertCert(healthy.locationId, {});
      // Dirty, but NEWER than the poisoned rows, so oldest-first puts it strictly behind them.
      await admin.query(
        `UPDATE partner_public_listings
            SET rating_dirty = true, rating_dirty_since = now() - interval '1 day',
                rating_dirty_generation = rating_dirty_generation + 1
          WHERE id = $1`, [healthy.listingId]);

      try {
        // Batch of exactly 3: the poisoned rows fill it completely on the first tick, by design.
        const first = await life.runRatingReconciler({ limit: 3, actor: "hol-a" });
        expect(first.processed, "the first tick must be entirely the three oldest (poisoned) rows").toBe(3);
        expect(first.failed, "all three must genuinely fail, not be skipped").toBe(3);

        // Each must now be BACKED OFF — ineligible for the next tick. This is the property the
        // mutation removes, and without it the next tick selects the same three forever.
        const backoff = await admin.query<{ n: string }>(
          `SELECT count(*)::text n FROM partner_public_listings
            WHERE id = ANY($1::uuid[]) AND rating_next_attempt_at > now() AND rating_failure_count > 0`,
          [poisoned]);
        expect(Number(backoff.rows[0].n), "poisoned rows must not be immediately re-eligible").toBe(3);

        // …so the SAME bounded batch size now reaches the healthy listing behind them.
        const second = await life.runRatingReconciler({ limit: 3, actor: "hol-b" });
        expect(second.refreshed, "a healthy listing behind poisoned ones must get processed").toBeGreaterThan(0);
        const h = await admin.query<{ dirty: boolean }>(
          "SELECT rating_dirty AS dirty FROM partner_public_listings WHERE id=$1", [healthy.listingId]);
        expect(h.rows[0].dirty, "the healthy listing must be reconciled, not starved").toBe(false);

        // And the poisoned rows are NOT abandoned — they are still owed, just not at the expense of
        // everything else. Needs Attention surfaces them at the existing threshold.
        const stillOwed = await admin.query<{ n: string }>(
          "SELECT count(*)::text n FROM partner_public_listings WHERE id = ANY($1::uuid[]) AND rating_dirty = true",
          [poisoned]);
        expect(Number(stillOwed.rows[0].n), "a backed-off listing must stay owed, not be dropped").toBe(3);
      } finally {
        for (let i = 0; i < 3; i++) {
          await admin.query(`ALTER TABLE partner_public_rating_snapshots DROP CONSTRAINT IF EXISTS chk_hol_${i}`);
        }
      }
    }, 120_000);

    /**
     * RATING-NEW1 — a new shop must not be born asserting a freshness nothing established.
     * The DEFAULT alone is not enough, which is why 0066 also carries a trigger: an INSERT that
     * NAMES the column overrides a default, and that is what a regression actually looks like.
     */
    it("RATING-NEW1: a new listing is born dirty even when the INSERT explicitly says otherwise", async () => {
      const loc = await admin.query<{ id: string }>(
        "INSERT INTO partner_locations (tenant_id, partner_id, name, status) VALUES ($1,$1,'Newborn','ACTIVE') RETURNING id",
        [T_A]);
      const ins = await admin.query<{ id: string; dirty: boolean; dg: string; cg: string }>(
        `INSERT INTO partner_public_listings
           (tenant_id, location_id, slug, public_display_name, listing_status, rating_dirty, rating_dirty_since)
         VALUES ($1,$2,'newborn','Newborn','DRAFT', false, NULL)
         RETURNING id, rating_dirty AS dirty, rating_dirty_generation::text AS dg, rating_clean_generation::text AS cg`,
        [T_A, loc.rows[0].id]);
      const row = ins.rows[0];
      expect(row.dirty, "an INSERT naming rating_dirty=false must still produce a dirty listing").toBe(true);
      expect(BigInt(row.cg), "the generations must agree with the flag").toBeLessThan(BigInt(row.dg));
      const since = await admin.query<{ s: Date | null }>(
        "SELECT rating_dirty_since s FROM partner_public_listings WHERE id=$1", [row.id]);
      expect(since.rows[0].s, "a dirty listing must carry the timestamp the queue orders by").not.toBeNull();
    }, 60_000);

    /**
     * RECENCY-CLOCK1 — a 180-day rolling rating changes as time passes with NO write at all.
     * Nothing else in the system notices that, which is why the reconciler's candidate set
     * includes clean-but-due listings.
     */
    it("RECENCY-CLOCK1: a CLEAN listing whose window boundary has passed is picked up with no workflow write", async () => {
      const { listingId, locationId } = await seedListing(T_A, "Clock Shop", "clock-shop");
      for (let i = 0; i < 10; i++) await insertCert(locationId, {});
      await life.markRatingDirty(admin, locationId);
      await life.refreshRatingAfterCommit(locationId, "test");

      const cleaned = await admin.query<{ dirty: boolean; next: Date | null }>(
        "SELECT rating_dirty AS dirty, rating_next_recalc_at AS next FROM partner_public_listings WHERE id=$1",
        [listingId]);
      expect(cleaned.rows[0].dirty, "precondition: the listing is clean").toBe(false);
      expect(cleaned.rows[0].next, "a successful calculation must schedule its own next look").not.toBeNull();

      // A clean listing whose boundary is still in the future must NOT be claimed — otherwise the
      // assertion below would pass because the reconciler simply picks up everything.
      //
      // Scoped to THIS listing, deliberately. The cluster is shared with every earlier test in this
      // suite, so an estate-wide `processed === 0` would be asserting something about other tests'
      // fixtures rather than about the clock, and would break whenever one of them was edited.
      await life.runRatingReconciler({ limit: 50, actor: "clock-idle" });
      const untouched = await admin.query<{ claimed: Date | null; success: Date | null }>(
        `SELECT rating_claimed_until AS claimed, rating_last_success_at AS success
           FROM partner_public_listings WHERE id = $1`, [listingId]);
      expect(untouched.rows[0].claimed, "a clean, not-yet-due listing must not be claimed").toBeNull();

      // Advance the clock, changing NOTHING else. No approval, no rejection, no write to any card.
      await admin.query("UPDATE partner_public_listings SET rating_next_recalc_at = now() - interval '1 minute' WHERE id=$1",
        [listingId]);

      await life.runRatingReconciler({ limit: 50, actor: "clock-due" });
      const after = await admin.query<{ success: Date | null; next: Date | null }>(
        `SELECT rating_last_success_at AS success, rating_next_recalc_at AS next
           FROM partner_public_listings WHERE id = $1`, [listingId]);
      // Recalculated: a fresh success timestamp, and a NEW boundary scheduled for next time.
      expect(after.rows[0].success, "a clean listing past its boundary must be recalculated").not.toBeNull();
      expect(
        (after.rows[0].next as Date).getTime(),
        "the refresh must schedule the next boundary, not leave it in the past",
      ).toBeGreaterThan(Date.now());
    }, 90_000);

    /**
     * The claim is DURABLE, which the previous FOR UPDATE SKIP LOCKED was not: that ran through a
     * bare pool.query, so PostgreSQL's implicit transaction released every row lock before the
     * first row was processed and two runners selected the SAME rows.
     */
    it("two concurrent reconcilers take DISJOINT work — no listing is processed twice", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { listingId, locationId } = await seedListing(T_A, `Concur ${i}`, `concur-${i}`);
        for (let c = 0; c < 10; c++) await insertCert(locationId, {});
        await life.markRatingDirty(admin, locationId);
        ids.push(listingId);
      }
      const [a, b] = await Promise.all([
        life.runRatingReconciler({ limit: 6, actor: "worker-a" }),
        life.runRatingReconciler({ limit: 6, actor: "worker-b" }),
      ]);
      // Disjoint: the two runs together must claim each listing AT MOST once.
      expect(a.processed + b.processed, "a listing was claimed by both workers").toBeLessThanOrEqual(6);
      // And between them they must actually do the work — a mutual exclusion that achieves
      // exclusion by doing nothing is not the property under test.
      const stillDirty = await admin.query<{ n: string }>(
        "SELECT count(*)::text n FROM partner_public_listings WHERE id = ANY($1::uuid[]) AND rating_dirty = true",
        [ids]);
      expect(Number(stillDirty.rows[0].n), "the estate must actually be reconciled").toBe(0);
    }, 120_000);
  });
});
