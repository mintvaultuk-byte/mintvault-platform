/**
 * FORWARD-ONLY LINEAGE CONVERGENCE — three-lineage proof for migration 0073.
 *
 * MintVault's migration history forked into three incompatible lineages that each
 * applied a DIFFERENT migration into the same numeric slots (0045-0048). The owner
 * decision is forward-only: applied journal rows are immutable, and convergence
 * happens through a NEW migration at the next globally free number.
 *
 * This suite builds three disposable databases shaped like the real lineages,
 * applies the SAME 0073 file to each, and asserts all three finish at ONE canonical
 * target. It also pins the migration identity guard, which is what stops a
 * colliding historical migration ever being applied into an occupied slot again.
 *
 * Lineage shapes are derived from read-only inspection of the real hosts on
 * 2026-08-11 — production: 169 certificate columns, no grading_revision, partner
 * RBAC seeded, MFA projection present; staging: grading_revision already added by
 * its own 0071 plus a CHECK constraint, same partner state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { CERTIFICATES_PROTECTED_COLUMNS_SQL } from "./helpers/certificates-protected-columns";

const MIGRATION_0073 = readFileSync("migrations/0073_lineage_convergence.sql", "utf8");

let cluster: DisposablePostgres17;
type Lineage = "production" | "staging" | "fresh";
const pools: Record<Lineage, pg.Pool> = {} as Record<Lineage, pg.Pool>;

/** The certificate shell every lineage shares, before its lineage-specific parts. */
const BASE_CERTIFICATES = `
  CREATE TABLE certificates (
    id serial PRIMARY KEY,
    certificate_number text,
    cert_id text,
    status text,
    deleted_at timestamptz,
    grade_approved_at timestamptz,
    grade_approved_by text,
    grader_status text,
    print_state text,
    updated_at timestamptz DEFAULT now()
  );
`;

/** Partner RBAC catalogue, seeded exactly as both real hosts are. */
const PARTNER_RBAC = `
  CREATE TABLE partner_permissions (id serial PRIMARY KEY, code text UNIQUE NOT NULL, label text);
  CREATE TABLE partner_roles (id serial PRIMARY KEY, code text UNIQUE NOT NULL);
  CREATE TABLE partner_role_permissions (role_id integer NOT NULL, permission_id integer NOT NULL,
    PRIMARY KEY (role_id, permission_id));
  CREATE TABLE partner_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  INSERT INTO partner_roles (code) VALUES ('PARTNER_OWNER'), ('PARTNER_MANAGER'), ('MVGS_ASSESSMENT_TECHNICIAN');
  CREATE FUNCTION partner_auth_lookup(p_email text)
  RETURNS TABLE (user_id uuid, mfa_required boolean, has_active_mfa boolean)
  LANGUAGE sql AS $fn$ SELECT NULL::uuid, NULL::boolean, NULL::boolean $fn$;
`;

async function build(lineage: Lineage): Promise<pg.Pool> {
  const dbName = `lineage_${lineage}`;
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = cluster.url.replace(/\/[^/]*$/, `/${dbName}`);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  await pool.query(BASE_CERTIFICATES);
  await pool.query(CERTIFICATES_PROTECTED_COLUMNS_SQL);
  await pool.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade_explanation text");
  await pool.query(PARTNER_RBAC);
  await pool.query(`
    CREATE TABLE schema_migrations (
      id serial PRIMARY KEY, filename text NOT NULL UNIQUE, checksum text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      status text NOT NULL DEFAULT 'applied', applied_by text NOT NULL DEFAULT current_user
    );
  `);

  if (lineage === "production") {
    // Scanner lineage: journal stops at 0026 then jumps to the scanner trio.
    // NO grading_revision.
    for (const f of ["0019_catalogue_manager", "0026_catalogue_abbreviation_unique",
                     "0045_partner_stations", "0046_scanner_processing_jobs", "0047_scanner_evidence_staging"]) {
      await pool.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1,'x')", [`${f}.sql`]);
    }
  } else if (lineage === "staging") {
    // final-product-integration lineage: 0071 ALREADY added grading_revision and a
    // CHECK constraint. 0073 must converge on top without conflicting.
    await pool.query("ALTER TABLE certificates ADD COLUMN grading_revision integer NOT NULL DEFAULT 1");
    await pool.query(`ALTER TABLE certificates ADD CONSTRAINT chk_certificates_review_revision_binding
                        CHECK (grading_revision > 0)`);
    for (const f of ["0046_partner_mfa_pending_lifecycle", "0047_partner_owner_invariant_tenants_rls",
                     "0048_partner_location_snapshot_search_path", "0071_certificate_review_revision_binding"]) {
      await pool.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1,'x')", [`${f}.sql`]);
    }
  }
  // "fresh" = main-shaped: base tables only, empty journal.

  // A row in each, so the backfill and trigger have something to act on.
  await pool.query("INSERT INTO certificates (cert_id, grade, grade_type) VALUES ('MV1', 7.0, 'numeric')");
  return pool;
}

