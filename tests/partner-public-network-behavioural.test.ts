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
});
