/**
 * AG-2 — SCANNER_OPERATOR, proven against the real seeded RBAC catalogue.
 *
 * THE PROBLEM. `partner.cards.scan` was doing three unrelated jobs at once: operate an approved
 * station, enrol a NEW one, and take an image out of grading. Only three roles held it — OWNER,
 * MANAGER and MVGS_ASSESSMENT_TECHNICIAN — and PARTNER_RECEPTION, the natural shop-floor role,
 * deliberately did not. So the only way to let somebody run the scanner was to also hand them
 * grading authority, station enrolment and the power to invalidate evidence. For the most numerous
 * role a real shop will have, that is the opposite of least privilege.
 *
 * WHAT MUST BE PROVEN, AND WHY IT NEEDS A DATABASE. The catalogue is seeded by migration and is
 * read-only at runtime, so "what can this role actually do" is a property of the SEEDED ROWS, not
 * of the TypeScript map. Asserting the map alone would prove only that we wrote down what we meant.
 * These cases apply the real migrations to a real cluster and read the grants back.
 *
 * THE ASSERTION THAT MATTERS MOST is the negative one: no existing role lost anything. Splitting a
 * permission is exactly the kind of change that quietly removes an ability from somebody who had it
 * yesterday, and a shop discovering at 9am that their manager can no longer enrol the new Mac is a
 * far worse outcome than never having added the role.
 *
 * Mutation targets: SOP1 (role exists with exactly 4 grants), SOP2 (cannot grade/buy/manage),
 * SOP3 (incumbent roles unchanged), SOP4 (routes gated on the split capabilities).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
  provisionRealisticRoles,
  seedCoreSchemaForApplicationMigrations,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { listMigrationFiles, applyMigrations } from "../scripts/db/migrate";
import { PARTNER_PERMISSIONS, ROLE_PERMISSIONS } from "../server/partner/permissions";
import { PARTNER_ROLE_CODES } from "../shared/partner-schema";

let cluster: DisposablePostgres17;
let admin: Client;

/** The four capabilities SCANNER_OPERATOR is allowed, and nothing else. */
const EXPECTED_SCANNER_OPERATOR = [
  "partner.cards.scan",
  "partner.cards.view",
  "partner.credits.view",
  "partner.location.view",
];

/** Everything the role must NOT hold, stated explicitly rather than inferred from a count. */
const FORBIDDEN_FOR_SCANNER_OPERATOR = [
  "partner.cards.assess", // no grading
  "partner.credits.purchase", // cannot spend the shop's money
  "partner.users.view",
  "partner.users.manage", // no staff management
  "partner.sessions.revoke",
  "partner.stations.enrol", // cannot bring a new Mac into service
  "partner.cards.fix", // cannot decide an image is unusable
  "partner.orders.create",
  "partner.orders.submit",
];

async function grantsFor(roleCode: string): Promise<string[]> {
  const { rows } = await admin.query<{ code: string }>(
    `SELECT p.code
       FROM partner_role_permissions rp
       JOIN partner_roles r ON r.id = rp.role_id
       JOIN partner_permissions p ON p.id = rp.permission_id
      WHERE r.code = $1
      ORDER BY p.code`,
    [roleCode]
  );
  return rows.map((r) => r.code);
}

