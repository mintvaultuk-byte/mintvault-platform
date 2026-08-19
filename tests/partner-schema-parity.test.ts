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
      "0044_partner_mfa_pending_lifecycle.sql",
      // Distributed Grading Network foundation: station identity/calibration,
      // durable derivative jobs, and server-owned opaque evidence staging.
      // These are deliberately migration-authoritative raw-SQL surfaces.
      "0045_partner_stations.sql",
      "0046_scanner_processing_jobs.sql",
      "0047_scanner_evidence_staging.sql",
      // 0074 widens partner submission lifecycle states after handover and stores an immutable
      // location-name snapshot. It also permits the audited wallet-only staging backfill action.
      //
      // RENUMBERED from 0044 to 0074 during the 2026-08-11 mainline reconciliation. Production had
      // already applied a DIFFERENT 0044 (the MFA pending lifecycle above), and the runner
      // rejects duplicate NUMBERS before it runs anything — so the two could not coexist. The
      // MFA file could not move (renaming an applied migration makes it pending again and
      // re-runs it); this one was unapplied everywhere the release targets, so it moved instead.
      //
      // SIBLING MERGE (2026-08-11): the canonical lineage carried the SAME MFA migration at
      // 0046 (staging's applied identity). Both copies are byte-identical, and keeping both
      // put TWO files on number 0046 (the other being 0046_scanner_processing_jobs), which the
      // runner rejects at file-collection time — before any database is even opened. The 0046
      // copy was therefore dropped and production's 0044 identity kept, because production is
      // this release's target. Staging's applied 0046 journal row is untouched and is simply
      // orphaned: planMigrations() iterates FILES, not journal rows, so a journalled migration
      // with no file is ignored rather than reverted. Applied history stays immutable on both
      // hosts; per-environment delivery is what --only + --convergence-mode exists for.
      "0073_lineage_convergence.sql",
      "0074_partner_submission_lifecycle_and_location_snapshot.sql",
      "0075_partner_station_single_active_capture.sql",
      "0076_partner_pilot_certificate_allocation.sql",
      // 0077 (partner credential lifecycle hardening) is additive: it adds
      // partner_users.password_set_at, collapses partner_password_reset_tokens to one live
      // link per user (partial unique index), and re-declares partner_auth_lookup() to
      // project the new column. This and the following connector grant are forward-only
      // migrations; their identities must remain independently pinned.
      "0077_partner_credential_lifecycle_hardening.sql",

      "0078_partner_connector_flag_read.sql",
      // 0078 (shared partner rate-limit buckets) is additive and carries NO tenant data. It supplies
      // the shared store that server/partner/rate-limit.ts has always required but never had: the
      // only implementation was a per-process Map, so on the two-Machine production topology every
      // partner rate limit (login, MFA, password reset, invitation accept) was silently DOUBLE its
      // stated value and reset on every rolling deploy.
      //
      // Deliberately has no tenant_id and no RLS: these limiters run PRE-AUTHENTICATION, keyed on an
      // IP prefix or a submitted email, when no tenant is known. It is therefore correctly outside
      // the tenant-isolation model and is excluded from the RLS coverage sweep in
      // partner-rls-isolation.test.ts, which asserts RLS only for partner_% tables HAVING tenant_id.
      //
      // Safe either side of the deploy: the application probes for the table and falls back to the
      // in-memory store when it is absent, so this may be applied before or after the release.
      // (Pinned at its renumbered position 0089, below.)
      // 0079 (admin password-step lockout) is not a partner migration; this pin covers EVERY
      // numbered migration so any addition is consciously acknowledged. It adds
      // users.password_failed_count / password_locked_until, mirroring the PIN step's long-standing
      // durable lockout (server/pin.ts). The password step previously had no persistent counter at
      // all — only a per-process Map and an express-rate-limit MemoryStore — so on two Machines the
      // advertised budget was double and every rolling deploy reset it, on the highest-privilege
      // credential in the system. Additive with defaults, so it is old-version-safe.
      "0079_admin_password_lockout.sql",
      // 0080 introduces the CANONICAL PARTNER CARD JOB — the entity the whole partner programme is
      // specified in terms of, which did not previously exist in any form (a repo-wide search for
      // card_job/cardJob/grading_job returned zero hits). One row per PAID UNIT, keyed
      // (card_id, ordinal) to match the credit system's existing expansion convention exactly, with
      // real foreign keys replacing the nullable-text coupling that previously joined a spent credit
      // to an MV number by string comparison. Enforces I1 (MV/certificate unique and immutable once
      // allocated), I2 (a reservation funds at most one job), I7 (identity columns immutable) and the
      // legal transition graph, all in the database rather than in scattered guard clauses.
      // Purely additive: one new table; no existing table altered.
      "0080_partner_card_jobs.sql",
      // 0081 makes the Card Job's identity actually get WRITTEN. 0080 gave a job somewhere to record
      // certificate_id/mv_number and made it immutable once set, but nothing wrote it — the connector
      // allocated a certificate against the destination submission_items and the job stayed NULL
      // forever, so a job could never legally reach READY_TO_GRADE. This replaces
      // partner_allocate_import_certificates() so the SAME loop iteration that mints an MV and
      // inserts a certificate stamps the corresponding source Card Job, aborting the whole
      // allocation if any position fails to bind exactly one job.
      "0081_partner_card_job_certificate_binding.sql",
      // 0082 supplies the (station_id, client_op_id) idempotency contract, which did not exist in any
      // form (a repo-wide search for partner_op_keys/client_op_id returned zero hits). The credit
      // engine was already idempotent, but only on SERVER-DERIVED keys — which a Scanner pressing
      // NEW cannot provide, because there is no submission yet to derive one from. Append-only and
      // write-once by trigger; the composite FK (card_job_id, tenant_id) makes a cross-tenant
      // operation record structurally impossible.
      "0082_partner_card_job_op_keys.sql",
      // 0083 catalogues the Grading Credit packs (5/10/25/50/100) and seeds the
      // partner.credits.purchase permission. stripe_price_id is NULLABLE and every seeded pack starts
      // NULL, so the whole flow is complete and testable while the £ amounts remain an owner
      // decision — setting prices later is a DATA change, not a migration or a deploy. Global
      // reference data: no tenant_id, and therefore correctly outside the RLS coverage sweep.
      "0083_partner_credit_packs.sql",
      // 0084 adds NO table and NO column. partner_locations has been multi-location capable since
      // 0001; the only DB-level blocker was that partner_management_audit.action_type is
      // CHECK-constrained, so the new administrative actions could not be recorded honestly. It
      // widens that constraint (preserving every earlier value verbatim) and adds a live-name
      // uniqueness index plus a tenant+status index. Nothing to add to Drizzle.
      "0084_partner_location_management.sql",
      // 0085 adds NO table and NO column either. It seeds the SCANNER_OPERATOR role plus the two
      // capabilities AG-2 split out of partner.cards.scan (partner.stations.enrol,
      // partner.cards.fix), both granted to exactly the roles that already held cards.scan — so no
      // existing role changed. Catalogue data, not schema.
      "0085_partner_scanner_operator_role.sql",
      // 0086 adds ONE nullable column, partner_sessions.last_step_up_at, recording when a session
      // last re-proved its human. partner_sessions is migration-authoritative (raw SQL, like the
      // 0002 auth tables) and deliberately outside Drizzle, so there is no model to update.
      "0086_partner_session_step_up.sql",
      // 0087 adds partner_grading_leases: at most ONE active editor per Card Job, enforced by a
      // partial UNIQUE index rather than application logic, because a SELECT-then-INSERT check is
      // not enforcement — two concurrent acquires interleave between the read and the write.
      // Raw-SQL surface like the other station/scanner tables; deliberately outside Drizzle.
      "0087_partner_grading_edit_lease.sql",
      // 0088 gives the NFC facility its FIRST migration. Its twelve columns were hand-applied to
      // production in March 2026 and shared/schema.ts has no index callback at all, so `nfc_uid`
      // carried no UNIQUE index: "one tag, one certificate" was a read-then-write that two
      // concurrent binds both pass. Adds a partial unique index on lower(nfc_uid) — lower(), because
      // the read guard is already case-insensitive while the write is not. Additive; index only.
      "0088_nfc_binding_integrity.sql",
      // RENUMBERED 0078 -> 0089 (owner-authorised, 2026-08-14). Concurrent work on origin/main landed
      // a different migration at 0078 (0078_partner_connector_flag_read.sql), so the release lineage
      // and main each held a distinct 0078 — the same collision that put two files on 0046. A
      // read-only journal inspection confirmed NEITHER 0078 was applied on production (highest 0076)
      // or staging (highest 0073), so the unapplied one was free to move; main's lineage is canonical
      // and kept the number. Creates one self-contained table, so the later position is order-safe.
      "0089_partner_shared_rate_limit_buckets.sql",
      // 0090 is the forward-only convergence for STAGING-lineage hosts (2026-08-14). The absorb of
      // production v1078 shipped production's immutable scanner trio at 0045/0046/0047 — but
      // staging's journal holds a DIFFERENT lineage at 0044/0046/0047, so the identity guard
      // (correctly) refuses those three files there forever. They are excluded per-host via
      // migrations/lineage-exclusions.json (exact incoming+occupant pairs, fail-closed), and 0090
      // — the next globally free number — verifies the MFA content and inlines the two idempotent
      // scanner bodies verbatim, so it is a no-op on production and on fresh estates.
      "0090_lineage_convergence_scanner.sql",
      "0091_capture_session_calibration_snapshot.sql",
      "0092_partner_station_calibrate_permission.sql",
      "0093_partner_credit_pack_currency.sql",
      // 0094 splits one physical scanner target from background upload/finalisation ownership.
      // It replaces 0075's station partial-unique index so FRONT upload can continue while the
      // same station captures BACK for the same card. Index-only replacement; owner approval is
      // still required at apply time because the migration runner flags DROP INDEX.
      "0094_scanner_capture_physical_release.sql",
      // 0096 widens partner_management_audit's action_type CHECK for the protected Card Job void
      // wrapper. Raw-SQL migration-authoritative; no Drizzle model owns this CHECK.
      "0096_partner_card_job_void_management_audit.sql",
      // 0097 records server-created Partner credit Checkout Sessions so the verified webhook can
      // reject wrong-session and wrong-tenant metadata. Raw-SQL payment authority; no Drizzle model.
      "0097_partner_credit_checkout_sessions.sql",
      // 0098 grants SCANNER_OPERATOR balance/catalogue read authority for zero-credit lockout UX.
      // Raw-SQL RBAC reference data; no Drizzle model.
      "0098_scanner_operator_credit_view.sql",
      // 0099 records one durable Checkout operation/snapshot before Stripe is called.
      "0099_partner_credit_checkout_operation_idempotency.sql",
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
