/**
 * 0058 — Public Partner Network: schema, RLS and grant proof on a real PostgreSQL 17.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM partner-rollback-integrity.test.ts: that suite proves the
 * round trip (apply -> rollback -> unprompted re-apply -> no residue). This one proves the
 * SEMANTICS — that the structures 0058 installs actually enforce what the public network depends
 * on. A migration that applies cleanly but whose policies admit the wrong reader is a migration
 * that passes CI and leaks in production.
 *
 * The four properties that would each be a silent, HTTP-200-shaped failure if they regressed:
 *
 *   1. An ANONYMOUS reader (partner_runtime, no app.tenant_id) can read ACTIVE listings and
 *      NOTHING else. If the public read policy were dropped, the finder would return an empty
 *      array forever with no error anywhere — see the FINDER2 mutation.
 *   2. A partner can update ONLY the safe contact columns. The enforcement is a column-level
 *      GRANT, not a route allowlist, so it must be asserted at the database.
 *   3. A rating can never be published below its minimum sample, and an unavailable rating can
 *      never carry a number. Asserted on BOTH the snapshot history and the denormalised
 *      current-rating columns, because a disagreement between them is the fabrication route.
 *   4. Overrides are entirely unreachable by partner_runtime — the table carries a Super Admin's
 *      written rationale.
 *
 * Uses its own disposable PostgreSQL 17 cluster (startPostgres17), so it needs no env var and can
 * never skip silently.
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
} from "./helpers/partner-realistic-db";

let cluster: DisposablePostgres17;
let admin: Client;

/** Tenant/location/listing ids, fixed so every assertion targets an exact row. */
const T_A = "aaaa0000-0000-0000-0000-00000000aa01";
const T_B = "bbbb0000-0000-0000-0000-00000000bb01";

/**
 * Run as partner_runtime with an explicit tenant GUC, or with NO tenant at all.
 *
 * `tenant: null` is the ANONYMOUS public case and is the one that matters most: it RESETs the GUC
 * rather than leaving whatever a previous statement set, so the test cannot accidentally pass by
 * inheriting context.
 */
