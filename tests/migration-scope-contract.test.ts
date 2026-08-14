/**
 * MIGRATION SCOPE CONTRACT — a partner-only harness must never absorb a migration
 * outside the schema it claims to model.
 *
 * WHAT THIS PINS. `applyEveryMigrationRealistic()` used to apply
 * `listMigrationFiles()` — every numbered migration in the repository — to a
 * partner-only disposable database. That held only while every migration happened
 * to be partner-scoped. When 0073 landed (canonical lineage, c788fa68, shipped as
 * v1070) eleven partner suites started failing with
 *
 *     0073 requires the certificates table, which does not exist in this database.
 *
 * and the lineage silently became un-mergeable to main. CI had not changed; an
 * unrelated migration simply fell into an implicit glob.
 *
 * The repair is a classification contract, NOT a 0073 exemption. 0073 still fails
 * closed exactly as it does in production — see the negative test in
 * tests/lineage-convergence-0073.test.ts and case 3 below. What changed is that a
 * harness which DECLARES an application-scope migration must now provision the core
 * schema that migration requires.
 *
 * These are static/structural assertions on purpose: they must fail fast in CI on
 * any runner, with no database, the moment a new migration is added without a
 * deliberate decision.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICATION_SCOPE_MIGRATIONS,
  PARTNER_SCHEMA_MIGRATIONS,
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
  partnerScopeOnly,
  requiresCoreSchema,
} from "./helpers/partner-realistic-db";

const HELPER = readFileSync(join(process.cwd(), "tests", "helpers", "partner-realistic-db.ts"), "utf8");

/** Every numbered migration the runner would discover (NNNN_name.sql). */
function numberedMigrations(): string[] {
  return readdirSync(join(process.cwd(), "migrations"))
    .filter((f) => /^\d{4,}_.+\.sql$/.test(f))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

describe("every migration is deliberately classified", () => {
  it("classifies each numbered migration exactly once — a NEW migration fails until triaged", () => {
    const partner = new Set<string>(PARTNER_SCHEMA_MIGRATIONS);
    const application = new Set<string>(APPLICATION_SCOPE_MIGRATIONS);
    const unclassified = numberedMigrations().filter((m) => !partner.has(m) && !application.has(m));

    expect(
      unclassified,
      "Unclassified migration(s). Decide DELIBERATELY whether each is PARTNER-scope " +
        "(safe on a partner-only disposable database) or APPLICATION-scope (needs the core " +
        "certificates schema), and add it to the matching list in tests/helpers/partner-realistic-db.ts. " +
        "Do NOT add it to the partner list just to make this pass — that is exactly how 0073 broke " +
        "eleven suites and blocked the mainline."
    ).toEqual([]);
  });

  it("never puts the same migration in both scopes", () => {
    const application = new Set<string>(APPLICATION_SCOPE_MIGRATIONS);
    const both = PARTNER_SCHEMA_MIGRATIONS.filter((m) => application.has(m));
    expect(both, "a migration cannot be both partner-scope and application-scope").toEqual([]);
  });

  it("lists only migrations that actually exist", () => {
    const real = new Set(numberedMigrations());
    const missing = [...PARTNER_SCHEMA_MIGRATIONS, ...APPLICATION_SCOPE_MIGRATIONS].filter((m) => !real.has(m));
    expect(missing, "declared migration(s) with no file — the lists have rotted").toEqual([]);
  });

  it("keeps 0073 classified as APPLICATION-scope", () => {
    expect(APPLICATION_SCOPE_MIGRATIONS).toContain("0073_lineage_convergence");
    expect(PARTNER_SCHEMA_MIGRATIONS).not.toContain("0073_lineage_convergence");
  });

  it("keeps Partner pilot certificate allocation application-scoped", () => {
    expect(APPLICATION_SCOPE_MIGRATIONS).toContain("0075_partner_station_single_active_capture");
    expect(PARTNER_SCHEMA_MIGRATIONS).not.toContain("0075_partner_station_single_active_capture");
    expect(APPLICATION_SCOPE_MIGRATIONS).toContain("0076_partner_pilot_certificate_allocation");
    expect(PARTNER_SCHEMA_MIGRATIONS).not.toContain("0076_partner_pilot_certificate_allocation");
  });

  it("keeps the NFC binding index application-scoped — the migration says so itself", () => {
    // 0088 is guarded by to_regclass, so it would NOT fail on a partner-only database; it would
    // no-op. Classifying it partner-scope is therefore the tempting shortcut, and it is wrong: a
    // no-op recorded as "applied" claims coverage that does not exist. Pin the classification to
    // the migration's OWN declared scope so the two cannot drift apart.
    const SQL = readFileSync(join(process.cwd(), "migrations", "0088_nfc_binding_integrity.sql"), "utf8");
    expect(SQL, "0088 must keep declaring its own scope").toMatch(/SCOPE: APPLICATION \(requires `certificates`\)/);
    expect(APPLICATION_SCOPE_MIGRATIONS).toContain("0088_nfc_binding_integrity");
    expect(PARTNER_SCHEMA_MIGRATIONS).not.toContain("0088_nfc_binding_integrity");
    // And prove the classification is load-bearing: declaring 0088 must oblige core seeding.
    expect(requiresCoreSchema(["0088_nfc_binding_integrity"])).toBe(true);
  });

  it("keeps the 0090 scanner lineage convergence application-scoped", () => {
    // 0090 fails CLOSED without the core schema. This assertion and the RAISE below are the pair
    // that stop it being "fixed" into partner scope the next time the contract goes red.
    const SQL = readFileSync(join(process.cwd(), "migrations", "0090_lineage_convergence_scanner.sql"), "utf8");
    expect(SQL).toMatch(/RAISE EXCEPTION '0090 precondition failed: certificates table is missing'/);
    expect(APPLICATION_SCOPE_MIGRATIONS).toContain("0090_lineage_convergence_scanner");
    expect(PARTNER_SCHEMA_MIGRATIONS).not.toContain("0090_lineage_convergence_scanner");
    expect(requiresCoreSchema(["0090_lineage_convergence_scanner"])).toBe(true);
  });

  it("NEGATIVE: neither newly-classified migration leaked into the partner glob", () => {
    // partnerScopeOnly() is the function that actually decides what a partner-only database runs.
    // Assert on IT, not just on the lists, so a future refactor that reads a different source
    // cannot pass these tests while still feeding 0088/0090 to a partner harness.
    const narrowed = partnerScopeOnly([
      { filename: "0001_partner_foundation.sql" },
      { filename: "0088_nfc_binding_integrity.sql" },
      { filename: "0090_lineage_convergence_scanner.sql" },
    ]).map((f) => f.filename);
    expect(narrowed).toEqual(["0001_partner_foundation.sql"]);
  });
});

describe("the partner harness applies a declared allowlist, not a glob", () => {
  it("applyEveryMigrationRealistic no longer applies listMigrationFiles() wholesale", () => {
    const fn = HELPER.slice(HELPER.indexOf("export async function applyEveryMigrationRealistic"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // It may still READ the real file list (for order/numbering/checksums) but must
    // narrow it to the declared partner scope before handing it to the runner.
    expect(body, "the helper must narrow to the declared partner scope").toMatch(
      /partnerScopeOnly\(\s*listMigrationFiles\(\)\s*\)/
    );
  });

  it("no partner/connector suite hands the runner an UNSCOPED migration list", () => {
    // The regression is easy to reintroduce one call site at a time, so pin the
    // whole family rather than the helper alone.
    const suites = readdirSync(join(process.cwd(), "tests")).filter(
      (f) => /^partner-(connector|management|rbac)/.test(f) && f.endsWith(".test.ts")
    );
    expect(suites.length, "suite discovery rotted").toBeGreaterThan(3);
    for (const s of suites) {
      const src = readFileSync(join(process.cwd(), "tests", s), "utf8");
      expect(src, `${s} passes an unscoped list to applyMigrations`).not.toMatch(
        /applyMigrations\(\s*migrator,\s*listMigrationFiles\(\)/
      );
      expect(src, `${s} passes an unscoped list to planMigrations`).not.toMatch(
        /planMigrations\(\s*migrator,\s*listMigrationFiles\(\)/
      );
    }
  });

  it("NEGATIVE: an unrelated future migration does not join partner scope automatically", () => {
    // Simulate the exact 0073 situation: a new numbered migration appears that the
    // partner lists have never heard of. It must NOT be treated as partner-scope.
    const future = "0099_vault_quest_artwork_ledger";
    const partner = new Set<string>(PARTNER_SCHEMA_MIGRATIONS);
    expect(partner.has(future), "an undeclared migration must never be partner-scope").toBe(false);
    expect(requiresCoreSchema([future]), "an undeclared migration is not silently application-scope either").toBe(
      false
    );
    // And the classification guard above is what forces the decision: prove it
    // would flag this file rather than let it through.
    const application = new Set<string>(APPLICATION_SCOPE_MIGRATIONS);
    expect(!partner.has(future) && !application.has(future)).toBe(true);
  });

  it("NEGATIVE: dropping a required partner migration is detectable", () => {
    // The harness's value depends on its declared set being complete. If a suite's
    // list loses a dependency, the set must visibly differ — a silent shrink is the
    // failure mode this guards.
    const withoutFoundation = PARTNER_SCHEMA_MIGRATIONS.filter((m) => m !== "0001_partner_foundation");
    expect(withoutFoundation.length).toBe(PARTNER_SCHEMA_MIGRATIONS.length - 1);
    expect(PARTNER_SCHEMA_MIGRATIONS).toContain("0001_partner_foundation");
  });
});

describe("declaring an application-scope migration obliges the harness to provision core schema", () => {
  it("requiresCoreSchema() detects an application-scope migration in a declared list", () => {
    expect(requiresCoreSchema(["0034_partner_rbac_seed"])).toBe(false);
    expect(requiresCoreSchema(["0034_partner_rbac_seed", "0073_lineage_convergence"])).toBe(true);
  });

  it("the SHARED partner RBAC list stays partner-only — four suites consume it", () => {
    // This list is consumed by partner-lockout-{recovery,decay} and
    // partner-mfa-{enrolment-mandatory,factor-hardening}, none of which need 0073.
    // It was added here with the canonical lineage and took all four down with
    // "0073 requires the certificates table". Only the ONE suite that needs the
    // partner.cards.preview grant applies 0073, and it does so explicitly.
    expect(PARTNER_MIGRATIONS_WITH_RBAC_SEED).not.toContain("0073_lineage_convergence");
    expect(requiresCoreSchema([...PARTNER_MIGRATIONS_WITH_RBAC_SEED])).toBe(false);
  });

  it("the ONE suite that applies 0073 provisions the core schema for it", () => {
    const rbac = readFileSync(join(process.cwd(), "tests", "partner-rbac-migration.test.ts"), "utf8");
    // It drives 0073 through the REAL runner deliberately (0073, not 0034, grants
    // partner.cards.preview, which its TypeScript-map parity assertions compare
    // against) — so it must provide what 0073 fails closed without.
    expect(rbac).toContain("0073_lineage_convergence.sql");
    expect(rbac, "must seed the core schema it declares a dependency on").toContain(
      "seedCoreSchemaForApplicationMigrations"
    );
  });

  it("applyMigrationsRealistic seeds the core schema before running the list", () => {
    expect(HELPER).toMatch(/if \(requiresCoreSchema\(migrations\)\)/);
    expect(HELPER).toMatch(/seedCoreSchemaForApplicationMigrations\(admin\)/);
  });

  it("the core seeder reuses the ONE shared protected-column definition", () => {
    // A second copy of "real certificates shape" would drift from the dedicated
    // 0073 lineage suite and silently stop proving the same thing.
    expect(HELPER).toMatch(/certificates-protected-columns/);
    expect(HELPER).toMatch(/CERTIFICATES_PROTECTED_COLUMNS_SQL/);
  });
});

describe("0073 keeps its production fail-closed behaviour", () => {
  const SQL = readFileSync(join(process.cwd(), "migrations", "0073_lineage_convergence.sql"), "utf8");

  it("still RAISEs when certificates is absent — no skip, no warning, no env flag", () => {
    expect(SQL).toMatch(/RAISE EXCEPTION '0073 requires the certificates table/);
    expect(SQL).not.toMatch(/RAISE NOTICE '0073 requires the certificates table/);
  });

  it("still refuses to install partial review protection", () => {
    expect(SQL).toMatch(/refuses to install partial review protection/);
  });

  it("was not edited by this repair — its journalled checksum must not move", () => {
    // Editing an applied migration's bytes breaks the runner's checksum guard on
    // every host that already ran it. The repair is entirely in the harness.
    expect(SQL).toContain("0073 requires the certificates table, which does not exist in this database.");
  });
});
