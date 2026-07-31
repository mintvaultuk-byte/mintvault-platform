/**
 * Migration 0034 (Partner RBAC seed) + read-only validator — runtime proofs on real PostgreSQL 17.
 *
 * These run the REAL migration runner (scripts/db/migrate.ts), not a hand-rolled emulation, so the
 * journal, the advisory lock, the checksum pin and the per-file transaction wrapping are all
 * genuinely exercised. The original blocker survived because thirteen suites seeded RBAC by hand in
 * beforeAll and no test ever built an environment the way a deployment does; this file deliberately
 * never calls seedPartnerRbac().
 *
 * Gated on a disposable loopback PostgreSQL 17 in PARTNER_RBAC_MIG_ADMIN. Skipped runs are NOT
 * passes and are reported as skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "pg";
import { join } from "node:path";
import { listMigrationFiles, applyMigrations, planMigrations } from "../scripts/db/migrate";
import {
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
  applyMigrationsRealistic,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { PARTNER_ROLE_CODES } from "../shared/partner-schema";
import { PARTNER_PERMISSIONS, ROLE_PERMISSIONS, ROLE_LABELS } from "../server/partner/permissions";

const ADMIN_DB = process.env.PARTNER_RBAC_MIG_ADMIN;

function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN_DB);

const captured = vi.hoisted(() => ({ invitations: [] as Array<Record<string, unknown>> }));
vi.mock("../server/partner/delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/partner/delivery")>();
  return {
    ...actual,
    invitationDeliveryConfigured: () => true,
    deliverInvitationToken: vi.fn(async (d: Record<string, unknown>) => {
      captured.invitations.push(d);
    }),
  };
});

const EXPECTED_ROLES = PARTNER_ROLE_CODES.length;
const EXPECTED_PERMISSIONS = PARTNER_PERMISSIONS.length;
const EXPECTED_MAPPINGS = PARTNER_ROLE_CODES.reduce((n, c) => n + ROLE_PERMISSIONS[c].length, 0);

describe("Partner RBAC migration coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_RBAC_MIG_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(true);
    }
    if (!isLocal) console.warn("[partner-rbac-migration] skipped: PARTNER_RBAC_MIG_ADMIN not a loopback URL");
    expect(true).toBe(true);
  });
});

describe.skipIf(!isLocal)("migration 0034 — Partner RBAC seed (real runner, PostgreSQL 17)", () => {
  let admin: Client;

  const counts = async () => {
    const { rows } = await admin.query<{ roles: string; perms: string; maps: string }>(
      `SELECT (SELECT count(*) FROM partner_roles)::text AS roles,
              (SELECT count(*) FROM partner_permissions)::text AS perms,
              (SELECT count(*) FROM partner_role_permissions)::text AS maps`
    );
    return { roles: +rows[0].roles, perms: +rows[0].perms, maps: +rows[0].maps };
  };

  /**
   * Apply everything EXCEPT 0034, so each test starts from a real pre-seed estate — i.e. exactly the
   * state every deployed environment was in when the blocker was found. The stub tables are the ones
   * the partner migration set references from the main schema; they are created here rather than
   * pulled in wholesale so this suite stays scoped to RBAC.
   */
  const applyThroughAuditPrecision = async () => {
    await provisionRealisticRoles(admin);
    await admin.query(`CREATE TABLE IF NOT EXISTS users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar,
      last_name varchar, role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamp NOT NULL DEFAULT now())`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer)");
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");

    const upTo = PARTNER_MIGRATIONS_WITH_RBAC_SEED.filter((m) => m !== "0034_partner_rbac_seed");
    await applyMigrationsRealistic(admin, ADMIN_DB!, upTo);
  };

  /** Apply ONLY 0034, through the real runner, with a real journal. */
  const runRealRunnerFor0034 = async () => {
    const files = listMigrationFiles(join(process.cwd(), "migrations")).filter(
      (f) => f.filename === "0034_partner_rbac_seed.sql"
    );
    expect(files.length, "0034 must be visible to the real migration runner").toBe(1);
    return applyMigrations(admin as never, files);
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end().catch(() => {});
  });

  beforeEach(async () => {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
    await applyThroughAuditPrecision();
  });

  // ---- 1-5: the catalogue becomes exactly complete -------------------------------------
  it("1-4. empty RBAC tables become complete with the exact expected counts", async () => {
    const before = await counts();
    expect(before, "precondition: the blocker state — 0001 creates these tables but never fills them").toEqual({
      roles: 0,
      perms: 0,
      maps: 0,
    });

    await runRealRunnerFor0034();

    expect(await counts()).toEqual({
      roles: EXPECTED_ROLES,
      perms: EXPECTED_PERMISSIONS,
      maps: EXPECTED_MAPPINGS,
    });
  });

  it("5. PARTNER_OWNER holds the correct COMPLETE permission set", async () => {
    await runRealRunnerFor0034();
    const { rows } = await admin.query<{ code: string }>(
      `SELECT p.code FROM partner_role_permissions rp
         JOIN partner_roles r ON r.id = rp.role_id
         JOIN partner_permissions p ON p.id = rp.permission_id
        WHERE r.code = 'PARTNER_OWNER' ORDER BY p.code`
    );
    expect(rows.map((r) => r.code)).toEqual([...ROLE_PERMISSIONS.PARTNER_OWNER].sort());
  });

  it("5b. every role's grants match the canonical TypeScript map exactly", async () => {
    await runRealRunnerFor0034();
    for (const code of PARTNER_ROLE_CODES) {
      const { rows } = await admin.query<{ code: string }>(
        `SELECT p.code FROM partner_role_permissions rp
           JOIN partner_roles r ON r.id = rp.role_id
           JOIN partner_permissions p ON p.id = rp.permission_id
          WHERE r.code = $1 ORDER BY p.code`,
        [code]
      );
      expect(
        rows.map((r) => r.code),
        `grants for ${code}`
      ).toEqual([...ROLE_PERMISSIONS[code]].sort());
    }
  });

  // ---- 6-7: pre-existing and partial catalogues ----------------------------------------
  it("6. existing CORRECT rows are left exactly as they are", async () => {
    await admin.query("INSERT INTO partner_roles (code,label) VALUES ('PARTNER_OWNER',$1)", [
      ROLE_LABELS.PARTNER_OWNER,
    ]);
    const { rows: before } = await admin.query<{ id: string; created_at: string }>(
      "SELECT id, created_at::text FROM partner_roles WHERE code='PARTNER_OWNER'"
    );

    await runRealRunnerFor0034();

    const { rows: after } = await admin.query<{ id: string; created_at: string }>(
      "SELECT id, created_at::text FROM partner_roles WHERE code='PARTNER_OWNER'"
    );
    expect(after[0].id, "an existing correct role row must not be replaced").toBe(before[0].id);
    expect(after[0].created_at).toBe(before[0].created_at);
    expect(await counts()).toEqual({ roles: EXPECTED_ROLES, perms: EXPECTED_PERMISSIONS, maps: EXPECTED_MAPPINGS });
  });

  it("7. a PARTIALLY populated catalogue converges safely to complete", async () => {
    // The exact state a crashed autocommit startup seed used to leave behind: roles and permissions
    // present, mappings incomplete — PARTNER_OWNER resolves, so invitations work, while permission
    // checks silently under-grant.
    for (const code of PARTNER_ROLE_CODES) {
      await admin.query("INSERT INTO partner_roles (code,label) VALUES ($1,$2)", [code, ROLE_LABELS[code]]);
    }
    for (const perm of PARTNER_PERMISSIONS) {
      await admin.query("INSERT INTO partner_permissions (code,label) VALUES ($1,$1)", [perm]);
    }
    await admin.query(
      `INSERT INTO partner_role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM partner_roles r, partner_permissions p
          WHERE r.code='PARTNER_OWNER' AND p.code='partner.dashboard.view'`
    );
    const partial = await counts();
    expect(partial.maps).toBe(1);

    await runRealRunnerFor0034();

    expect(await counts()).toEqual({ roles: EXPECTED_ROLES, perms: EXPECTED_PERMISSIONS, maps: EXPECTED_MAPPINGS });
  });

  // ---- 8: conflicting definitions fail LOUDLY -------------------------------------------
  it("8a. a role whose label CONFLICTS fails loudly rather than silently changing meaning", async () => {
    await admin.query("INSERT INTO partner_roles (code,label) VALUES ('PARTNER_OWNER','Shop Boss')");
    await expect(runRealRunnerFor0034()).rejects.toThrow(/refuses to run|define a canonical role differently/i);

    // and the transaction rolled back: nothing partially seeded
    const after = await counts();
    expect(after.roles, "only the pre-existing conflicting row may remain").toBe(1);
    expect(after.perms).toBe(0);
    expect(after.maps).toBe(0);
  });

  it("8b. a permission whose label CONFLICTS fails loudly", async () => {
    await admin.query("INSERT INTO partner_permissions (code,label) VALUES ('partner.cards.scan','Scan cards')");
    await expect(runRealRunnerFor0034()).rejects.toThrow(/refuses to run|define a canonical permission/i);
    expect((await counts()).roles).toBe(0);
  });

  it("8c. an UNKNOWN extra catalogue row is reported but NEVER deleted", async () => {
    await admin.query("INSERT INTO partner_roles (code,label) VALUES ('LEGACY_ROLE','Legacy')");
    await runRealRunnerFor0034();
    const { rows } = await admin.query("SELECT 1 FROM partner_roles WHERE code='LEGACY_ROLE'");
    expect(rows.length, "revocation is a deliberate act — seeding must never remove a grant").toBe(1);
    expect((await counts()).roles).toBe(EXPECTED_ROLES + 1);
  });

  // ---- 9-11: runner semantics ------------------------------------------------------------
  it("9. re-running through the repository migration system is safe (no-op)", async () => {
    const first = await runRealRunnerFor0034();
    expect(first.applied).toEqual(["0034_partner_rbac_seed.sql"]);
    const afterFirst = await counts();

    const second = await runRealRunnerFor0034();
    expect(second.applied, "already-applied migration must not run twice").toEqual([]);
    expect(await counts()).toEqual(afterFirst);
  });

  it("10. the journal records EXACTLY ONE applied 0034 row", async () => {
    await runRealRunnerFor0034();
    await runRealRunnerFor0034();
    const { rows } = await admin.query<{ n: string; status: string }>(
      "SELECT count(*)::text AS n, min(status) AS status FROM schema_migrations WHERE filename='0034_partner_rbac_seed.sql'"
    );
    expect(+rows[0].n).toBe(1);
    expect(rows[0].status).toBe("applied");
  });

  it("11. the real runner produces NO nested-transaction warnings", async () => {
    /*
     * 0034 deliberately carries no BEGIN/COMMIT: the runner wraps each file in one transaction
     * together with its journal row. A nested COMMIT would commit the runner's transaction early and
     * split the seed from its journal entry — the defect found in 0033 during review.
     */
    const notices: string[] = [];
    const onNotice = (n: { message?: string }) => notices.push(String(n?.message ?? ""));
    admin.on("notice", onNotice);
    try {
      await runRealRunnerFor0034();
    } finally {
      admin.off("notice", onNotice);
    }
    const nested = notices.filter((m) => /no transaction in progress|there is already a transaction/i.test(m));
    expect(nested, `unexpected transaction warnings: ${nested.join("; ")}`).toEqual([]);

    // and the file itself must not open its own transaction
    const files = listMigrationFiles(join(process.cwd(), "migrations")).filter(
      (f) => f.filename === "0034_partner_rbac_seed.sql"
    );
    expect(/^\s*BEGIN\s*;/im.test(files[0].sql), "0034 must not open its own transaction").toBe(false);
    expect(/^\s*COMMIT\s*;/im.test(files[0].sql), "0034 must not commit its own transaction").toBe(false);
  });

  it("11b. the runner's own plan sees 0034 as pending, then applied", async () => {
    const files = listMigrationFiles(join(process.cwd(), "migrations")).filter(
      (f) => f.filename === "0034_partner_rbac_seed.sql"
    );
    const before = await planMigrations(admin as never, files);
    expect(before.pending).toContain("0034_partner_rbac_seed.sql");
    await runRealRunnerFor0034();
    const after = await planMigrations(admin as never, files);
    expect(after.pending).not.toContain("0034_partner_rbac_seed.sql");
    expect(after.alreadyApplied).toContain("0034_partner_rbac_seed.sql");
    expect(after.checksumMismatches).toEqual([]);
  });

  // ---- 12-15: the read-only validator ----------------------------------------------------
  it("12-13. validator reports 503-worthy state BEFORE the migration and ready AFTER", async () => {
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    const perms = await import("../server/partner/permissions");
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();

    const before = await perms.validatePartnerRbac();
    expect(before.state, "13. before the migration the catalogue is incomplete").toBe("incomplete");
    expect(before.failureCode).toBe("PARTNER_RBAC_NOT_SEEDED");
    expect(before.remedy).toMatch(/0034/);
    expect(perms.partnerRbacBlocksReadiness(before.state, true)).toBe(true);

    await runRealRunnerFor0034();

    const after = await perms.validatePartnerRbac();
    expect(after.state, "12. after the migration the catalogue is ready").toBe("ready");
    expect(after.failureCode).toBeNull();
    expect(after.missing).toEqual({ roles: 0, permissions: 0, mappings: 0 });
    expect(perms.partnerRbacBlocksReadiness(after.state, true)).toBe(false);
    await closePartnerPools();
  });

  it("14. validator detects ONE deliberately removed mapping", async () => {
    await runRealRunnerFor0034();
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    const perms = await import("../server/partner/permissions");
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();

    expect((await perms.validatePartnerRbac()).state).toBe("ready");

    await admin.query(
      `DELETE FROM partner_role_permissions rp
        USING partner_roles r, partner_permissions p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND r.code = 'PARTNER_RECEPTION' AND p.code = 'partner.cards.receive'`
    );

    const degraded = await perms.validatePartnerRbac();
    expect(degraded.state).toBe("incomplete");
    expect(degraded.missing).toEqual({ roles: 0, permissions: 0, mappings: 1 });
    await closePartnerPools();
  });

  it("15. the validator performs NO writes under a SELECT-only role", async () => {
    await runRealRunnerFor0034();

    // The role outlives the per-test schema drop, and its grants are dependent objects, so the
    // privileges must be released before the role itself can go.
    await admin.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mv_rbac_reader') THEN
        EXECUTE 'DROP OWNED BY mv_rbac_reader';
        EXECUTE 'DROP ROLE mv_rbac_reader';
      END IF;
    END$$;`);
    await admin.query("CREATE ROLE mv_rbac_reader LOGIN PASSWORD 'reader-pw'");
    const dbName = new URL(ADMIN_DB!).pathname.replace(/^\//, "");
    await admin.query(`GRANT CONNECT ON DATABASE ${JSON.stringify(dbName).replace(/"/g, '"')} TO mv_rbac_reader`);
    await admin.query("GRANT USAGE ON SCHEMA public TO mv_rbac_reader");
    await admin.query("GRANT SELECT ON partner_roles, partner_permissions, partner_role_permissions TO mv_rbac_reader");

    const readerUrl = new URL(ADMIN_DB!);
    readerUrl.username = "mv_rbac_reader";
    readerUrl.password = "reader-pw";

    process.env.PARTNER_ADMIN_DATABASE_URL = readerUrl.toString();
    const perms = await import("../server/partner/permissions");
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();

    const status = await perms.validatePartnerRbac();
    expect(status.state, "a SELECT-only identity must still be able to VALIDATE").toBe("ready");

    // The decisive assertion: an identity with no INSERT privilege completed validation without
    // error, which is only possible because the validator never attempts a write.
    const reader = new Client({ connectionString: readerUrl.toString() });
    await reader.connect();
    await expect(reader.query("INSERT INTO partner_roles (code,label) VALUES ('X','X')")).rejects.toThrow(
      /permission denied/i
    );
    await reader.end();
    await closePartnerPools();
  });
});