async function asRuntime<T>(tenant: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: cluster.url });
  await c.connect();
  try {
    await c.query("SET ROLE partner_runtime");
    if (tenant) await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
    else await c.query("RESET app.tenant_id");
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function seedListing(
  tenantId: string,
  locationName: string,
  slug: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<{ listingId: string; locationId: string }> {
  const loc = await admin.query<{ id: string }>(
    "INSERT INTO partner_locations (tenant_id, partner_id, name) VALUES ($1,$1,$2) RETURNING id",
    [tenantId, locationName],
  );
  const locationId = loc.rows[0].id;
  const approved = status === "ACTIVE";
  const cols = ["tenant_id", "location_id", "slug", "public_display_name", "listing_status"];
  const vals: unknown[] = [tenantId, locationId, slug, locationName, "DRAFT"];
  for (const [k, v] of Object.entries(extra)) {
    cols.push(k);
    vals.push(v);
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(",");
  const ins = await admin.query<{ id: string }>(
    `INSERT INTO partner_public_listings (${cols.join(",")}) VALUES (${ph}) RETURNING id`,
    vals,
  );
  const listingId = ins.rows[0].id;
  if (status !== "DRAFT") {
    // Walk the legal transition path; the ENABLE ALWAYS trigger refuses shortcuts.
    await admin.query("UPDATE partner_public_listings SET listing_status='PENDING_REVIEW' WHERE id=$1", [listingId]);
    if (approved || status === "PAUSED" || status === "SUSPENDED") {
      await admin.query(
        `UPDATE partner_public_listings
            SET listing_status='ACTIVE', approved_at=now(), approved_by='hq@test', public_since=now()
          WHERE id=$1`,
        [listingId],
      );
      if (status !== "ACTIVE") {
        await admin.query("UPDATE partner_public_listings SET listing_status=$2 WHERE id=$1", [listingId, status]);
      }
    }
  }
  return { listingId, locationId };
}

describe("0058 — public partner network schema, RLS and grants (disposable PostgreSQL 17)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-public-network-migration");
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

    await admin.query("INSERT INTO partner_organisations (id, legal_name) VALUES ($1,'Tenant A')", [T_A]);
    await admin.query("INSERT INTO partner_organisations (id, legal_name) VALUES ($1,'Tenant B')", [T_B]);
  }, 300_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // -------------------------------------------------------------------------------------------
  describe("structure", () => {
    it("journals 0058 as applied", async () => {
      const { rows } = await admin.query(
        "SELECT status FROM schema_migrations WHERE filename='0058_partner_public_network.sql'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
    });

    it("enables AND forces RLS on all three tables", async () => {
      const { rows } = await admin.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace='public'::regnamespace
            AND relname IN ('partner_public_listings','partner_public_rating_snapshots','partner_public_rating_overrides')
          ORDER BY relname`,
      );
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.relrowsecurity, `${r.relname} RLS`).toBe(true);
        // FORCE is what makes the policies bind the table OWNER too. Without it a migration-owner
        // session silently sees everything and this suite would certify isolation it does not have.
        expect(r.relforcerowsecurity, `${r.relname} FORCE`).toBe(true);
      }
    });

    it("installs the state-transition trigger as ENABLE ALWAYS", async () => {
      // 'A', not the default 'O': a default trigger does not fire under
      // session_replication_role='replica', so a suspended shop could be flipped back to ACTIVE.
      const { rows } = await admin.query(
        `SELECT tgenabled FROM pg_trigger
          WHERE tgname='trg_partner_public_listing_transition'
            AND tgrelid='public.partner_public_listings'::regclass`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tgenabled).toBe("A");
    });

    it("creates the recent-cards index on certificates without touching any certificate column", async () => {
      expect(
        (await admin.query("SELECT to_regclass('public.idx_certificates_origin_location_recent') IS NOT NULL ok"))
          .rows[0].ok,
      ).toBe(true);
      // 0035's index and immutability trigger must be exactly as they were.
      expect(
        (await admin.query("SELECT to_regclass('public.idx_certificates_origin_partner') IS NOT NULL ok")).rows[0].ok,
      ).toBe(true);
      expect(
        (
          await admin.query(
            `SELECT count(*)::int n FROM pg_trigger WHERE tgname='trg_certificates_origin_immutable'`,
          )
        ).rows[0].n,
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("postcode normalisation is done by the database, not the application", () => {
    // A normaliser that lives only in TypeScript is one missed call site away from an unsearchable
    // listing, and the finder fails SILENTLY (empty result, HTTP 200).
    const CASES: Array<[string, string, string | null]> = [
      ["ME2 2NG", "ME22NG", "ME2"],
      ["me22ng", "ME22NG", "ME2"],
      ["ME2-2NG", "ME22NG", "ME2"],
      ["SW1A 1AA", "SW1A1AA", "SW1A"],
      ["m1 1ae", "M11AE", "M1"],
      ["B33 8TH", "B338TH", "B33"],
      // Outward-only input is not a full postcode; it yields NULL rather than a plausible-looking
      // fragment. An unsearchable listing is recoverable; a wrongly-placed one is not.
      ["ME2", "ME2", null],
    ];

    it.each(CASES)("normalises %s -> %s / outward %s", async (raw, normalised, outward) => {
      const loc = await admin.query<{ id: string }>(
        "INSERT INTO partner_locations (tenant_id, partner_id, name) VALUES ($1,$1,'PC') RETURNING id",
        [T_A],
      );
      const { rows } = await admin.query(
        `INSERT INTO partner_public_listings (tenant_id, location_id, slug, public_display_name, postcode)
         VALUES ($1,$2,$3,'PC Shop',$4)
         RETURNING postcode_normalised, postcode_outward`,
        [T_A, loc.rows[0].id, `pc-${raw.toLowerCase().replace(/[^a-z0-9]/g, "")}-${Date.now()}`, raw],
      );
      expect(rows[0].postcode_normalised).toBe(normalised);
      expect(rows[0].postcode_outward).toBe(outward);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("anonymous public read", () => {
    it("returns ACTIVE listings and excludes every other status", async () => {
      await seedListing(T_A, "Strood Cards", "anon-strood", "ACTIVE");
      await seedListing(T_A, "Paused Shop", "anon-paused", "PAUSED");
      await seedListing(T_A, "Suspended Shop", "anon-suspended", "SUSPENDED");
      await seedListing(T_A, "Draft Shop", "anon-draft", "DRAFT");

      const slugs = await asRuntime(null, async (c) => {
        const { rows } = await c.query<{ slug: string }>(
          "SELECT slug FROM partner_public_listings WHERE slug LIKE 'anon-%' ORDER BY slug",
        );
        return rows.map((r) => r.slug);
      });

      // FINDER1 / FINDER2: a suspended or unapproved shop must never reach the public surface.
      expect(slugs).toEqual(["anon-strood"]);
    });

    it("cannot read rating snapshots or overrides at all", async () => {
      // Snapshots carry only a tenant-scoped policy, and overrides carry no partner grant at all.
      // This is exactly WHY the current effective rating is denormalised onto the listing row.
      const snapshotErr = await asRuntime(null, async (c) => {
        const { rows } = await c.query("SELECT count(*)::int n FROM partner_public_rating_snapshots");
        return rows[0].n;
      });
      expect(snapshotErr).toBe(0);

      await expect(
        asRuntime(null, (c) => c.query("SELECT count(*) FROM partner_public_rating_overrides")),
      ).rejects.toThrow(/permission denied/i);
    });

    it("serves the current rating from the listing row, so no join to snapshots is needed", async () => {
      const { listingId } = await seedListing(T_A, "Rated Shop", "anon-rated", "ACTIVE");
      await admin.query(
        `UPDATE partner_public_listings
            SET current_rating_version='PARTNER_QUALITY_V1', current_public_rating=4.5,
                current_rating_label='Excellent', current_rating_available=true,
                current_sample_size=24, current_minimum_sample=10, current_rating_calculated_at=now()
          WHERE id=$1`,
        [listingId],
      );
      const row = await asRuntime(null, async (c) => {
        const { rows } = await c.query(
          "SELECT current_public_rating, current_rating_label, current_rating_available, current_sample_size FROM partner_public_listings WHERE slug='anon-rated'",
        );
        return rows[0];
      });
      expect(Number(row.current_public_rating)).toBe(4.5);
      expect(row.current_rating_label).toBe("Excellent");
      expect(row.current_rating_available).toBe(true);
      expect(row.current_sample_size).toBe(24);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("a rating can never be fabricated", () => {
    it("refuses a published rating below the minimum sample (RATING3)", async () => {
      const { listingId } = await seedListing(T_A, "LowSample", "rating-lowsample", "ACTIVE");
      await expect(
        admin.query(
          `UPDATE partner_public_listings
              SET current_rating_version='V1', current_public_rating=5.0, current_rating_label='Exceptional',
                  current_rating_available=true, current_sample_size=1, current_minimum_sample=10
            WHERE id=$1`,
          [listingId],
        ),
      ).rejects.toThrow(/chk_partner_public_listings_current_rating/);
    });

    it("refuses an unavailable rating that still carries a number (RATING2)", async () => {
      const { listingId } = await seedListing(T_A, "Unavail", "rating-unavail", "ACTIVE");
      await expect(
        admin.query(
          `UPDATE partner_public_listings
              SET current_public_rating=5.0, current_rating_available=false
            WHERE id=$1`,
          [listingId],
        ),
      ).rejects.toThrow(/chk_partner_public_listings_current_rating/);
    });

    it("refuses the same two shapes on the snapshot history", async () => {
      const { listingId, locationId } = await seedListing(T_A, "SnapGuard", "rating-snapguard", "ACTIVE");
      const base = `INSERT INTO partner_public_rating_snapshots
        (tenant_id, listing_id, location_id, rating_version, internal_score, public_rating,
         rating_label, rating_available, sample_size, minimum_sample)`;
      await expect(
        admin.query(`${base} VALUES ($1,$2,$3,'V1',90,4.5,'Excellent',true,3,10)`, [T_A, listingId, locationId]),
      ).rejects.toThrow(/chk_partner_public_rating_snapshots_availability/);
      await expect(
        admin.query(`${base} VALUES ($1,$2,$3,'V1',90,4.5,'Excellent',false,30,10)`, [T_A, listingId, locationId]),
      ).rejects.toThrow(/chk_partner_public_rating_snapshots_availability/);
      // …and accepts the honest low-sample shape.
      await expect(
        admin.query(`${base} VALUES ($1,$2,$3,'V1',NULL,NULL,'Rating building',false,3,10)`, [
          T_A,
          listingId,
          locationId,
        ]),
      ).resolves.toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("partner write surface is bounded by column GRANT, not by a route handler", () => {
    it("permits exactly the safe self-service columns", async () => {
      for (const c of [
        "public_phone",
        "public_email",
        "public_website",
        "public_opening_info",
        "public_description",
      ]) {
        const { rows } = await admin.query(
          "SELECT has_column_privilege('partner_runtime','public.partner_public_listings',$1,'UPDATE') ok",
          [c],
        );
        expect(rows[0].ok, `partner_runtime should UPDATE ${c}`).toBe(true);
      }
    });

    it("forbids every HQ-owned column, including the rating", async () => {
      for (const c of [
        "listing_status",
        "slug",
        "latitude",
        "longitude",
        "postcode",
        "town_city",
        "county",
        "address_line_1",
        "public_display_name",
        "verified_at",
        "approved_by",
        "public_since",
        "current_public_rating",
        "current_rating_available",
        "current_sample_size",
      ]) {
        const { rows } = await admin.query(
          "SELECT has_column_privilege('partner_runtime','public.partner_public_listings',$1,'UPDATE') ok",
          [c],
        );
        expect(rows[0].ok, `partner_runtime must NOT UPDATE ${c}`).toBe(false);
      }
    });

    it("rejects a partner's attempt to self-activate at the database (not just in a handler)", async () => {
      const { listingId } = await seedListing(T_A, "SelfActivate", "grant-selfactivate", "PAUSED");
      await expect(
        asRuntime(T_A, (c) =>
          c.query("UPDATE partner_public_listings SET listing_status='ACTIVE' WHERE id=$1", [listingId]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it("rejects a partner's attempt to set its own rating or card count (RATING1 / COUNT1)", async () => {
      const { listingId } = await seedListing(T_A, "SelfRate", "grant-selfrate", "ACTIVE");
      await expect(
        asRuntime(T_A, (c) =>
          c.query("UPDATE partner_public_listings SET current_public_rating=5.0 WHERE id=$1", [listingId]),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asRuntime(T_A, (c) =>
          c.query("UPDATE partner_public_listings SET current_sample_size=9999 WHERE id=$1", [listingId]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it("has no INSERT or DELETE grant for partner_runtime on any public-network table", async () => {
      for (const t of ["partner_public_listings", "partner_public_rating_snapshots"]) {
        for (const p of ["INSERT", "DELETE"]) {
          const { rows } = await admin.query(
            `SELECT has_table_privilege('partner_runtime','public.${t}',$1) ok`,
            [p],
          );
          expect(rows[0].ok, `${t} ${p}`).toBe(false);
        }
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const { rows } = await admin.query(
          "SELECT has_table_privilege('partner_runtime','public.partner_public_rating_overrides',$1) ok",
          [p],
        );
        expect(rows[0].ok, `overrides ${p}`).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("tenant isolation (TENANT1)", () => {
    it("lets a partner update its own listing's safe fields", async () => {
      const { listingId } = await seedListing(T_A, "OwnEdit", "tenant-ownedit", "ACTIVE");
      const r = await asRuntime(T_A, (c) =>
        c.query("UPDATE partner_public_listings SET public_phone='01634 000000' WHERE id=$1", [listingId]),
      );
      expect(r.rowCount).toBe(1);
    });

    it("silently matches ZERO rows when tenant A edits tenant B's listing", async () => {
      const { listingId } = await seedListing(T_B, "BShop", "tenant-bshop", "ACTIVE");
      // RLS makes this a no-op rather than an error — which is why the service layer must treat
      // rowCount 0 as a failure and never report success.
      const r = await asRuntime(T_A, (c) =>
        c.query("UPDATE partner_public_listings SET public_phone='hijacked' WHERE id=$1", [listingId]),
      );
      expect(r.rowCount).toBe(0);
      const after = await admin.query("SELECT public_phone FROM partner_public_listings WHERE id=$1", [listingId]);
      expect(after.rows[0].public_phone).toBeNull();
    });

    it("prevents a listing pointing at another tenant's location", async () => {
      const loc = await admin.query<{ id: string }>(
        "INSERT INTO partner_locations (tenant_id, partner_id, name) VALUES ($1,$1,'B only') RETURNING id",
        [T_B],
      );
      await expect(
        admin.query(
          `INSERT INTO partner_public_listings (tenant_id, location_id, slug, public_display_name)
           VALUES ($1,$2,'tenant-cross','Cross')`,
          [T_A, loc.rows[0].id],
        ),
      ).rejects.toThrow(/fk_partner_public_listings_location_tenant/);
    });

    it("cannot read another tenant's non-ACTIVE listing", async () => {
      await seedListing(T_B, "B Draft", "tenant-bdraft", "DRAFT");
      const n = await asRuntime(T_A, async (c) => {
        const { rows } = await c.query<{ n: number }>(
          "SELECT count(*)::int n FROM partner_public_listings WHERE slug='tenant-bdraft'",
        );
        return rows[0].n;
      });
      expect(n).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("slug and lifecycle invariants", () => {
    it("refuses a duplicate slug across tenants (SLUG1)", async () => {
      await seedListing(T_A, "SlugOne", "slug-contested", "ACTIVE");
      await expect(seedListing(T_B, "SlugTwo", "slug-contested", "DRAFT")).rejects.toThrow(
        /uq_partner_public_listings_slug/,
      );
    });

    it("freezes the slug once published", async () => {
      const { listingId } = await seedListing(T_A, "SlugFrozen", "slug-frozen", "ACTIVE");
      await expect(
        admin.query("UPDATE partner_public_listings SET slug='slug-frozen-moved' WHERE id=$1", [listingId]),
      ).rejects.toThrow(/slug is immutable once the listing has been published/);
    });

    it("allows a slug change before first activation", async () => {
      const { listingId } = await seedListing(T_A, "SlugDraft", "slug-draft", "DRAFT");
      const r = await admin.query("UPDATE partner_public_listings SET slug='slug-draft-renamed' WHERE id=$1", [
        listingId,
      ]);
      expect(r.rowCount).toBe(1);
    });

    it("refuses an illegal state transition", async () => {
      const { listingId } = await seedListing(T_A, "Removed", "state-removed", "DRAFT");
      await admin.query("UPDATE partner_public_listings SET listing_status='REMOVED' WHERE id=$1", [listingId]);
      await expect(
        admin.query("UPDATE partner_public_listings SET listing_status='ACTIVE' WHERE id=$1", [listingId]),
      ).rejects.toThrow(/illegal listing_status transition REMOVED -> ACTIVE/);
    });

    it("refuses ACTIVE without an approval record", async () => {
      const loc = await admin.query<{ id: string }>(
        "INSERT INTO partner_locations (tenant_id, partner_id, name) VALUES ($1,$1,'NoApproval') RETURNING id",
        [T_A],
      );
      await expect(
        admin.query(
          `INSERT INTO partner_public_listings (tenant_id, location_id, slug, public_display_name, listing_status)
           VALUES ($1,$2,'state-noapproval','No Approval','ACTIVE')`,
          [T_A, loc.rows[0].id],
        ),
      ).rejects.toThrow(/chk_partner_public_listings_active_requires_approval/);
    });

    it("keeps public_since set-once across a pause/resume cycle", async () => {
      const { listingId } = await seedListing(T_A, "Resumed", "state-resumed", "ACTIVE");
      await expect(
        admin.query("UPDATE partner_public_listings SET public_since=now() + interval '1 day' WHERE id=$1", [
          listingId,
        ]),
      ).rejects.toThrow(/public_since is set-once/);
    });

    it("refuses to re-point a listing at a different location", async () => {
      const { listingId } = await seedListing(T_A, "Repoint", "state-repoint", "ACTIVE");
      const other = await admin.query<{ id: string }>(
        "INSERT INTO partner_locations (tenant_id, partner_id, name) VALUES ($1,$1,'Other') RETURNING id",
        [T_A],
      );
      await expect(
        admin.query("UPDATE partner_public_listings SET location_id=$2 WHERE id=$1", [listingId, other.rows[0].id]),
      ).rejects.toThrow(/tenant_id\/location_id are immutable/);
    });

    it("refuses coordinates supplied as only one half of a pair", async () => {
      const loc = await admin.query<{ id: string }>(
        "INSERT INTO partner_locations (tenant_id, partner_id, name) VALUES ($1,$1,'HalfCoord') RETURNING id",
        [T_A],
      );
      // Treating the missing half as 0 would drop the shop in the Gulf of Guinea.
      await expect(
        admin.query(
          `INSERT INTO partner_public_listings (tenant_id, location_id, slug, public_display_name, latitude)
           VALUES ($1,$2,'state-halfcoord','Half',51.39)`,
          [T_A, loc.rows[0].id],
        ),
      ).rejects.toThrow(/chk_partner_public_listings_coordinate_pair/);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("override integrity (OVERRIDE1)", () => {
    it("allows at most one active override per listing", async () => {
      const { listingId } = await seedListing(T_A, "OverrideShop", "override-shop", "ACTIVE");
      const ins = `INSERT INTO partner_public_rating_overrides
        (tenant_id, listing_id, override_public_rating, override_rating_label, reason, created_by)
        VALUES ($1,$2,4.9,'Exceptional','Manual QA review','hq@test')`;
      await admin.query(ins, [T_A, listingId]);
      await expect(admin.query(ins, [T_A, listingId])).rejects.toThrow(
        /uq_partner_public_rating_overrides_active/,
      );
      // Retiring the first frees the slot; the retired row stays as history.
      await admin.query(
        `UPDATE partner_public_rating_overrides
            SET removed_at=now(), removed_by='hq@test', removal_reason='superseded'
          WHERE listing_id=$1 AND removed_at IS NULL`,
        [listingId],
      );
      await expect(admin.query(ins, [T_A, listingId])).resolves.toBeTruthy();
    });

    it("requires a reason, and requires a removal to name who and why", async () => {
      const { listingId } = await seedListing(T_A, "OverrideGuard", "override-guard", "ACTIVE");
      await expect(
        admin.query(
          `INSERT INTO partner_public_rating_overrides
             (tenant_id, listing_id, override_public_rating, reason, created_by)
           VALUES ($1,$2,4.9,'   ','hq@test')`,
          [T_A, listingId],
        ),
      ).rejects.toThrow(/chk_partner_public_rating_overrides_reason_present/);

      await admin.query(
        `INSERT INTO partner_public_rating_overrides
           (tenant_id, listing_id, override_public_rating, reason, created_by)
         VALUES ($1,$2,4.9,'Documented','hq@test')`,
        [T_A, listingId],
      );
      await expect(
        admin.query("UPDATE partner_public_rating_overrides SET removed_at=now() WHERE listing_id=$1", [listingId]),
      ).rejects.toThrow(/chk_partner_public_rating_overrides_removal_pair/);
    });

    it("requires an override to actually override something", async () => {
      const { listingId } = await seedListing(T_A, "OverrideNoop", "override-noop", "ACTIVE");
      await expect(
        admin.query(
          `INSERT INTO partner_public_rating_overrides (tenant_id, listing_id, reason, created_by)
           VALUES ($1,$2,'no effect','hq@test')`,
          [T_A, listingId],
        ),
      ).rejects.toThrow(/chk_partner_public_rating_overrides_has_effect/);
    });
  });
});
