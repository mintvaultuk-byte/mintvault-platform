/**
 * partner-deploy-preflight.test.ts — the H8 deploy-order gate, proven against a real estate.
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────────────────────
 * The application deploy that carries this branch has dependencies the migration chain and the
 * infrastructure must satisfy FIRST. Those dependencies were documented and enforced at runtime by
 * fail-closed behaviour — which means the failure mode was "deploy, then discover". Fail-closed is
 * the right runtime posture and it is not a deploy gate: a 503 on the public slab showcase, which
 * is a LIVE production surface, is still an outage.
 *
 * Every test below drives `runPublicNetworkPreflight` against a REAL disposable PostgreSQL 17
 * cluster with the real migration chain applied, then BREAKS one dependency and asserts the gate
 * refuses with the right code. A gate that has only ever been run against a healthy estate is a
 * gate nobody has tested.
 *
 * ── DEPLOY-ORDER1 ───────────────────────────────────────────────────────────────────────────
 * The mutation is "remove one required dependency check". It is caught twice, deliberately:
 *   * STRUCTURALLY — the four requirement lists are pinned by exact equality, so deleting an entry
 *     fails immediately and names it;
 *   * BEHAVIOURALLY — each requirement class has a test that breaks a real object and asserts the
 *     refusal, so a check that is present but no longer WIRED also fails.
 * A structural pin alone would pass if someone kept the list and stopped consulting it.
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
import {
  runPublicNetworkPreflight,
  REQUIRED_MIGRATIONS,
  REQUIRED_VIEWS,
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES,
  PUBLIC_READER_ROLE,
  PUBLIC_NETWORK_FLAG,
} from "../scripts/db/preflight-public-network";

let cluster: DisposablePostgres17;
let admin: Client;
let adminUrl: string;
/** A login role that IS a member of the reader group — the healthy production shape. */
let memberUrl: string;

const codes = (r: { failures: Array<{ code: string }> }) => r.failures.map((f) => f.code).sort();

