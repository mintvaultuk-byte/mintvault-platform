/**
 * SCOPED CONVERGENCE MODE — apply exactly one forward migration, safely.
 *
 * MintVault's migration history forked three ways, and the same MFA lifecycle
 * migration now exists under TWO immutable identities (0044 on production, 0046 on
 * staging). Against production the ordinary runner plans SEVEN historical files that
 * must never be replayed before it ever reaches the forward convergence migration,
 * and the identity guard then correctly refuses the entire run. Neither escape hatch
 * is permitted: applied migrations may not be renumbered, and journal rows may not
 * be forged to fake history that was never executed.
 *
 * Scoped mode is the third way. These tests pin that it stays narrow and fail-closed
 * — especially that it NEVER writes a journal row for anything it did not run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { CERTIFICATES_PROTECTED_COLUMNS_SQL } from "./helpers/certificates-protected-columns";
import { applyScopedMigration } from "../scripts/db/migrate";

const MIGRATION_0073 = readFileSync("migrations/0073_lineage_convergence.sql", "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const file = (filename: string, sql: string) => ({
  number: filename.slice(0, 4),
  filename,
  path: `/virtual/${filename}`,
  sql,
  checksum: sha(sql),
  noTransaction: false,
});

/** The historical backlog the ordinary runner would try to replay against production. */
const BACKLOG = [
  file("0030_project_control.sql", "CREATE TABLE must_not_run_0030 (id int)"),
  file("0035_partner_certificate_origin.sql", "CREATE TABLE must_not_run_0035 (id int)"),
  file("0041_partner_submission_credit_lifecycle.sql", "CREATE TABLE must_not_run_0041 (id int)"),
  file("0042_partner_per_card_credit_settlement.sql", "CREATE TABLE must_not_run_0042 (id int)"),
  file("0043_partner_credit_hold_per_card.sql", "CREATE TABLE must_not_run_0043 (id int)"),
  file("0044_partner_submission_lifecycle_and_location_snapshot.sql", "CREATE TABLE must_not_run_0044 (id int)"),
  file("0046_partner_mfa_pending_lifecycle.sql", "CREATE TABLE must_not_run_0046 (id int)"),
];
const TARGET = file("0073_lineage_convergence.sql", MIGRATION_0073);
const ALL_FILES = [...BACKLOG, TARGET];

let cluster: DisposablePostgres17;
let pool: pg.Pool;

/**
 * Rebuild the ACTUAL current production shape: scanner lineage, the partner
 * migrations applied today (0031-0035 + 0044_partner_mfa_pending_lifecycle), the
 * historical partner identities production never received, and no grading_revision.
 */
const PRODUCTION_JOURNAL = [
  ...Array.from({ length: 19 }, (_, i) => `${String(i + 1).padStart(4, "0")}_historical.sql`),
  "0022_print_workflow_lifecycle.sql",
  "0023_set_library_schema.sql",
  "0024_set_library_base_tables.sql",
  "0026_catalogue_abbreviation_unique.sql",
  "0031_partner_user_management.sql",
  "0032_partner_final_owner_invariant.sql",
  "0033_partner_audit_action_precision.sql",
  "0034_partner_rbac_seed.sql",
  "0035_partner_certificate_origin.sql",
  // The SAME migration staging holds as 0046 — renumbered and applied to production.
  "0044_partner_mfa_pending_lifecycle.sql",
  "0045_partner_stations.sql",
  "0046_scanner_processing_jobs.sql",
  "0047_scanner_evidence_staging.sql",
];

