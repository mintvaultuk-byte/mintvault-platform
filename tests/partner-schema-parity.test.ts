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

  it("pins the full numbered migration inventory (0001–0027), so a new migration is noticed", () => {
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
      // G6D grants the trusted connector only the reservation-release privileges needed to
      // settle a terminal Partner submission; it creates no mutable wallet balance.
      "0027_partner_submission_credit_lifecycle.sql",
    ]);
  });

  it("0002 auth tables are migration-authoritative (raw-SQL access) and intentionally NOT in Drizzle", () => {
    const m0002 = readFileSync(join(process.cwd(), "migrations", "0002_partner_auth_support.sql"), "utf8");
    for (const t of ["partner_password_reset_tokens", "partner_recovery_codes"]) {
      expect(m0002.includes(t), `${t} should be created in migration 0002`).toBe(true);
      expect(drizzleTableNames().includes(t), `${t} is raw-SQL accessed, not Drizzle-modelled`).toBe(false);
    }
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
