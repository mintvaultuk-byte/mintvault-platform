/**
 * Phase 1 — parity between the Drizzle partner schema (shared/partner-schema.ts) and the
 * authoritative migrations. The Drizzle model covers the 14 foundation tables of migration 0001,
 * which is the surface it is used for; the auth/MFA tables and columns added in 0002–0005 are
 * accessed by the runtime through raw SQL / SECURITY DEFINER functions (never typed Drizzle access),
 * so they are MIGRATION-authoritative and intentionally not modelled in Drizzle. This test asserts
 * the 0001 Drizzle↔migration parity exactly AND pins the full Phase-1 migration inventory (0001–0006)
 * so a new/removed migration is noticed. Pure: reads files, no DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableName, getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as partnerSchema from "../shared/partner-schema";

const migration = readFileSync(join(process.cwd(), "migrations", "0001_partner_foundation.sql"), "utf8");

function migrationTableNames(): string[] {
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)/gi;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(migration)) !== null) names.add(m[1]);
  return [...names].sort();
}

function drizzleTableNames(): string[] {
  return Object.values(partnerSchema)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableName(t))
    .sort();
}

describe("partner schema ↔ migration parity", () => {
  it("every Drizzle partner table exists in the migration", () => {
    const inMigration = new Set(migrationTableNames());
    for (const t of drizzleTableNames()) {
      expect(inMigration.has(t), `Drizzle table ${t} missing from migration 0001`).toBe(true);
    }
  });

  it("the Drizzle schema and migration 0001 define the same 14 foundation tables", () => {
    expect(drizzleTableNames()).toEqual(migrationTableNames());
    expect(drizzleTableNames().length).toBe(14);
  });

  it("pins the full numbered migration inventory, so a new migration is noticed", () => {
    const numbered = readdirSync(join(process.cwd(), "migrations"))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    expect(numbered).toEqual([
      "0001_partner_foundation.sql",
      "0002_partner_auth_support.sql",
      "0003_partner_auth_hardening.sql",
      "0004_partner_mfa_enrol.sql",
      "0005_partner_mfa_replay_and_grants.sql",
      "0006_partner_definer_role.sql",
      "0007_partner_submissions.sql",
      "0008_partner_connector_foundation.sql",
      "0009_partner_connector_validation.sql",
      "0010_partner_connector_import.sql",
      "0011_partner_connector_reconciliation.sql",
      "0012_partner_connector_import_attempts.sql",
      "0013_partner_connector_claim_index.sql",
      "0014_partner_connector_admin_actions.sql",
      "0015_partner_management.sql",
      "0016_partner_wallet_ledger.sql",
      "0017_partner_credit_reservations.sql",
      // Not a partner migration — this pin covers every numbered migration so that any
      // addition is consciously acknowledged. 0018 adds the partial index supporting the
      // Super Admin Correction Mode operator-statistics query (audit_log).
      "0018_correction_audit_index.sql",
      // 0019 (PROVISIONAL — Catalogue Manager) creates the additive catalogue_items
      // table. The number is contested across parallel branches (partner-credit and
      // grading-concurrency also claim 0019); the coordinated release review assigns
      // the final sequence. Its rollback is intentionally named
      // rollback-0019-catalogue-manager.sql (non-numbered) so the runner never applies it.
      "0019_catalogue_manager.sql",
      // Not a partner migration — the print workflow lifecycle (certificates.print_state,
      // print_batches, print_events). 0020–0021 are claimed by other unmerged branches,
      // so 0022 avoids the runner's duplicate-number hard-reject.
      "0022_print_workflow_lifecycle.sql",
      "0023_set_library_schema.sql",
      // Set Library base-table ownership is completed by 0024; it is additive
      // and follows the already-applied 0023 schema additions.
      "0024_set_library_base_tables.sql",
      // 0025 is DELIBERATELY ABSENT AND RESERVED. The separate branch
      // fix/grading-optimistic-concurrency still carries an unapplied
      // 0019_grading_optimistic_concurrency.sql that must be renumbered to the
      // next free number, identified as 0025 at hostile-review time. Leaving the
      // gap here means the two cannot collide whichever lands first, and this pin
      // will fail loudly if anything else tries to claim 0025.
      //
      // STATUS 2026-07-29: that renumber has now been done on its own branch —
      // fix/grading-optimistic-concurrency @ 6e5953fc carries
      // 0025_grading_optimistic_concurrency.sql. 0025 is therefore claimed but not
      // yet merged, so it stays absent from this pin until that branch lands.
      //
      // 0026 (Catalogue Manager, hostile-review MEDIUM) adds a partial unique
      // index on the EFFECTIVE persisted code — coalesce(nullif(abbreviation,''),
      // value) — per category, over live rows only. Additive: index only, no
      // table/column/data change. 0019 is already applied in production and is
      // NOT edited or renamed by it, so 0019's checksum is untouched. Its
      // rollback is intentionally named rollback-0026-catalogue-abbreviation-
      // unique.sql (non-numbered) so the runner never applies it.
      "0026_catalogue_abbreviation_unique.sql",
      // Not a partner migration — the Super Admin Project Control dashboard. It creates nine
      // additive pc_* tables and touches nothing that already exists. 0030 is deliberately clear
      // of the contested 0019–0024 band so the runner's duplicate-number hard-reject cannot fire
      // whatever order the unmerged branches land in. Its rollback is intentionally named
      // rollback-0030-project-control.sql (non-numbered) so the runner never applies it.
      "0030_project_control.sql",
      "0031_partner_user_management.sql",
      "0032_partner_final_owner_invariant.sql",
      "0033_partner_audit_action_precision.sql",
      // 0034 seeds the Partner RBAC reference catalogue (roles/permissions/mappings). It is the
      // canonical initial seed under the approved hybrid architecture: the catalogue is created by
      // migration, and application startup only VALIDATES it read-only. Its rollback is
      // deliberately named rollback-0034-partner-rbac-seed.sql (non-numbered) so the runner never
      // applies it.
      "0034_partner_rbac_seed.sql",
      // 0035 records an immutable ORIGIN SNAPSHOT on certificates (origin_* columns, CHECK
      // constraints, an ENABLE ALWAYS immutability trigger and a partial index). It is additive and
      // touches ONLY `certificates` — no overlap with the partner credit surface below. It is
      // numbered BELOW staging's applied watermark (0041), so on staging it is journalled after a
      // higher-numbered migration; that is safe here precisely because the surfaces are disjoint.
      "0035_partner_certificate_origin.sql",
      // G6D grants the trusted connector only the reservation-release privileges needed to
      // settle a terminal Partner submission; it creates no mutable wallet balance. It lands at
      // 0041 because staging had already applied Project Control reconciliation migration 0040.
      "0041_partner_submission_credit_lifecycle.sql",
      // Added 2026-08-03: per-card credit settlement. Replaces 0041's single-reservation
      // connector release function with an N-reservation one. 0041 itself is untouched.
      "0042_partner_per_card_credit_settlement.sql",
      // 0043 re-keys the active-hold unique index per RESERVATION and adds the tenant-isolation
      // policy 0041 omitted on partner_submission_credit_holds. It contains an INTENTIONAL
      // DROP INDEX, so the runner requires --allow-destructive for it.
      "0043_partner_credit_hold_per_card.sql",
      // 0044 widens partner submission lifecycle states after handover and stores an immutable
      // location-name snapshot. It also permits the audited wallet-only staging backfill action.
      "0044_partner_submission_lifecycle_and_location_snapshot.sql",
      // 0045 is deliberately absent and must stay absent: 0046 is already journalled on staging and
      // every rollback in this series refuses while a higher-numbered row exists, so anything at
      // 0045 would be born un-rollbackable there. 0046 belongs to the partner MFA repair branch.
      // See docs/migration-ownership-partner-0049.md.
      "0047_partner_owner_invariant_tenants_rls.sql",
      "0048_partner_location_snapshot_search_path.sql",
      "0049_partner_grading_work_items.sql",
      // 0050 is GRANT-ONLY: it gives partner_connector_runtime an RLS-scoped, column-level SELECT
      // on partner_profiles(tenant_id, trading_name) so the connector importer can record the
      // approved partner trading name in the immutable certificate origin snapshot 0035 created.
      // It creates no object, modifies no row, and grants no write privilege. Its rollback is
      // intentionally named rollback-0050-partner-connector-profile-read.sql (non-numbered) so the
      // runner never applies it.
      "0050_partner_connector_profile_read.sql",
      // Security repair, not a schema change: revokes the INSERT/UPDATE/DELETE that
      // 0001's blanket grant loop gave partner_runtime on the two super-admin-write-only
      // kill-switch tables, and splits the feature-flag policy so its permissive
      // `tenant_id IS NULL` branch governs SELECT only. It adds no table or column, so
      // the Drizzle-parity assertions above are unaffected by design.
      //
      // NUMBER ARBITRATED by the release coordinator against staging's schema_migrations
      // (36 rows applied), after an initial collision at 0050:
      //   0045 permanently unused — anything placed there is born un-rollbackable, because
      //        0046 is already applied on staging
      //   0046 partner_mfa_pending_lifecycle          APPLIED ON STAGING
      //   0047 partner_owner_invariant_tenants RLS    (concurrent renumbering branch)
      //   0048 location snapshot search_path          (concurrent renumbering branch)
      //   0049 grading bridge, renumbered from 0045   (concurrent renumbering branch)
      //   0050 connector profile-read GRANT           (committed on the origin-trading-name branch)
      //   0051 this file
      "0051_partner_runtime_flag_control_least_privilege.sql",
      // Security repair, not a schema change: revokes the dead partner_connector_runtime grant on
      // the two internal-evidence tables and adds RLS to them, splits the partner_service_tiers
      // policy so its permissive `tenant_id IS NULL` branch governs SELECT only (A8-F7), and
      // replaces 0049's table-level cert_counter grant with column-level grants that exclude
      // UPDATE(id) (A8-F5). It adds no table and no column, so the Drizzle-parity assertions above
      // are unaffected by design.
      //
      // 0052 continues the arbitrated numbering recorded above: 0045 stays permanently unused, and
      // 0046 (staging-applied) through 0051 are taken, so the next free number is 0052.
      "0052_partner_internal_evidence_rls.sql",
      // 0053 adds failed_mfa_count / mfa_locked_until to partner_users. Deliberately NOT reusing
      // failed_login_count/locked_until: a successful login zeroes those, so an attacker holding a
      // phished password owns a counter-reset primitive and the shared lock would never arm.
      "0053_partner_mfa_failure_lockout.sql",
      // 0054 closes the half of A8-F5 that 0052's column-level narrowing does NOT reach. 0052
      // revoked UPDATE(id) so the allocator row cannot be RE-POINTED, but `last_issued` must keep
      // UPDATE because that IS the increment — so re-seeding it to 0, rewinding it, or upserting
      // `ON CONFLICT (id) DO UPDATE SET last_issued = 0` all still produced the identical
      // platform-wide certificate-number collision, HQ's own certificates included. A privilege
      // cannot express "increment only", so the constraint lives where OLD and NEW exist: an
      // ENABLE ALWAYS BEFORE UPDATE OR DELETE trigger, plus a TRUNCATE guard. It also CREATEs
      // cert_counter when absent (it is otherwise created at application boot by
      // storage.ts:ensureCertCounterTable), because a silently absent integrity guard is the
      // failure mode it exists to remove — so unlike its two siblings this file is NOT purely a
      // privilege change, though it adds no column to any Drizzle-modelled table.
      "0054_cert_counter_monotonic_allocator.sql",
      // Security repair, not a schema change: pins search_path and schema-qualifies 0017's
      // partner_credit_ledger_preserve_active_reservations(), which was SECURITY INVOKER with
      // proconfig NULL and three unqualified reads and so was pg_temp-shadowable. Its post-flight
      // additionally SWEEPS THE CLASS — no plpgsql/sql function in public may combine a NULL
      // proconfig with an unqualified relation reference — because 0048 fixed one instance of this
      // primitive and did not sweep, which is how the same defect sat in 0017 guarding money.
      "0055_partner_ledger_preserve_search_path.sql",
      // Security repair, not a schema change: completes the defence-in-depth layer 0051 described
      // ("if a future blanket GRANT hands DELETE back, the row is still unreachable") but applied
      // only to partner_feature_flags. partner_emergency_controls, partner_internal_notes and
      // partner_management_audit kept FOR ALL tenant-equality policies, which admit the tenant's
      // OWN rows into UPDATE/DELETE — and on those three tables the tenant's own rows ARE the
      // asset. Emergency controls keep the tenant-scoped SELECT readEmergencyState() depends on;
      // the two evidence tables are denied entirely. Adds no table and no column.
      "0056_partner_hq_control_tables_write_deny.sql",
    ]);
  });

  it("0002 auth tables are migration-authoritative (raw-SQL access) and intentionally NOT in Drizzle", () => {
    const m0002 = readFileSync(join(process.cwd(), "migrations", "0002_partner_auth_support.sql"), "utf8");
    for (const t of ["partner_password_reset_tokens", "partner_recovery_codes"]) {
      expect(m0002.includes(t), `${t} should be created in migration 0002`).toBe(true);
      expect(drizzleTableNames().includes(t), `${t} is raw-SQL accessed, not Drizzle-modelled`).toBe(false);
    }
  });

  it("0031 user-management additions are migration-authoritative raw-SQL surfaces", () => {
    const m0031 = readFileSync(join(process.cwd(), "migrations", "0031_partner_user_management.sql"), "utf8");
    expect(m0031).toContain("CREATE TABLE IF NOT EXISTS partner_invitations");
    expect(m0031).toContain("ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS first_name");
    expect(m0031).toContain("ALTER TABLE partner_users ADD COLUMN IF NOT EXISTS last_name");
    expect(drizzleTableNames().includes("partner_invitations")).toBe(false);
  });

  it("0032 final-owner invariant is migration-authoritative raw-SQL surface", () => {
    const m0032 = readFileSync(join(process.cwd(), "migrations", "0032_partner_final_owner_invariant.sql"), "utf8");
    expect(m0032).toContain("CREATE TABLE IF NOT EXISTS partner_owner_invariant_tenants");
    expect(m0032).toContain("CREATE CONSTRAINT TRIGGER partner_users_final_owner_invariant");
    expect(drizzleTableNames().includes("partner_owner_invariant_tenants")).toBe(false);
  });

  it("all Drizzle partner table names are partner_* (classified by the registry)", () => {
    for (const t of drizzleTableNames()) expect(t.startsWith("partner_")).toBe(true);
  });

  it("every Drizzle column name exists in the migration's CREATE TABLE for that table (F5 — column drift guard)", () => {
    // Parse the migration's CREATE TABLE column names per table.
    const tableCols = new Map<string, Set<string>>();
    const blockRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/gi;
    let b: RegExpExecArray | null;
    while ((b = blockRe.exec(migration)) !== null) {
      const [, table, body] = b;
      const cols = new Set<string>();
      for (const line of body.split("\n")) {
        const m = line.match(/^\s*([a-z_]+)\s+/i);
        // skip constraint/PK/UNIQUE lines
        if (m && !/^(primary|unique|constraint|foreign|check)$/i.test(m[1])) cols.add(m[1]);
      }
      tableCols.set(table, cols);
    }
    // ALTER TABLE ... ADD COLUMN (org tenant_id)
    const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/gi;
    let a: RegExpExecArray | null;
    while ((a = alterRe.exec(migration)) !== null) tableCols.get(a[1])?.add(a[2]);

    for (const table of Object.values(partnerSchema).filter((v): v is PgTable => is(v, PgTable))) {
      const name = getTableName(table);
      const migCols = tableCols.get(name);
      expect(migCols, `migration has no CREATE TABLE for ${name}`).toBeTruthy();
      for (const col of Object.values(getTableColumns(table))) {
        expect(migCols!.has(col.name), `column ${name}.${col.name} missing from migration`).toBe(true);
      }
    }
  });

  it("migration enables RLS + FORCE and uses the fail-closed partner_current_tenant() helper", () => {
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/CREATE POLICY/i);
    // the helper coerces unset/empty/malformed context -> NULL -> 0 rows (fail closed).
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION partner_current_tenant\(\) RETURNS uuid/i);
    expect(migration).toMatch(/nullif\(current_setting\('app\.tenant_id', true\), ''\)::uuid/);
    expect(migration).toMatch(/WHEN invalid_text_representation THEN\s*\n?\s*RETURN NULL/i);
    expect(migration).toMatch(/tenant_id = partner_current_tenant\(\)/);
  });

  it("the RLS loop covers all 11 tenant-scoped tables (not the 3 global reference tables)", () => {
    const tenantScoped = [
      "partner_organisations",
      "partner_locations",
      "partner_users",
      "partner_user_locations",
      "partner_user_roles",
      "partner_sessions",
      "partner_mfa_methods",
      "partner_feature_flags",
      "partner_audit_events",
      "partner_security_events",
      "partner_emergency_controls",
    ];
    // the RLS ARRAY literal is repeated (enable loop + grant loop); assert each tenant table is in it.
    for (const t of tenantScoped) expect(migration).toContain(`'${t}'`);
    // global reference tables must NOT be RLS-looped (they are granted SELECT only).
    for (const g of ["partner_roles", "partner_permissions", "partner_role_permissions"]) {
      expect(migration).toMatch(new RegExp(`GRANT SELECT ON[^;]*${g}`));
    }
  });
});