async function buildProductionShape(withGradingRevision = false) {
  await pool.query(`
    DROP TABLE IF EXISTS certificates, schema_migrations, partner_permissions, partner_roles,
      partner_role_permissions, partner_users CASCADE;
    DROP FUNCTION IF EXISTS partner_auth_lookup(text);
    DROP FUNCTION IF EXISTS certificates_advance_grading_revision();
    CREATE TABLE certificates (
      id serial PRIMARY KEY, cert_id text, status text, deleted_at timestamptz,
      grade_approved_at timestamptz, grader_status text, print_state text,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE schema_migrations (
      id serial PRIMARY KEY, filename text NOT NULL UNIQUE, checksum text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      status text NOT NULL DEFAULT 'applied', applied_by text NOT NULL DEFAULT current_user
    );
    CREATE TABLE partner_permissions (id serial PRIMARY KEY, code text UNIQUE NOT NULL, label text);
    CREATE TABLE partner_roles (id serial PRIMARY KEY, code text UNIQUE NOT NULL);
    CREATE TABLE partner_role_permissions (role_id int NOT NULL, permission_id int NOT NULL, PRIMARY KEY (role_id, permission_id));
    CREATE TABLE partner_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    INSERT INTO partner_roles (code) VALUES ('PARTNER_OWNER'),('PARTNER_MANAGER'),('MVGS_ASSESSMENT_TECHNICIAN');
    CREATE FUNCTION partner_auth_lookup(p_email text)
      RETURNS TABLE (user_id uuid, mfa_required boolean, has_active_mfa boolean)
      LANGUAGE sql AS $fn$ SELECT NULL::uuid, NULL::boolean, NULL::boolean $fn$;
  `);
  await pool.query(CERTIFICATES_PROTECTED_COLUMNS_SQL);
  await pool.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade_explanation text");
  if (withGradingRevision) {
    await pool.query("ALTER TABLE certificates ADD COLUMN grading_revision integer NOT NULL DEFAULT 1");
  }
  for (const f of PRODUCTION_JOURNAL) {
    await pool.query("INSERT INTO schema_migrations (filename, checksum, completed_at) VALUES ($1,$2,now())", [
      f,
      sha(f),
    ]);
  }
  // Real certificate data that must survive untouched.
  await pool.query(
    "INSERT INTO certificates (cert_id, grade, grade_type, card_name) VALUES ('MV1', 7.0,'numeric','Charizard'),('MV2', 9.0,'numeric','Blastoise')"
  );
}

