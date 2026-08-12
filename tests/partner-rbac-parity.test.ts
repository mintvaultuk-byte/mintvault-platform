/**
 * Partner RBAC — TypeScript ⇄ SQL parity, enforced in BOTH directions.
 *
 * WHY THIS FILE EXISTS
 * Under the approved hybrid architecture the Partner RBAC catalogue has TWO renderings:
 *   1. the canonical TypeScript maps — PARTNER_ROLE_CODES, PARTNER_PERMISSIONS, ROLE_PERMISSIONS,
 *      ROLE_LABELS — which the application reasons about, and
 *   2. migrations/0034_partner_rbac_seed.sql, which actually creates the rows.
 * They must describe ONE catalogue. The single genuine weakness of migration-based seeding is that
 * these two can drift silently; this file is the guard that converts drift into a red build.
 *
 * It is a PURE PARSE — no database, no server, so it runs in every environment on every commit
 * rather than only where a disposable PostgreSQL is available. The runtime behaviour of the
 * migration is proved separately in tests/partner-rbac-migration.test.ts against real PostgreSQL 17.
 *
 * REPOSITORY RULE THIS ENFORCES (docs/partner-rbac-change-policy.md):
 * every RBAC addition, change or revocation requires a numbered migration AND a matching TypeScript
 * change. Neither alone will pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARTNER_ROLE_CODES } from "../shared/partner-schema";
import {
  PARTNER_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  partnerRbacBlocksReadiness,
} from "../server/partner/permissions";

const MIGRATION = "0034_partner_rbac_seed.sql";
const sql = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
const ADDITIVE_MIGRATION = "0073_lineage_convergence.sql";
const additiveSql = readFileSync(join(process.cwd(), "migrations", ADDITIVE_MIGRATION), "utf8");

/** Body of the `INSERT INTO _rbac_roles ... VALUES (...);` block. */
function parseMigrationRoles(): Array<{ code: string; label: string }> {
  const block = sql.match(/INSERT INTO _rbac_roles \(code, label\) VALUES([\s\S]*?);/);
  if (!block) throw new Error(`${MIGRATION}: could not locate the _rbac_roles VALUES block`);
  const out: Array<{ code: string; label: string }> = [];
  for (const m of block[1].matchAll(/\('([^']+)',\s*'((?:[^']|'')*)'\)/g)) {
    out.push({ code: m[1], label: m[2].replace(/''/g, "'") });
  }
  return out;
}

function parseMigrationPermissions(): string[] {
  const block = sql.match(/INSERT INTO _rbac_perms \(code\) VALUES([\s\S]*?);/);
  if (!block) throw new Error(`${MIGRATION}: could not locate the _rbac_perms VALUES block`);
  return [...block[1].matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
}

/**
 * Mappings as the migration actually expresses them: a cross join granting the FULL permission set
 * to the roles named in the `IN (...)` clause, plus an explicit VALUES list for every other role.
 * Parsing it this way (rather than pattern-matching 70 literal pairs) keeps the test honest about
 * what the migration really does — a change to either half is detected.
 */
function parseMigrationMappings(allPermissions: string[]): Set<string> {
  const out = new Set<string>();

  const crossJoin = sql.match(/WHERE r\.code IN \(([^)]*)\)\s*\nUNION ALL/);
  if (!crossJoin) throw new Error(`${MIGRATION}: could not locate the full-permission-set cross join`);
  for (const m of crossJoin[1].matchAll(/'([^']+)'/g)) {
    for (const perm of allPermissions) out.add(`${m[1]}|${perm}`);
  }

  const explicit = sql.match(/UNION ALL\s*\nSELECT \* FROM \(VALUES([\s\S]*?)\) AS v\(role_code, permission_code\)/);
  if (!explicit) throw new Error(`${MIGRATION}: could not locate the explicit mapping VALUES block`);
  for (const m of explicit[1].matchAll(/\('([^']+)',\s*'([^']+)'\)/g)) out.add(`${m[1]}|${m[2]}`);

  return out;
}

function typescriptMappings(): Set<string> {
  const out = new Set<string>();
  for (const code of PARTNER_ROLE_CODES) for (const perm of ROLE_PERMISSIONS[code]) out.add(`${code}|${perm}`);
  return out;
}