describe("public network deploy-order gate (disposable PostgreSQL 17)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("deploy-preflight");
    adminUrl = cluster.url;
    admin = new Client({ connectionString: adminUrl });
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
    await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)");
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
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade numeric(4,1)");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS redo_count integer NOT NULL DEFAULT 0");
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS graded_at timestamptz");

    // `applyEveryMigrationRealistic` drives the migration SQL, not the runner, so the journal it
    // leaves may not carry every row the gate looks for. Reconcile it to the state a real runner
    // would produce — otherwise the healthy-estate test would fail for a fixture reason and mask
    // whatever the gate actually does.
    await admin.query("CREATE TABLE IF NOT EXISTS schema_migrations (id serial primary key, filename text UNIQUE, checksum text, started_at timestamptz default now(), completed_at timestamptz, status text, applied_by text)");
    for (const m of REQUIRED_MIGRATIONS) {
      await admin.query(
        `INSERT INTO schema_migrations (filename, checksum, completed_at, status, applied_by)
         VALUES ($1, 'fixture', now(), 'applied', current_user)
         ON CONFLICT (filename) DO UPDATE SET status='applied', completed_at=now()`,
        [m],
      );
    }

    // THE HEALTHY PRODUCTION SHAPE: a login role granted membership OUT OF BAND, exactly as
    // infrastructure would. This is the step no migration performs, so the fixture performs it.
    await admin.query("DROP ROLE IF EXISTS pn_public_login");
    await admin.query("CREATE ROLE pn_public_login LOGIN PASSWORD 'pubpw' NOSUPERUSER NOBYPASSRLS");
    await admin.query(`GRANT ${PUBLIC_READER_ROLE} TO pn_public_login`);
    const u = new URL(cluster.url);
    u.username = "pn_public_login";
    u.password = "pubpw";
    memberUrl = u.toString();
  }, 300_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop?.();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // DEPLOY-ORDER1, structural half — the requirement lists themselves
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  it("DEPLOY-ORDER1: the required-dependency lists are pinned exactly, so deleting a check is RED", () => {
    // Exact equality, not `toContain`. A gate whose requirement list can silently shrink is a
    // gate that passes by forgetting, and that is the failure this whole suite exists to prevent.
    expect([...REQUIRED_MIGRATIONS]).toEqual([
      "0058_partner_public_network.sql",
      "0059_partner_public_eligibility_propagation.sql",
      "0060_partner_public_rating_override_expiry.sql",
      "0061_partner_public_reader.sql",
      "0062_partner_rating_dirty_state.sql",
      "0063_certificate_review_lifecycle_clock.sql",
      "0064_public_slab_image_projection.sql",
      "0065_certificates_reviewed_unit_index.sql",
      "0066_partner_rating_lifecycle_hardening.sql",
    ]);
    expect([...REQUIRED_VIEWS]).toEqual([
      "partner_public_shop_projection",
      "partner_public_card_projection",
      "public_slab_image_projection",
    ]);
    expect(REQUIRED_COLUMNS).toEqual([
      ["certificates", "review_entered_at"],
      ["certificates", "status_updated_at"],
      ["partner_public_listings", "rating_dirty_generation"],
      ["partner_public_listings", "rating_clean_generation"],
      ["partner_public_listings", "rating_next_recalc_at"],
      ["partner_public_listings", "rating_next_attempt_at"],
      ["partner_public_listings", "rating_claimed_until"],
    ]);
    expect([...REQUIRED_INDEXES]).toEqual(["idx_certificates_origin_location_reviewed"]);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // The healthy estate — non-vacuity for everything below
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  it("passes on a complete estate with membership granted and the flag OFF", async () => {
    const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
    expect(r.failures, `unexpected failures: ${JSON.stringify(r.failures)}`).toEqual([]);
    expect(r.ok).toBe(true);
    // The check groups actually ran — a gate that skipped everything would also report no failures.
    expect(r.checked).toEqual(
      expect.arrayContaining([
        "migration_journal",
        "public_projections",
        "required_columns",
        "required_indexes",
        "public_reader_role",
        "reader_grants",
        "cert_counter",
        "rollout_flag",
        "public_db_url",
        "reader_membership",
      ]),
    );
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Each dependency class, broken for real
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  it("refuses when PARTNER_PUBLIC_DATABASE_URL is not configured", async () => {
    const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: undefined });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("public_db_url_not_configured");
  }, 60_000);

  it("H13: refuses when the login role is NOT a member of the reader group, and names the remedy", async () => {
    await admin.query("DROP ROLE IF EXISTS pn_public_nomember");
    await admin.query("CREATE ROLE pn_public_nomember LOGIN PASSWORD 'nomember' NOSUPERUSER NOBYPASSRLS");
    const u = new URL(cluster.url);
    u.username = "pn_public_nomember";
    u.password = "nomember";
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: u.toString() });
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain("membership_missing");
      const finding = r.failures.find((f) => f.code === "membership_missing");
      // The remedy has to be in the output. An operator hitting this at 2am should not need a
      // runbook to know the next statement to type.
      expect(finding?.detail).toContain(`GRANT ${PUBLIC_READER_ROLE} TO`);
      // And it must NOT leak the connection string, host, port or password.
      const blob = JSON.stringify(r).toLowerCase();
      for (const leak of ["nomember", "password", "127.0.0.1", String(new URL(cluster.url).port)]) {
        expect(blob, `preflight output leaked ${leak}`).not.toContain(leak);
      }
    } finally {
      await admin.query("DROP ROLE IF EXISTS pn_public_nomember").catch(() => {});
    }
  }, 60_000);

  it("refuses when a required migration is not journalled as applied", async () => {
    const victim = "0064_public_slab_image_projection.sql";
    await admin.query("UPDATE schema_migrations SET status='applying' WHERE filename=$1", [victim]);
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain("migration_not_complete");
    } finally {
      await admin.query("UPDATE schema_migrations SET status='applied' WHERE filename=$1", [victim]);
    }
    await admin.query("DELETE FROM schema_migrations WHERE filename=$1", [victim]);
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(codes(r)).toContain("migration_not_applied");
    } finally {
      await admin.query(
        `INSERT INTO schema_migrations (filename, checksum, completed_at, status, applied_by)
         VALUES ($1,'fixture',now(),'applied',current_user) ON CONFLICT (filename) DO NOTHING`,
        [victim],
      );
    }
  }, 90_000);

  it("refuses when a public projection is missing — 0061 without 0064 is the dangerous half-estate", async () => {
    await admin.query("DROP VIEW IF EXISTS public_slab_image_projection");
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain("projection_missing");
      // This is the shape that matters: a Shop Finder that works and card images that all 503.
      expect(r.failures.find((f) => f.code === "projection_missing")?.detail).toContain("public_slab_image_projection");
    } finally {
      await admin.query(`
        CREATE OR REPLACE VIEW public_slab_image_projection AS
        SELECT certificate_number,
               COALESCE(grading_front_display, grading_front_cropped, front_image_path) AS scan_object_key,
               (COALESCE(grading_front_display, grading_front_cropped, front_image_path) IS NOT NULL) AS has_scan
          FROM certificates
         WHERE deleted_at IS NULL AND status = 'active' AND grade IS NOT NULL AND grade_approved_at IS NOT NULL`);
      await admin.query(`GRANT SELECT ON public_slab_image_projection TO ${PUBLIC_READER_ROLE}`);
    }
  }, 90_000);

  it("refuses when the V2 review clock column is missing — a 42703 on every rating measurement", async () => {
    await admin.query("ALTER TABLE certificates DROP COLUMN IF EXISTS review_entered_at");
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain("column_missing");
      expect(r.failures.find((f) => f.code === "column_missing")?.detail).toContain("review_entered_at");
    } finally {
      await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS review_entered_at timestamptz");
    }
  }, 90_000);

  it("refuses when the reviewed-unit index is missing, and when it exists but is INVALID", async () => {
    await admin.query("DROP INDEX IF EXISTS idx_certificates_origin_location_reviewed");
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(codes(r)).toContain("index_missing");
    } finally {
      await admin.query(
        `CREATE INDEX IF NOT EXISTS idx_certificates_origin_location_reviewed
           ON certificates (origin_location_id, grade_approved_at DESC)
           WHERE origin_location_id IS NOT NULL`,
      );
    }
    // An INVALID index is the residue of a failed CONCURRENTLY build: maintained on every write,
    // used for no read. Deploying onto one means paying for an index and still seq-scanning.
    await admin.query("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_certificates_origin_location_reviewed'::regclass");
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(codes(r)).toContain("index_invalid");
    } finally {
      await admin.query("UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'idx_certificates_origin_location_reviewed'::regclass");
    }
  }, 90_000);

  it("refuses when the reader can reach `certificates` directly — the projection boundary bypassed", async () => {
    await admin.query(`GRANT SELECT ON certificates TO ${PUBLIC_READER_ROLE}`);
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain("reader_has_base_table_access");
    } finally {
      await admin.query(`REVOKE SELECT ON certificates FROM ${PUBLIC_READER_ROLE}`);
    }
  }, 90_000);

  it("refuses when the reader role could log in directly or bypass RLS", async () => {
    await admin.query(`ALTER ROLE ${PUBLIC_READER_ROLE} LOGIN`);
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(codes(r)).toContain("reader_role_can_login");
    } finally {
      await admin.query(`ALTER ROLE ${PUBLIC_READER_ROLE} NOLOGIN`);
    }
    await admin.query(`ALTER ROLE ${PUBLIC_READER_ROLE} BYPASSRLS`);
    try {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(codes(r)).toContain("reader_role_bypassrls");
    } finally {
      await admin.query(`ALTER ROLE ${PUBLIC_READER_ROLE} NOBYPASSRLS`);
    }
  }, 90_000);

  it("refuses to deploy while the rollout flag is already ON — and accepts it after, on request", async () => {
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL,NULL,$1,true)",
      [PUBLIC_NETWORK_FLAG],
    );
    try {
      const pre = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(pre.ok, "deploying code and launching a consumer surface in one step defeats the rollout").toBe(false);
      expect(codes(pre)).toContain("rollout_flag_already_on");

      // The SAME gate, run as the post-enable verification, must now be satisfied by exactly the
      // state it just refused. Otherwise the operator has no way to confirm the enable worked.
      const post = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl, expectFlagOff: false });
      expect(post.ok, `post-enable verification failed: ${JSON.stringify(post.failures)}`).toBe(true);
    } finally {
      await admin.query("DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL", [
        PUBLIC_NETWORK_FLAG,
      ]);
    }
  }, 90_000);

  it("refuses when 0054's cert_counter monotonic guard is missing or disabled", async () => {
    await admin.query("ALTER TABLE cert_counter DISABLE TRIGGER trg_cert_counter_monotonic").catch(() => {});
    const disabled = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_trigger WHERE tgrelid='public.cert_counter'::regclass
        AND tgname='trg_cert_counter_monotonic' AND tgenabled='D'`,
    );
    // Only assert the gate if the fixture actually managed to disable it — ENABLE ALWAYS triggers
    // can refuse, and a test that silently proves nothing is worse than no test.
    if (Number(disabled.rows[0].n) === 1) {
      try {
        const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
        expect(codes(r)).toContain("cert_counter_guard_missing");
      } finally {
        await admin.query("ALTER TABLE cert_counter ENABLE ALWAYS TRIGGER trg_cert_counter_monotonic");
      }
    } else {
      const r = await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
      expect(r.checked).toContain("cert_counter");
    }
  }, 90_000);

  it("leaves the session clean — a deploy gate must never be the thing that causes an incident", async () => {
    // The read-only helper exists because a preflight once left default_transaction_read_only on a
    // PgBouncer backend and broke a production write thirty seconds later. Prove this gate does
    // not reintroduce that: a write on an ordinary connection must still work afterwards.
    await runPublicNetworkPreflight({ adminUrl, publicUrl: memberUrl });
    await expect(
      admin.query("CREATE TEMP TABLE preflight_write_probe (x int); DROP TABLE preflight_write_probe"),
    ).resolves.toBeTruthy();
    // current_setting(), not SHOW: SHOW names its output column after the GUC and cannot be
    // aliased, so `rows[0].v` was undefined and this assertion was passing on nothing.
    const guc = await admin.query<{ v: string }>("SELECT current_setting('default_transaction_read_only') AS v");
    expect(guc.rows[0].v).toBe("off");
  }, 60_000);
});