/**
 * THE BLOCKER ITSELF, end to end, on an estate built exactly the way a deployment is built:
 * migrations only. seedPartnerRbac() is NEVER called in this describe — that habit is precisely what
 * hid the defect for so long, so its absence is the whole point.
 */
describe.skipIf(!isLocal)("first OWNER invitation after migration 0034 only (no seed helper)", () => {
  let admin: Client;
  let svc: typeof import("../server/partner/partner-management-service");

  const ACTOR = {
    actorUserId: "aaaa1111-2222-3333-4444-555566667777",
    actorEmail: "superadmin@example.test",
    requestId: "rbac-mig",
  } as const;
  const actor = (extra: Record<string, unknown> = {}) => ({ ...ACTOR, ...extra }) as never;

  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_DATABASE_URL = ADMIN_DB;
    process.env.SESSION_SECRET = "synthetic-rbac-migration-secret-not-committed";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await provisionRealisticRoles(admin);
    await admin.query(`CREATE TABLE IF NOT EXISTS users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar,
      last_name varchar, role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamp NOT NULL DEFAULT now())`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer)");
    for (const t of ["users", "submissions", "submission_items"])
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);

    // The FULL production migration set, INCLUDING 0034. Nothing else provisions RBAC.
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_RBAC_SEED);

    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    svc = await import("../server/partner/partner-management-service");
  }, 120_000);

  afterAll(async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    captured.invitations.length = 0;
    svc.__setInvitePartnerFailurePointForTest(null);
    await admin.query(`TRUNCATE partner_management_audit, partner_audit_events, partner_invitations,
      partner_user_roles, partner_users, partner_locations, partner_profiles, partner_organisations CASCADE`);
  });

  const newPartner = async (name: string) => {
    const r = await svc.createPartner(actor({ requestId: `c-${name}` }), { legalName: name }, "migration-only proof");
    return (r.result as { partnerId: string }).partnerId;
  };

  it("creates a Partner, its first OWNER and exactly one invitation — no PARTNER_ROLE_NOT_CONFIGURED", async () => {
    const partnerId = await newPartner("Pilot Partner One Ltd");

    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "first-owner" }),
        partnerId,
        { firstName: "Pilot", lastName: "Owner", email: "owner@pilot.test", role: "OWNER" },
        "first owner login for the pilot"
      )
    ).resolves.toBeTruthy();

    const users = await admin.query<{ id: string; email: string }>("SELECT id, email FROM partner_users");
    expect(users.rows).toHaveLength(1);

    const roles = await admin.query<{ code: string }>(
      `SELECT r.code FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id WHERE ur.user_id=$1`,
      [users.rows[0].id]
    );
    expect(
      roles.rows.map((r) => r.code),
      "the OWNER role must be resolved and assigned"
    ).toEqual(["PARTNER_OWNER"]);

    const invitations = await admin.query("SELECT id FROM partner_invitations WHERE user_id=$1", [users.rows[0].id]);
    expect(invitations.rows, "exactly one invitation").toHaveLength(1);
  });

  it("the invitation token is stored as a HASH — never in plaintext", async () => {
    const partnerId = await newPartner("Hash Ltd");
    await svc.invitePartnerUser(
      actor({ requestId: "hash" }),
      partnerId,
      { firstName: "H", lastName: "H", email: "hash@pilot.test", role: "OWNER" },
      "token hashing proof"
    );

    const delivered = captured.invitations[0] as { token?: string } | undefined;
    const plaintext = delivered?.token;
    expect(typeof plaintext, "a token must actually have been delivered").toBe("string");

    const { rows } = await admin.query<Record<string, string>>("SELECT * FROM partner_invitations LIMIT 1");
    const serialised = JSON.stringify(rows[0]);
    expect(serialised.includes(plaintext!), "the plaintext token must NEVER be stored").toBe(false);
  });

  it("only ONE live invitation per user — a duplicate is refused", async () => {
    const partnerId = await newPartner("Duplicate Ltd");
    const invite = () =>
      svc.invitePartnerUser(
        actor({ requestId: "dupe" }),
        partnerId,
        { firstName: "D", lastName: "D", email: "dupe@pilot.test", role: "OWNER" },
        "duplicate invitation proof"
      );

    await expect(invite()).resolves.toBeTruthy();
    await expect(invite(), "a second live invitation must be refused").rejects.toBeTruthy();

    const { rows } = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_users");
    expect(+rows[0].n, "the refused retry must not create a second user").toBe(1);
  });

  it("ATOMICITY — a failure before commit leaves NO orphan user, role or invitation", async () => {
    for (const point of [
      "after_user_insert",
      "after_role_assignment",
      "before_invitation_insert",
      "before_invitation_audit",
    ] as const) {
      await admin.query(`TRUNCATE partner_management_audit, partner_audit_events, partner_invitations,
        partner_user_roles, partner_users, partner_locations, partner_profiles, partner_organisations CASCADE`);
      const partnerId = await newPartner(`Atomic ${point} Ltd`);

      svc.__setInvitePartnerFailurePointForTest(point);
      await expect(
        svc.invitePartnerUser(
          actor({ requestId: `atomic-${point}` }),
          partnerId,
          { firstName: "A", lastName: "A", email: "atomic@pilot.test", role: "OWNER" },
          `atomicity proof at ${point}`
        ),
        `invitation must fail at ${point}`
      ).rejects.toBeTruthy();
      svc.__setInvitePartnerFailurePointForTest(null);

      const users = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_users");
      const roles = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_user_roles");
      const invites = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_invitations");
      expect(+users.rows[0].n, `orphan partner_users after failure at ${point}`).toBe(0);
      expect(+roles.rows[0].n, `orphan role assignment after failure at ${point}`).toBe(0);
      expect(+invites.rows[0].n, `partial invitation after failure at ${point}`).toBe(0);

      // and the failure must not block a legitimate retry
      await expect(
        svc.invitePartnerUser(
          actor({ requestId: `retry-${point}` }),
          partnerId,
          { firstName: "A", lastName: "A", email: "atomic@pilot.test", role: "OWNER" },
          `retry after rolled-back attempt at ${point}`
        ),
        `retry after ${point} must succeed`
      ).resolves.toBeTruthy();
    }
  });

  it("a misleading audit success is never written for a failed invitation", async () => {
    const partnerId = await newPartner("Audit Honesty Ltd");
    svc.__setInvitePartnerFailurePointForTest("before_invitation_audit");
    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "audit-honesty" }),
        partnerId,
        { firstName: "Q", lastName: "Q", email: "audit@pilot.test", role: "OWNER" },
        "audit honesty proof"
      )
    ).rejects.toBeTruthy();
    svc.__setInvitePartnerFailurePointForTest(null);

    const { rows } = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_management_audit WHERE action_type='partner_user_invited'"
    );
    expect(+rows[0].n, "a rolled-back invitation must leave no 'invited' audit row").toBe(0);
  });
});