describe("Partner RBAC parity — TypeScript ⇄ migration 0034", () => {
  const migRoles = parseMigrationRoles();
  const migPerms = [...parseMigrationPermissions()];
  for (const match of additiveSql.matchAll(/VALUES \('([^']+)',\s*'[^']+'\)/g)) {
    if (!migPerms.includes(match[1])) migPerms.push(match[1]);
  }
  const migMaps = parseMigrationMappings(migPerms);
  const additivePermission = additiveSql.match(/p\.code = '([^']+)'/)?.[1];
  const additiveRoles = additiveSql.match(/r\.code IN \(([^)]*)\)/)?.[1];
  if (!additivePermission || !additiveRoles) throw new Error(`${ADDITIVE_MIGRATION}: could not parse grant`);
  for (const match of additiveRoles.matchAll(/'([^']+)'/g)) {
    migMaps.add(`${match[1]}|${additivePermission}`);
  }
  const tsMaps = typescriptMappings();

  // Guard the parser itself: if a refactor of the SQL silently defeats these regexes, every
  // comparison below would trivially pass on empty sets. That would be a worse failure than drift.
  it("parses a non-empty catalogue out of the migration (parser sanity)", () => {
    expect(migRoles.length, "no roles parsed — the parser or the migration shape changed").toBeGreaterThan(0);
    expect(migPerms.length, "no permissions parsed").toBeGreaterThan(0);
    expect(migMaps.size, "no mappings parsed").toBeGreaterThan(0);
  });

  // ---- 1 & 2: roles, both directions -------------------------------------------------
  it("1. every TypeScript role exists in migration 0034", () => {
    const inMigration = new Set(migRoles.map((r) => r.code));
    for (const code of PARTNER_ROLE_CODES) {
      expect(inMigration.has(code), `role ${code} is in TypeScript but missing from ${MIGRATION}`).toBe(true);
    }
  });

  it("2. every migration role exists in TypeScript", () => {
    const inTs = new Set<string>(PARTNER_ROLE_CODES);
    for (const r of migRoles) {
      expect(inTs.has(r.code), `role ${r.code} is in ${MIGRATION} but missing from PARTNER_ROLE_CODES`).toBe(true);
    }
  });

  // ---- 3 & 4: permissions, both directions -------------------------------------------
  it("3. every TypeScript permission exists in migration 0034", () => {
    const inMigration = new Set(migPerms);
    for (const perm of PARTNER_PERMISSIONS) {
      expect(inMigration.has(perm), `permission ${perm} is in TypeScript but missing from ${MIGRATION}`).toBe(true);
    }
  });

  it("4. every migration permission exists in TypeScript", () => {
    const inTs = new Set<string>(PARTNER_PERMISSIONS);
    for (const perm of migPerms) {
      expect(inTs.has(perm), `permission ${perm} is in ${MIGRATION} but missing from PARTNER_PERMISSIONS`).toBe(true);
    }
  });

  // ---- 5 & 6: mappings, both directions ----------------------------------------------
  it("5. every TypeScript role-permission mapping exists in migration 0034", () => {
    const missing = [...tsMaps].filter((k) => !migMaps.has(k));
    expect(missing, `mappings in TypeScript but missing from ${MIGRATION}`).toEqual([]);
  });

  it("6. every migration mapping exists in TypeScript", () => {
    const extra = [...migMaps].filter((k) => !tsMaps.has(k));
    expect(extra, `mappings in ${MIGRATION} but missing from ROLE_PERMISSIONS`).toEqual([]);
  });

  // ---- 7: labels and codes match exactly ---------------------------------------------
  it("7. role labels and permission labels match exactly", () => {
    for (const r of migRoles) {
      const code = r.code as (typeof PARTNER_ROLE_CODES)[number];
      expect(r.label, `label for role ${r.code} disagrees between ${MIGRATION} and ROLE_LABELS`).toBe(
        ROLE_LABELS[code]
      );
    }
    // Permissions are seeded as (code, code): the canonical rendering of a permission label IS its
    // code, and 0034's Guard 1 refuses to run over a row that says otherwise.
    expect(sql).toMatch(/INSERT INTO partner_permissions \(code, label\)\s*\n\s*SELECT code, code FROM _rbac_perms/);
  });

  // ---- 7b: the migration's own guards must remain present -----------------------------
  /*
   * FOUND BY MUTATION TESTING: deleting 0034's completeness assertion survived the entire suite.
   * Every runtime scenario seeds successfully, so the assertion never fires and its absence was
   * invisible — the same shape as the original defect, where the thing that never runs is the thing
   * nobody notices is missing. These are source assertions, the technique the repository already
   * uses for "the call site was deleted" mutations.
   */
  it("7b. migration 0034 keeps its fail-loud guards and completeness assertion", () => {
    expect(sql, "conflicting-role guard must RAISE, not warn").toMatch(
      /RAISE EXCEPTION\s*\n\s*'0034 refuses to run: % existing partner_roles row/
    );
    expect(sql, "conflicting-permission guard must RAISE, not warn").toMatch(
      /RAISE EXCEPTION\s*\n\s*'0034 refuses to run: existing partner_permissions row/
    );
    expect(sql, "completeness assertion must RAISE, not warn").toMatch(
      /RAISE EXCEPTION\s*\n\s*'0034 completeness assertion failed/
    );
    // An unknown extra row must be REPORTED, never deleted — revocation is a numbered migration.
    expect(sql).toMatch(/RAISE NOTICE '0034: partner_roles holds role\(s\) unknown/);
    expect(sql, "seeding must never delete from the catalogue").not.toMatch(
      /DELETE\s+FROM\s+partner_(roles|permissions|role_permissions)/i
    );
  });

  // ---- 8: no duplicates ---------------------------------------------------------------
  it("8. no duplicate roles, permissions or mappings on either side", () => {
    const migRoleCodes = migRoles.map((r) => r.code);
    expect(new Set(migRoleCodes).size, "duplicate role in the migration").toBe(migRoleCodes.length);
    expect(new Set(migPerms).size, "duplicate permission in the migration").toBe(migPerms.length);
    expect(new Set(PARTNER_ROLE_CODES).size, "duplicate role in PARTNER_ROLE_CODES").toBe(PARTNER_ROLE_CODES.length);
    expect(new Set(PARTNER_PERMISSIONS).size, "duplicate permission in PARTNER_PERMISSIONS").toBe(
      PARTNER_PERMISSIONS.length
    );
    for (const code of PARTNER_ROLE_CODES) {
      const grants = ROLE_PERMISSIONS[code];
      expect(new Set(grants).size, `duplicate grant inside ROLE_PERMISSIONS.${code}`).toBe(grants.length);
    }
    // Sizes agreeing is what proves neither side quietly carries an extra pair.
    expect(migMaps.size, "mapping count disagrees between the migration and TypeScript").toBe(tsMaps.size);
  });

  // ---- 9: mutation guard --------------------------------------------------------------
  /*
   * Checks 1-8 above ARE the bidirectional guard: adding or removing anything on either side breaks
   * at least one of them. This test states that contract explicitly by simulating each mutation
   * against the same comparison logic, so the protection cannot be quietly weakened by an edit that
   * leaves the earlier assertions technically passing.
   */
  it("9. adding or removing a role, permission or mapping on either side fails the comparison", () => {
    const migRoleSet = new Set(migRoles.map((r) => r.code));
    const tsRoleSet = new Set<string>(PARTNER_ROLE_CODES);

    // role removed from TypeScript -> direction 2 catches it
    const tsRolesMinusOne = new Set([...tsRoleSet].filter((c) => c !== "PARTNER_TRAINEE"));
    expect([...migRoleSet].some((c) => !tsRolesMinusOne.has(c))).toBe(true);

    // role removed from the migration -> direction 1 catches it
    const migRolesMinusOne = new Set([...migRoleSet].filter((c) => c !== "PARTNER_TRAINEE"));
    expect([...tsRoleSet].some((c) => !migRolesMinusOne.has(c))).toBe(true);

    // permission added on one side only -> directions 3/4 catch it
    const migPermsPlus = new Set([...migPerms, "partner.invented.permission"]);
    expect([...migPermsPlus].some((p) => !new Set<string>(PARTNER_PERMISSIONS).has(p))).toBe(true);

    // mapping removed from the migration -> direction 5 catches it
    const anyMapping = [...tsMaps][0];
    const migMapsMinusOne = new Set([...migMaps].filter((k) => k !== anyMapping));
    expect([...tsMaps].some((k) => !migMapsMinusOne.has(k))).toBe(true);

    // mapping added to the migration only -> direction 6 catches it
    const migMapsPlus = new Set([...migMaps, "PARTNER_TRAINEE|partner.orders.cancel"]);
    expect([...migMapsPlus].some((k) => !tsMaps.has(k))).toBe(true);
  });

  // ---- 10: revocation cannot happen at runtime ----------------------------------------
  /*
   * Proved empirically on PostgreSQL 17 before this architecture was chosen: additive
   * ON CONFLICT DO NOTHING seeding never revokes, so a grant deleted from TypeScript would persist
   * in the database indefinitely. Under the hybrid the runtime cannot revoke either — by design,
   * because silent mass de-authorisation on a bad deploy is far worse than a stale grant. Revocation
   * must therefore be a numbered migration. This test pins that the runtime path stays read-only.
   */
  it("10. a permission revocation cannot be achieved through runtime validation", () => {
    const src = readFileSync(join(process.cwd(), "server", "partner", "permissions.ts"), "utf8");
    const validator = src.slice(
      src.indexOf("export async function validatePartnerRbac"),
      src.indexOf("export function partnerRbacBlocksReadiness")
    );
    expect(validator.length, "could not isolate validatePartnerRbac()").toBeGreaterThan(0);
    for (const forbidden of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "MERGE"]) {
      expect(
        new RegExp(`\\b${forbidden}\\b`).test(validator),
        `validatePartnerRbac() must never issue ${forbidden} — the runtime may not mutate the Partner security catalogue`
      ).toBe(false);
    }

    // The boot path must call the validator, never the seeder.
    const index = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");
    expect(index).toMatch(/validatePartnerRbacAtBoot\(\);/);
    expect(index).not.toMatch(/bootstrapPartnerRbac|seedPartnerRbac/);

    // And the seeder itself must be guarded against ever becoming a production call site.
    expect(src).toMatch(/seedPartnerRbac\(\) is test-only/);
  });
});

