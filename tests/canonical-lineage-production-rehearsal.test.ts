/**
 * Canonical lineage rehearsal against the exact production journal topology observed on 2026-08-19.
 *
 * This is intentionally not a greenfield test. It first applies the 40 source migrations whose
 * identities are journalled in production before the Growth application migration, adds that
 * already-applied 0095 schema, then records the same 41 immutable journal identities and asks the
 * real runner to execute the remaining canonical files in order. No production URL, row, or secret
 * is used: the fixture contains only schema and synthetic role data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { applyMigrations, listMigrationFiles, planMigrations } from "../scripts/db/migrate";
import {
  applyMigrationsRealistic,
  migratorUrlFrom,
  MIGRATOR_ROLE,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const ROOT = process.cwd();

/** Exact applied identities from the read-only production journal, excluding already-schema-applied 0095. */
const PRODUCTION_SOURCE_HISTORY = [
  "0001_partner_foundation",
  "0002_partner_auth_support",
  "0003_partner_auth_hardening",
  "0004_partner_mfa_enrol",
  "0005_partner_mfa_replay_and_grants",
  "0006_partner_definer_role",
  "0007_partner_submissions",
  "0008_partner_connector_foundation",
  "0009_partner_connector_validation",
  "0010_partner_connector_import",
  "0011_partner_connector_reconciliation",
  "0012_partner_connector_import_attempts",
  "0013_partner_connector_claim_index",
  "0014_partner_connector_admin_actions",
  "0015_partner_management",
  "0016_partner_wallet_ledger",
  "0017_partner_credit_reservations",
  "0018_correction_audit_index",
  "0019_catalogue_manager",
  "0022_print_workflow_lifecycle",
  "0023_set_library_schema",
  "0024_set_library_base_tables",
  "0026_catalogue_abbreviation_unique",
  "0031_partner_user_management",
  "0032_partner_final_owner_invariant",
  "0033_partner_audit_action_precision",
  "0034_partner_rbac_seed",
  "0035_partner_certificate_origin",
  "0041_partner_submission_credit_lifecycle",
  "0042_partner_per_card_credit_settlement",
  "0043_partner_credit_hold_per_card",
  "0044_partner_mfa_pending_lifecycle",
  "0045_partner_stations",
  "0046_scanner_processing_jobs",
  "0047_scanner_evidence_staging",
  "0073_lineage_convergence",
  "0074_partner_submission_lifecycle_and_location_snapshot",
  "0075_partner_station_single_active_capture",
  "0076_partner_pilot_certificate_allocation",
  "0077_partner_credential_lifecycle_hardening",
] as const;

const ALREADY_APPLIED_GB03 = "0095_growth_partner_applications";
const ATTRIBUTION_MIGRATION = "0100_growth_commercial_attribution.sql";
const COMPLETION_MIGRATION = "0101_growth_reviews_and_conversion.sql";

/** The expected ordered plan after canonical Partner/Scanner integration. */
const CANONICAL_PENDING = [
  "0030_project_control.sql",
  "0078_partner_connector_flag_read.sql",
  "0079_admin_password_lockout.sql",
  "0080_partner_card_jobs.sql",
  "0081_partner_card_job_certificate_binding.sql",
  "0082_partner_card_job_op_keys.sql",
  "0083_partner_credit_packs.sql",
  "0084_partner_location_management.sql",
  "0085_partner_scanner_operator_role.sql",
  "0086_partner_session_step_up.sql",
  "0087_partner_grading_edit_lease.sql",
  "0088_nfc_binding_integrity.sql",
  "0089_partner_shared_rate_limit_buckets.sql",
  "0090_lineage_convergence_scanner.sql",
  "0091_capture_session_calibration_snapshot.sql",
  "0092_partner_station_calibrate_permission.sql",
  "0093_partner_credit_pack_currency.sql",
  "0094_scanner_capture_physical_release.sql",
  "0096_partner_card_job_void_management_audit.sql",
  "0097_partner_credit_checkout_sessions.sql",
  "0098_scanner_operator_credit_view.sql",
  "0102_partner_supplies_orders.sql",
] as const;