beforeAll(async () => {
  cluster = await startPostgres17("scoped-migration-convergence");
  pool = new pg.Pool({ connectionString: cluster.url, max: 4 });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

beforeEach(async () => {
  await buildProductionShape();
});

const client = () => pool as unknown as Parameters<typeof applyScopedMigration>[0];

describe("scoped mode applies EXACTLY the target and nothing else", () => {
  it("B. runs ONLY 0073 against a production-shaped journal, leaving the backlog untouched", async () => {
    const result = await applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES });
    expect(result.applied).toBe(true);
    expect(result.journalBefore).toBe(PRODUCTION_JOURNAL.length);
    expect(result.journalAfter).toBe(PRODUCTION_JOURNAL.length + 1);

    // I. Not one backlog migration executed — proven by their side effects being absent.
    const { rows } = await pool.query(
      "SELECT count(*)::int c FROM information_schema.tables WHERE table_name LIKE 'must_not_run_%'"
    );
    expect(rows[0].c, "no historical backlog migration may execute").toBe(0);

    // L. And no journal row exists for anything that did not run — NO FORGERY.
    const j = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
    const names = j.rows.map((r) => r.filename);
    expect(names).toContain("0073_lineage_convergence.sql");
    for (const b of BACKLOG) {
      if (PRODUCTION_JOURNAL.includes(b.filename)) continue; // genuinely applied earlier
      expect(names, `${b.filename} must NOT be recorded — it was never executed`).not.toContain(b.filename);
    }
    // The two immutable historical identities are untouched.
    expect(names).toContain("0044_partner_mfa_pending_lifecycle.sql");
    expect(names).toContain("0046_scanner_processing_jobs.sql");
  });

  it("converges the production shape to the canonical target", async () => {
    await applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES });
    const col = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='certificates' AND column_name='grading_revision'`
    );
    expect(col.rows[0].data_type).toBe("integer");
    expect(col.rows[0].is_nullable).toBe("NO");
    expect(String(col.rows[0].column_default).replace(/::.*$/, "")).toBe("1");

    const trg = await pool.query(
      `SELECT tgenabled::text m FROM pg_trigger WHERE tgrelid='certificates'::regclass
        AND tgname='trg_certificates_advance_grading_revision'`
    );
    expect(trg.rows[0].m, "must be ENABLE ALWAYS").toBe("A");

    const perm = await pool.query(
      `SELECT count(*)::int c FROM partner_role_permissions rp
         JOIN partner_permissions p ON p.id=rp.permission_id WHERE p.code='partner.cards.preview'`
    );
    expect(perm.rows[0].c).toBe(3);

    // grade_explanation is versioned.
    const rev = async () => (await pool.query("SELECT grading_revision r FROM certificates WHERE id=1")).rows[0].r;
    const before = await rev();
    await pool.query("UPDATE certificates SET grade_explanation='x' WHERE id=1");
    expect(await rev()).toBe(before + 1);

    // Data unchanged.
    const rows = await pool.query("SELECT count(*)::int c FROM certificates");
    expect(rows.rows[0].c).toBe(2);
  });

  it("C+15. a second run is a safe no-op, not a second execution", async () => {
    const first = await applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES });
    expect(first.applied).toBe(true);
    const second = await applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("already_applied");
    expect(second.journalAfter).toBe(first.journalAfter);
    const j = await pool.query("SELECT count(*)::int c FROM schema_migrations WHERE filename=$1", [TARGET.filename]);
    expect(j.rows[0].c, "recorded exactly once").toBe(1);
  });
});

describe("scoped mode fails CLOSED", () => {
  it("G. missing target", async () => {
    await expect(applyScopedMigration(client(), "0099_not_here.sql", { files: ALL_FILES })).rejects.toThrow(
      /does not exist/i
    );
  });

  it("A'. rejects a non-exact target — no wildcard, no number-only", async () => {
    for (const bad of ["0073", "0073_*", "*.sql", "lineage_convergence.sql"]) {
      await expect(applyScopedMigration(client(), bad, { files: ALL_FILES })).rejects.toThrow(/exact NNNN_name\.sql/);
    }
  });

  it("D. wrong checksum on an already-applied identity", async () => {
    await pool.query("INSERT INTO schema_migrations (filename, checksum, completed_at) VALUES ($1,$2,now())", [
      TARGET.filename,
      sha("something else entirely"),
    ]);
    await expect(applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES })).rejects.toThrow(
      /DIFFERENT checksum/
    );
  });

  it("H. numeric collision on the TARGET's own number", async () => {
    await pool.query("INSERT INTO schema_migrations (filename, checksum, completed_at) VALUES ($1,$2,now())", [
      "0073_someone_elses_migration.sql",
      sha("x"),
    ]);
    await expect(applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES })).rejects.toThrow(
      /already occupied by a DIFFERENT migration/
    );
  });

  it("refuses a journal left in a non-applied state by a crashed run", async () => {
    await pool.query(
      "INSERT INTO schema_migrations (filename, checksum, status) VALUES ($1,$2,'applying')",
      [TARGET.filename, TARGET.checksum]
    );
    await expect(applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES })).rejects.toThrow(/status 'applying'/);
  });

  it("E. another migration runner holds the advisory lock", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(4150205)");
      await expect(applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES })).rejects.toThrow(
        /another migration runner holds the advisory lock/i
      );
    } finally {
      await holder.query("SELECT pg_advisory_unlock(4150205)").catch(() => {});
      holder.release();
    }
  });

  it("J. a failing target leaves the journal consistent — no partial state, no row", async () => {
    const broken = file("0073_lineage_convergence.sql", "CREATE TABLE ok_first (id int); SELECT this_fn_does_not_exist();");
    await expect(applyScopedMigration(client(), broken.filename, { files: [broken] })).rejects.toThrow(
      /failed and was rolled back/
    );
    const j = await pool.query("SELECT count(*)::int c FROM schema_migrations WHERE filename=$1", [broken.filename]);
    expect(j.rows[0].c, "a failed migration must not be recorded").toBe(0);
    const t = await pool.query("SELECT count(*)::int c FROM information_schema.tables WHERE table_name='ok_first'");
    expect(t.rows[0].c, "its partial DDL must be rolled back").toBe(0);
  });

  it("refuses a database with no journal at all — this is not a bootstrap path", async () => {
    await pool.query("DROP TABLE schema_migrations");
    await expect(applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES })).rejects.toThrow(
      /no schema_migrations journal/
    );
  });
});

describe("staging-shaped regression", () => {
  it("0073 already applied on a staging-shaped database → safe no-op", async () => {
    // Staging already had grading_revision from its own 0071, then took 0073.
    await buildProductionShape(true);
    await applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES });
    const again = await applyScopedMigration(client(), TARGET.filename, { files: ALL_FILES });
    expect(again.applied).toBe(false);
    expect(again.reason).toBe("already_applied");
    // No historical identity was introduced by either run.
    const j = await pool.query("SELECT count(*)::int c FROM schema_migrations");
    expect(j.rows[0].c).toBe(PRODUCTION_JOURNAL.length + 1);
  });
});