describe("AG-2 SCANNER_OPERATOR (real seeded catalogue)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-scanner-operator-role");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    /*
     * Migration 0010 GRANTs on these MintVault-internal tables and every migration runs as the
     * non-superuser pn_migrator, so they must exist AND be owned by that role or the grant fails
     * with "permission denied for table users". Same block the sibling partner suites use.
     */
    await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
    await admin.query(`CREATE TABLE submissions (
      id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
      tracking_number text not null unique, deleted_at timestamptz,
      status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
    )`);
    await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
    await admin.query(`CREATE TABLE audit_log (
      id serial primary key, entity_type text not null, entity_id text not null, action text not null,
      admin_user text, details jsonb, created_at timestamptz not null default now()
    )`);
    for (const t of ["users", "submissions", "submission_items", "audit_log"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }
    // 0073 is APPLICATION scope and grants partner.cards.preview, so the core certificates fixture
    // has to exist before it runs — the same reason the RBAC migration suite seeds it.
    await seedCoreSchemaForApplicationMigrations(admin);
    await applyMigrationsRealistic(
      admin,
      cluster.url,
      PARTNER_MIGRATIONS_WITH_RBAC_SEED.filter((m) => m !== "0034_partner_rbac_seed")
    );
    // The catalogue migrations go through the REAL runner, in numeric order, exactly as a
    // deployment applies them.
    const files = listMigrationFiles(join(process.cwd(), "migrations")).filter(
      (f) =>
        f.filename === "0034_partner_rbac_seed.sql" ||
        f.filename === "0073_lineage_convergence.sql" ||
        f.filename === "0083_partner_credit_packs.sql" ||
        f.filename === "0085_partner_scanner_operator_role.sql" ||
        f.filename === "0092_partner_station_calibrate_permission.sql" ||
        f.filename === "0098_scanner_operator_credit_view.sql" ||
        f.filename === "0102_partner_supplies_orders.sql"
    );
    await applyMigrations(admin as never, files);
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // ---- SOP1 -------------------------------------------------------------------------------
  it("SOP1: the role is seeded and holds EXACTLY the four operational/read capabilities", async () => {
    const role = await admin.query(`SELECT label FROM partner_roles WHERE code='SCANNER_OPERATOR'`);
    expect(role.rowCount).toBe(1);
    expect(role.rows[0].label).toBe("Scanner Operator");
    expect(await grantsFor("SCANNER_OPERATOR")).toEqual([...EXPECTED_SCANNER_OPERATOR].sort());
  });

  // ---- SOP2 -------------------------------------------------------------------------------
  it("SOP2: it cannot grade, cannot touch credits, cannot manage staff or stations", async () => {
    const held = new Set(await grantsFor("SCANNER_OPERATOR"));
    for (const forbidden of FORBIDDEN_FOR_SCANNER_OPERATOR) {
      expect(held.has(forbidden), `SCANNER_OPERATOR must not hold ${forbidden}`).toBe(false);
    }
  });

  it("SOP2b: it can still do the two things it exists for — operate a station for NEW and FIX", async () => {
    const held = new Set(await grantsFor("SCANNER_OPERATOR"));
    // requireSignedStationOperator and both station FIX routes gate on exactly this.
    expect(held.has("partner.cards.scan")).toBe(true);
    // The FIX queue it selects from.
    expect(held.has("partner.cards.view")).toBe(true);
  });

  // ---- SOP3: the assertion that protects people who already had access ----------------------
  it("SOP3: NO existing role lost a capability — the split is a re-expression, not a change", async () => {
    /*
     * Before AG-2, holding partner.cards.scan implied being able to enrol a station and to
     * invalidate an image. After it, those are separate permissions. Every role that held
     * cards.scan must therefore hold both new ones, or somebody has silently lost an ability they
     * had yesterday.
     */
    for (const role of ["PARTNER_OWNER", "PARTNER_MANAGER", "MVGS_ASSESSMENT_TECHNICIAN"]) {
      const held = new Set(await grantsFor(role));
      expect(held.has("partner.cards.scan"), `${role} lost partner.cards.scan`).toBe(true);
      expect(held.has("partner.stations.enrol"), `${role} cannot enrol a station any more`).toBe(true);
      expect(held.has("partner.cards.fix"), `${role} cannot invalidate an image any more`).toBe(true);
    }
  });

  it("SOP3b: roles that never held cards.scan did NOT gain the split capabilities", async () => {
    for (const role of ["PARTNER_RECEPTION", "PARTNER_FINANCE_VIEWER", "PARTNER_TRAINEE"]) {
      const held = new Set(await grantsFor(role));
      expect(held.has("partner.cards.scan"), `${role} unexpectedly gained cards.scan`).toBe(false);
      expect(held.has("partner.stations.enrol"), `${role} unexpectedly gained stations.enrol`).toBe(false);
      expect(held.has("partner.cards.fix"), `${role} unexpectedly gained cards.fix`).toBe(false);
    }
  });

  it("SOP3c: the seeded catalogue matches the canonical TypeScript map for EVERY role", async () => {
    // The map and the migration are two renderings of one catalogue; drift between them is what
    // partner-rbac-parity guards statically. This proves it against real seeded rows.
    for (const code of PARTNER_ROLE_CODES) {
      expect(await grantsFor(code), `grants for ${code}`).toEqual([...ROLE_PERMISSIONS[code]].sort());
    }
  });

  it("SOP3d: every canonical permission exists in the seeded catalogue", async () => {
    const { rows } = await admin.query<{ code: string }>(`SELECT code FROM partner_permissions`);
    const seeded = new Set(rows.map((r) => r.code));
    for (const perm of PARTNER_PERMISSIONS) {
      expect(seeded.has(perm), `${perm} is in TypeScript but was never seeded`).toBe(true);
    }
  });
});