const sha256 = (sql: string): string => createHash("sha256").update(sql).digest("hex");

function sql(name: string): string {
  return readFileSync(join(ROOT, "migrations", `${name}.sql`), "utf8");
}

/** Minimum core objects required by the real Partner migrations, matching their existing realistic harness. */
async function seedMintVaultPrerequisites(admin: pg.Client): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  // Keep this pre-journal core surface aligned with the allocator's real
  // compile-time contract.  applyMigrationsRealistic adds the protected review
  // columns used by 0073; these are the allocator-specific columns that existed
  // on production before 0076 was recorded.
  await admin.query(`CREATE TABLE certificates (
    id serial primary key, certificate_number text, cert_id text,
    submission_item_id integer, status text, deleted_at timestamptz,
    grade_approved_at timestamptz, grade_approved_by text, print_state text,
    label_type text, grade_type text, language text, card_game text, nfc_uid text,
    set_name text, card_name text, card_number_display text, year_text text,
    created_by text, issued_at timestamptz, updated_at timestamptz,
    assigned_grader_id text, grader_status text, assigned_at timestamptz
  )`);
  // 0076's privileged allocator requires the durable counter independently of
  // the certificate table fixture that applyMigrationsRealistic provisions.
  // Production already has this singleton allocator before the journal point
  // being rehearsed; include its shape rather than weakening 0076's guard.
  await admin.query(`CREATE TABLE cert_counter (
    id integer primary key, last_issued integer not null default 0,
    updated_at timestamptz not null default now()
  )`);
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, payment_intent_id text, payment_status varchar(20) not null default 'unpaid',
    payment_amount numeric(10,2), payment_currency varchar(3) default 'GBP', payment_timestamp timestamp,
    deleted_at timestamptz
  )`);
  await admin.query(`CREATE TABLE submission_items (
    id serial primary key, submission_id integer not null, card_index integer not null default 0,
    game text, card_set text, card_name text, card_number text, year text
  )`);
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const table of ["users", "certificates", "cert_counter", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO ${MIGRATOR_ROLE}`);
  }
}

let cluster: DisposablePostgres17;
let admin: pg.Client;
let migrator: pg.Client;
let applied: string[];
let growthApplied: string[];
let completionApplied: string[];