describe("Partner RBAC readiness semantics", () => {
  /*
   * The rule that the original blocker violated: an absent catalogue was reported as healthy. These
   * are pure decisions with no database, so they run everywhere on every commit.
   */
  it("a complete catalogue never blocks readiness", () => {
    expect(partnerRbacBlocksReadiness("ready", true)).toBe(false);
    expect(partnerRbacBlocksReadiness("ready", false)).toBe(false);
  });

  it("not_configured is healthy ONLY while the Partner surface is switched off", () => {
    expect(partnerRbacBlocksReadiness("not_configured", false), "surface off — deliberately not a fault").toBe(false);
    expect(
      partnerRbacBlocksReadiness("not_configured", true),
      "surface ON with no catalogue must fail closed — this is exactly how the original blocker hid"
    ).toBe(true);
  });

  it("incomplete, unavailable and pending always block readiness", () => {
    for (const state of ["incomplete", "unavailable", "pending"] as const) {
      expect(partnerRbacBlocksReadiness(state, true), `${state} with surface on`).toBe(true);
      expect(partnerRbacBlocksReadiness(state, false), `${state} with surface off`).toBe(true);
    }
  });

  it("the readiness route returns fixed codes and a static remedy — never raw database text", () => {
    const route = readFileSync(join(process.cwd(), "server", "partner", "partner-management-routes.ts"), "utf8");
    const handler = route.slice(
      route.indexOf('r.get("/readiness"'),
      route.indexOf("r.use(requirePartnerAdminCapability)")
    );
    expect(handler.length, "could not isolate the readiness handler").toBeGreaterThan(0);

    // The previous implementation returned `rbac.error`, which carried database error text.
    expect(handler, "raw error text must never be returned").not.toMatch(/error:\s*rbac\.error/);
    expect(handler).toMatch(/PARTNER_RBAC_NOT_SEEDED/);
    // Flag resolution must fail CLOSED: an unreadable flag store cannot downgrade a real fault.
    expect(handler).toMatch(/catch\s*\{\s*partnerSurfaceEnabled = true;/);

    // The core probe must remain untouched by Partner reference-data faults.
    const index = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");
    const ready = index.slice(index.indexOf('"/ready"'), index.indexOf('"/ready"') + 1200);
    expect(ready, "core /ready must not depend on Partner RBAC").not.toMatch(/partner_roles|PartnerRbac/);
  });
});