describe("AG-2 integration surfaces", () => {
  const stationRoutes = readFileSync("server/partner/station-routes.ts", "utf8");
  const migration = readFileSync("migrations/0085_partner_scanner_operator_role.sql", "utf8");
  const creditViewMigration = readFileSync("migrations/0098_scanner_operator_credit_view.sql", "utf8");
  const seed0034 = readFileSync("migrations/0034_partner_rbac_seed.sql", "utf8");

  /*
   * Anchored on the PATH STRING and sliced to the handler, not on `r.post("/path"` — Prettier is
   * free to split a route registration across lines, and an indexOf that misses returns -1, which
   * silently slices the tail of the file and asserts against the wrong route entirely.
   */
  function guardsFor(source: string, path: string): string {
    const idx = source.indexOf(path);
    expect(idx, `${path} not found`).toBeGreaterThan(-1);
    const handler = source.indexOf("async (req, res)", idx);
    expect(handler, `${path} has no handler`).toBeGreaterThan(idx);
    return source.slice(idx, handler);
  }

  it("SOP4: station ENROLMENT is gated on the new capability, not on cards.scan", () => {
    const enrol = guardsFor(stationRoutes, '"/stations/enrol"');
    expect(enrol).toContain('requirePartnerCapability("partner.stations.enrol")');
    expect(enrol).toContain("requireNotViewOnly");
    expect(enrol).toContain("requireNotSensitiveFrozen");
    expect(enrol).not.toContain('requirePartnerCapability("partner.cards.scan")');
  });

  it("SOP4b: image INVALIDATION is gated on cards.fix — a judgement, not a capture", () => {
    const invalidate = guardsFor(stationRoutes, '"/card-jobs/:cardJobId/invalidate-side"');
    expect(invalidate).toContain('requirePartnerCapability("partner.cards.fix")');
  });

  it("SOP4c: station OPERATION still only needs cards.scan, so a shift is not slowed down", () => {
    /*
     * `requireSignedStationOperator` is what every signed capture request passes through. The
     * capability moved from an inline literal into the middleware's own declaration when a second
     * authority (station maintenance) was added, so this asserts the declaration rather than the
     * comparison — the comparison is now shared by both middlewares and names neither.
     */
    expect(stationRoutes).toMatch(
      /async function requireSignedStationOperator[\s\S]{0,400}?capability: "partner\.cards\.scan"/
    );
    expect(stationRoutes).toContain("operator.permissions.has(required.capability)");
  });

  it("SOP4d: MOVING the capture area is maintenance, and a Scanner Operator cannot do it", () => {
    /*
     * Recalibration used to sit behind `partner.cards.scan`, so the least-privileged role in the
     * system could silently repoint a station's physical acquisition rectangle. Every card captured
     * afterwards would be framed differently from every card before, and a certificate straddling
     * the change would have two sides from two rectangles.
     */
    expect(stationRoutes).toMatch(
      /async function requireSignedStationMaintainer[\s\S]{0,400}?capability: "partner\.stations\.calibrate"/
    );
    // And the calibration route actually uses it.
    expect(stationRoutes).toMatch(/stations\/calibrations"[\s\S]{0,300}?requireSignedStationMaintainer/);

    const calibrateMigration = readFileSync(
      join(process.cwd(), "migrations", "0092_partner_station_calibrate_permission.sql"),
      "utf8"
    );
    // Granted to the station-MANAGEMENT roles — the ones that could already enrol a whole new Mac.
    expect(calibrateMigration).toContain("'PARTNER_OWNER', 'PARTNER_MANAGER', 'MVGS_ASSESSMENT_TECHNICIAN'");
    // And the migration proves its own outcome rather than trusting the INSERT.
    expect(calibrateMigration).toContain("SCANNER_OPERATOR must not hold partner.stations.calibrate");
    expect(creditViewMigration).toContain("partner.credits.view");
    expect(calibrateMigration).toContain("RAISE EXCEPTION");
  });

  it("0034 is not edited — the new role and later credit-view grant arrive additively", () => {
    expect(seed0034).not.toContain("SCANNER_OPERATOR");
    expect(migration).toContain("ON CONFLICT (code) DO NOTHING");
    expect(migration).toContain("SCANNER_OPERATOR");
    expect(creditViewMigration).toContain("ON CONFLICT DO NOTHING");
  });

  it("the migration asserts its own outcome rather than trusting the INSERTs", () => {
    expect(migration).toContain("RAISE EXCEPTION");
    expect(migration).toContain("must hold exactly 3 permissions");
    expect(migration).toContain("holds a forbidden permission");
    expect(creditViewMigration).toContain("must hold partner.credits.view exactly once");
    expect(creditViewMigration).toContain("holds a forbidden non-view permission");
  });
});