describe("canonical Partner/Scanner production-journal rehearsal", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("canonical-lineage-production-rehearsal");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultPrerequisites(admin);

    // These source migrations build the same dependency shape as the 40 pre-0095 production
    // journal records. They execute as the non-superuser realistic migration role.
    await applyMigrationsRealistic(admin, cluster.url, PRODUCTION_SOURCE_HISTORY);

    // 0041 intentionally moves the credit tables to the dedicated lifecycle
    // owner. 0080 attaches a foreign key to partner_credit_reservations, for
    // which PostgreSQL requires REFERENCES on the target table even though the
    // migration role creates the child table.  Model the least privilege that
    // a production deployment identity must prove in its preflight; do not
    // hide the requirement by switching this rehearsal to a superuser.
    await admin.query(`GRANT REFERENCES ON public.partner_credit_reservations TO ${MIGRATOR_ROLE}`);

    migrator = new pg.Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    await migrator.query(sql(ALREADY_APPLIED_GB03));

    await admin.query(`
      CREATE TABLE schema_migrations (
        id serial PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        checksum text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        status text NOT NULL DEFAULT 'applied',
        applied_by text NOT NULL DEFAULT current_user
      )
    `);
    await admin.query(`ALTER TABLE schema_migrations OWNER TO ${MIGRATOR_ROLE}`);

    for (const name of [...PRODUCTION_SOURCE_HISTORY, ALREADY_APPLIED_GB03]) {
      await admin.query(
        "INSERT INTO schema_migrations (filename, checksum, completed_at, status) VALUES ($1,$2,now(),'applied')",
        [`${name}.sql`, sha256(sql(name))]
      );
    }

    const files = listMigrationFiles();
    const preGrowthFiles = files.filter(
      (file) => file.filename !== ATTRIBUTION_MIGRATION && file.filename !== COMPLETION_MIGRATION
    );
    const before = await planMigrations(migrator as never, preGrowthFiles);
    expect(before.alreadyApplied).toHaveLength(41);
    expect(before.pending).toEqual([...CANONICAL_PENDING]);
    expect(before.inconsistent).toEqual([]);
    expect(before.checksumMismatches).toEqual([]);
    expect(before.destructive.map((entry) => entry.filename)).toEqual([
      "0084_partner_location_management.sql",
      "0094_scanner_capture_physical_release.sql",
      "0096_partner_card_job_void_management_audit.sql",
    ]);

    const result = await applyMigrations(migrator as never, preGrowthFiles, { allowDestructive: true });
    applied = result.applied;

    // GB-04 release rehearsal starts from the current production journal shape plus the
    // already-applied Supplies migration, and exactly one new canonical migration.
    const attributionFiles = files.filter((file) => file.filename !== COMPLETION_MIGRATION);
    const growthBefore = await planMigrations(migrator as never, attributionFiles);
    expect(growthBefore.alreadyApplied).toHaveLength(63);
    expect(growthBefore.pending).toEqual([ATTRIBUTION_MIGRATION]);
    expect(growthBefore.inconsistent).toEqual([]);
    expect(growthBefore.checksumMismatches).toEqual([]);
    growthApplied = (await applyMigrations(migrator as never, attributionFiles)).applied;

    // Completion Night starts from the exact observed 64-entry rehearsal
    // journal and has one additive, non-destructive migration to apply.
    const completionBefore = await planMigrations(migrator as never, files);
    expect(completionBefore.alreadyApplied).toHaveLength(64);
    expect(completionBefore.pending).toEqual([COMPLETION_MIGRATION]);
    expect(completionBefore.inconsistent).toEqual([]);
    expect(completionBefore.checksumMismatches).toEqual([]);
    expect(completionBefore.destructive).toEqual([]);
    completionApplied = (await applyMigrations(migrator as never, files)).applied;
  }, 180_000);

  afterAll(async () => {
    await migrator?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("uses the canonical ordered plan and leaves a complete, consistent journal", async () => {
    expect(applied).toEqual([...CANONICAL_PENDING]);
    expect(growthApplied).toEqual([ATTRIBUTION_MIGRATION]);
    expect(completionApplied).toEqual([COMPLETION_MIGRATION]);
    const after = await planMigrations(migrator as never, listMigrationFiles());
    expect(after.pending).toEqual([]);
    expect(after.inconsistent).toEqual([]);
    expect(after.checksumMismatches).toEqual([]);
    expect(after.alreadyApplied).toHaveLength(65);
  });

  it("applies 0100 and then only 0101 from the exact 63-entry production journal shape", async () => {
    const acquisition = await admin.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='submission_acquisition'
      ORDER BY ordinal_position
    `);
    expect(acquisition.rows.map((row) => row.column_name)).toEqual([
      "submission_id",
      "acquisition_category",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "captured_at",
    ]);
    const growthIndex = await admin.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_submissions_paid_growth_window'
    `);
    expect(growthIndex.rows).toEqual([{ indexname: "idx_submissions_paid_growth_window" }]);

    const completionRelations = await admin.query<{ relname: string }>(`
      SELECT relname FROM pg_class
       WHERE relnamespace='public'::regnamespace
         AND relname IN ('review_requests','review_delivery_attempts','review_suppressions','growth_conversion_events',
                         'growth_commercial_targets')
       ORDER BY relname
    `);
    expect(completionRelations.rows.map((row) => row.relname)).toEqual([
      "growth_commercial_targets",
      "growth_conversion_events",
      "review_delivery_attempts",
      "review_requests",
      "review_suppressions",
    ]);
  });

  it("delivers the missing Partner, Scanner, and project-control structures without replacing existing data", async () => {
    const relations = await admin.query<{ relname: string }>(`
      SELECT relname FROM pg_class
       WHERE relnamespace='public'::regnamespace
         AND relname IN ('pc_nodes','partner_card_jobs','partner_card_job_op_keys','partner_credit_packs',
                         'partner_grading_leases','partner_rate_limit_buckets','partner_credit_checkout_sessions')
       ORDER BY relname
    `);
    expect(relations.rows.map((r) => r.relname)).toEqual([
      "partner_card_job_op_keys",
      "partner_card_jobs",
      "partner_credit_checkout_sessions",
      "partner_credit_packs",
      "partner_grading_leases",
      "partner_rate_limit_buckets",
      "pc_nodes",
    ]);

    const columns = await admin.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND (table_name, column_name) IN (
         ('users','password_failed_count'), ('users','password_locked_until'),
         ('partner_sessions','last_step_up_at'), ('scanner_capture_sessions','calibration_id'),
         ('scanner_capture_sessions','acquisition_region'), ('scanner_capture_sessions','physical_released'),
         ('partner_credit_packs','stripe_currency')
       ) ORDER BY table_name, column_name
    `);
    expect(columns.rows).toHaveLength(7);

    const audit = await admin.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='partner_management_audit'::regclass
         AND conname='chk_partner_management_audit_action'
    `);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].definition).toContain("partner_card_job_voided");
    expect(audit.rows[0].definition).toContain("partner_location_created");
    expect(audit.rows[0].definition).toContain("partner_wallet_backfilled");

    const indexes = await admin.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname='public' AND indexname IN (
         'uq_certificates_nfc_uid', 'uq_scanner_capture_one_active_station',
         'uq_partner_grading_leases_one_active', 'uq_partner_credit_checkout_sessions_stripe_session'
       ) ORDER BY indexname
    `);
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      "uq_certificates_nfc_uid",
      "uq_partner_credit_checkout_sessions_stripe_session",
      "uq_partner_grading_leases_one_active",
      "uq_scanner_capture_one_active_station",
    ]);
    expect(indexes.rows.find((r) => r.indexname === "uq_scanner_capture_one_active_station")?.indexdef).toContain(
      "physical_released = false"
    );
  });

  it("keeps the tenant-protected structures and restricted calibration authority", async () => {
    const rls = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace='public'::regnamespace
         AND relname IN ('partner_card_jobs','partner_grading_leases','partner_credit_checkout_sessions')
       ORDER BY relname
    `);
    expect(rls.rows).toEqual([
      { relname: "partner_card_jobs", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "partner_credit_checkout_sessions", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "partner_grading_leases", relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const grants = await admin.query<{ role: string }>(`
      SELECT r.code AS role
        FROM partner_permissions p
        JOIN partner_role_permissions rp ON rp.permission_id=p.id
        JOIN partner_roles r ON r.id=rp.role_id
       WHERE p.code='partner.stations.calibrate'
       ORDER BY r.code
    `);
    expect(grants.rows.map((r) => r.role)).toEqual(["MVGS_ASSESSMENT_TECHNICIAN", "PARTNER_MANAGER", "PARTNER_OWNER"]);

    const scannerCreditView = await admin.query<{ role: string }>(`
      SELECT r.code AS role
        FROM partner_permissions p
        JOIN partner_role_permissions rp ON rp.permission_id=p.id
        JOIN partner_roles r ON r.id=rp.role_id
       WHERE p.code='partner.credits.view'
         AND r.code='SCANNER_OPERATOR'
    `);
    expect(scannerCreditView.rows).toEqual([{ role: "SCANNER_OPERATOR" }]);

    const forbiddenScannerCredits = await admin.query<{ n: string }>(`
      SELECT count(*)::text AS n
        FROM partner_role_permissions rp
        JOIN partner_roles r ON r.id=rp.role_id
        JOIN partner_permissions p ON p.id=rp.permission_id
       WHERE r.code='SCANNER_OPERATOR'
         AND p.code IN ('partner.cards.assess', 'partner.credits.purchase', 'partner.users.manage',
                        'partner.users.view', 'partner.sessions.revoke', 'partner.stations.enrol',
                        'partner.cards.fix')
    `);
    expect(forbiddenScannerCredits.rows).toEqual([{ n: "0" }]);
  });
});