beforeAll(async () => {
  cluster = await startPostgres17("lineage-convergence-0073");
  for (const lineage of ["production", "staging", "fresh"] as Lineage[]) {
    pools[lineage] = await build(lineage);
  }
}, 240_000);

afterAll(async () => {
  for (const p of Object.values(pools)) await p?.end();
  await cluster?.stop();
});

const LINEAGES: Lineage[] = ["production", "staging", "fresh"];

describe("0073 converges every lineage to ONE canonical target", () => {
  it("applies cleanly to production-, staging- and fresh-shaped databases", async () => {
    for (const lineage of LINEAGES) {
      await expect(
        pools[lineage].query(`BEGIN; ${MIGRATION_0073} COMMIT;`),
        `0073 must apply to the ${lineage}-shaped lineage`
      ).resolves.toBeDefined();
    }
  });

  it("is idempotent — a second run changes nothing and does not error", async () => {
    for (const lineage of LINEAGES) {
      await expect(
        pools[lineage].query(`BEGIN; ${MIGRATION_0073} COMMIT;`),
        `0073 must be re-runnable on ${lineage}`
      ).resolves.toBeDefined();
    }
  });

  // ── CANONICAL SCHEMA ASSERTIONS ────────────────────────────────────────────
  // Every lineage must satisfy the SAME assertions afterwards. This is the
  // anti-drift guard: if a future lineage diverges, these fail.

  it("CANONICAL: grading_revision is integer NOT NULL DEFAULT 1 everywhere", async () => {
    for (const lineage of LINEAGES) {
      const { rows } = await pools[lineage].query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_name='certificates' AND column_name='grading_revision'`
      );
      expect(rows[0], `${lineage} must have grading_revision`).toBeDefined();
      expect(rows[0].data_type, lineage).toBe("integer");
      expect(rows[0].is_nullable, lineage).toBe("NO");
      expect(String(rows[0].column_default).replace(/::.*$/, ""), lineage).toBe("1");
    }
  });

  it("CANONICAL: the revision trigger exists and is ENABLE ALWAYS everywhere", async () => {
    for (const lineage of LINEAGES) {
      const { rows } = await pools[lineage].query(
        `SELECT tgenabled::text AS mode FROM pg_trigger
          WHERE tgrelid='certificates'::regclass AND NOT tgisinternal
            AND tgname='trg_certificates_advance_grading_revision'`
      );
      expect(rows[0], `${lineage} must have the revision trigger`).toBeDefined();
      // 'A' = ENABLE ALWAYS: session_replication_role='replica' cannot bypass it.
      expect(rows[0].mode, `${lineage} trigger must be ENABLE ALWAYS`).toBe("A");
    }
  });

  it("CANONICAL: partner.cards.preview is granted to all three seeded roles everywhere", async () => {
    for (const lineage of LINEAGES) {
      const { rows } = await pools[lineage].query(
        `SELECT r.code FROM partner_role_permissions rp
           JOIN partner_roles r ON r.id = rp.role_id
           JOIN partner_permissions p ON p.id = rp.permission_id
          WHERE p.code='partner.cards.preview' ORDER BY r.code`
      );
      expect(rows.map((r) => r.code), lineage).toEqual([
        "MVGS_ASSESSMENT_TECHNICIAN",
        "PARTNER_MANAGER",
        "PARTNER_OWNER",
      ]);
    }
  });

  it("CANONICAL: behaviour is identical — protected change versions, maintenance does not", async () => {
    for (const lineage of LINEAGES) {
      const pool = pools[lineage];
      const rev = async () => (await pool.query("SELECT grading_revision r FROM certificates WHERE id=1")).rows[0].r;
      const before = await rev();
      await pool.query("UPDATE certificates SET grade = grade + 1 WHERE id=1");
      expect(await rev(), `${lineage}: a protected change must version`).toBe(before + 1);
      const afterGrade = await rev();
      await pool.query("UPDATE certificates SET updated_at = now() WHERE id=1");
      expect(await rev(), `${lineage}: a timestamp-only write must NOT version`).toBe(afterGrade);
    }
  });

  it("CANONICAL: grade_explanation is versioned — it is published on public surfaces", async () => {
    for (const lineage of LINEAGES) {
      const pool = pools[lineage];
      const rev = async () => (await pool.query("SELECT grading_revision r FROM certificates WHERE id=1")).rows[0].r;
      const before = await rev();
      await pool.query("UPDATE certificates SET grade_explanation = 'reviewer text ' || $1 WHERE id=1", [lineage]);
      expect(await rev(), `${lineage}: grade_explanation must version`).toBe(before + 1);
    }
  });

  it("CANONICAL: replica role cannot bypass, and an approved row is not re-versioned", async () => {
    for (const lineage of LINEAGES) {
      const pool = pools[lineage];
      const c = await pool.connect();
      try {
        const rev = async () => (await c.query("SELECT grading_revision r FROM certificates WHERE id=1")).rows[0].r;
        const before = await rev();
        await c.query("SET session_replication_role = 'replica'");
        await c.query("UPDATE certificates SET card_name = 'replica probe' WHERE id=1");
        expect(await rev(), `${lineage}: ENABLE ALWAYS must survive replica role`).toBe(before + 1);
        await c.query("SET session_replication_role = 'origin'");
        await c.query("UPDATE certificates SET grade_approved_at = now() WHERE id=1");
        const approved = await rev();
        await c.query("UPDATE certificates SET grade = 9.5 WHERE id=1");
        expect(await rev(), `${lineage}: approved rows must not re-version`).toBe(approved);
        await c.query("UPDATE certificates SET grade_approved_at = NULL WHERE id=1");
      } finally {
        c.release();
      }
    }
  });

  it("CANONICAL: PostgreSQL itself refuses to drop a protected column once installed", async () => {
    // This is the structural advantage of comparing columns directly in the WHEN
    // clause rather than looking names up in to_jsonb(): the trigger's dependency on
    // every protected column is recorded in pg_depend, so silently un-protecting a
    // field by dropping it is impossible. The old jsonb-lookup form would have
    // allowed the drop and then quietly stopped protecting that field forever.
    for (const lineage of LINEAGES) {
      const c = await pools[lineage].connect();
      try {
        await c.query("BEGIN");
        await expect(
          c.query("ALTER TABLE certificates DROP COLUMN rarity_code"),
          `${lineage}: dropping a protected column must be refused`
        ).rejects.toThrow(/depend/i);
      } finally {
        await c.query("ROLLBACK").catch(() => {});
        c.release();
      }
    }
  });

  it("fails CLOSED when a protected column is absent, naming what is missing", async () => {
    // Proven on a database that does NOT yet carry the trigger — i.e. the real
    // pre-convergence condition — since once it is installed pg_depend makes the
    // column undroppable (asserted above).
    const c = await pools.fresh.connect();
    try {
      await c.query("BEGIN");
      // Remove the trigger first so the column can be dropped, reproducing a host
      // whose certificates table never had this field.
      await c.query("DROP TRIGGER trg_certificates_advance_grading_revision ON certificates");
      await c.query("ALTER TABLE certificates DROP COLUMN rarity_code");
      // One attempt only — the first failure aborts the transaction, so both
      // properties are asserted against the same captured error.
      const err = await c.query(MIGRATION_0073).then(
        () => null,
        (e: Error) => e
      );
      expect(err, "0073 must refuse a schema missing a protected column").not.toBeNull();
      expect(err!.message).toMatch(/refuses to install partial review protection/);
      expect(err!.message, "the operator must be told WHICH column").toMatch(/rarity_code/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  });

  it("fails CLOSED when partner_auth_lookup does not project has_active_mfa", async () => {
    const pool = pools.fresh;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DROP FUNCTION partner_auth_lookup(text)");
      await c.query(`CREATE FUNCTION partner_auth_lookup(p_email text)
                       RETURNS TABLE (user_id uuid, mfa_required boolean)
                       LANGUAGE sql AS $fn$ SELECT NULL::uuid, NULL::boolean $fn$`);
      await expect(c.query(MIGRATION_0073)).rejects.toThrow(/does not project has_active_mfa/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  });
});
