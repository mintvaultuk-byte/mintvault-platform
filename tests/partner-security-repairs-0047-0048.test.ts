/**
 * Migrations 0047 and 0048 — the two hostile-review security repairs, proved on a disposable
 * PostgreSQL 17 with the realistic NON-SUPERUSER / NOBYPASSRLS migrator role model.
 *
 * 0047 closes A8-F1 (HIGH): partner_owner_invariant_tenants is created by 0032:9 and granted
 * SELECT + INSERT to partner_runtime at 0032:117, but 0032 never enables RLS on it and never
 * creates a policy. A partner session could enumerate every tenant UUID on the network and pin any
 * other tenant into the owner invariant.
 *
 * 0048 closes A8-F2 (HIGH): 0044:131-157 creates partner_submissions_capture_location_snapshot()
 * with no `SET search_path` and an unqualified `FROM partner_locations`. Any role that can CREATE
 * TEMP TABLE — a default PUBLIC privilege — can shadow the table and forge
 * partner_submissions.location_name_snapshot.
 *
 * EVERY PROBE RUNS AS A REAL RESTRICTED ROLE, never as the superuser admin. A superuser has
 * BYPASSRLS, so running the isolation probe as one would pass whether or not 0047 exists — the
 * exact class of false green this repo has been bitten by before. The admin connection is used only
 * to build fixtures and to observe rows the restricted roles are not allowed to see.
 *
 * PRE-FIX CONTROLS AND MUTATIONS. It is not enough to show the repaired database is safe; a test
 * that cannot fail proves nothing. So each repair is also run in reverse:
 *
 *   - the pre-fix CONTROL restores the exact vulnerable state (rollback-0047 / rollback-0048) and
 *     asserts the attack SUCCEEDS. If the control ever stops reproducing, the repair test has
 *     stopped testing the thing it claims to test.
 *   - the MUTATIONS (OWNER-RLS1, SEARCHPATH1) surgically break one property of the repair and
 *     assert the corresponding proof turns RED.
 *
 * Runs ONLY when PARTNER_SECURITY_REPAIRS_ADMIN is a superuser URL to a DISPOSABLE loopback
 * PostgreSQL that is the ONLY partner database in its cluster.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  migratorUrlFrom,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
} from "./helpers/partner-realistic-db";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";

const ADMIN = process.env.PARTNER_SECURITY_REPAIRS_ADMIN;

function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN);

const RLS_MIGRATION = "0047_partner_owner_invariant_tenants_rls.sql";
const RLS_ROLLBACK = "rollback-0047-partner-owner-invariant-tenants-rls.sql";
const SP_MIGRATION = "0048_partner_location_snapshot_search_path.sql";
const SP_ROLLBACK = "rollback-0048-partner-location-snapshot-search-path.sql";
const sqlFile = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

/** Two tenants, so isolation is provable rather than assumed. */
const A = "aaaa1111-0000-0000-0000-000000000047";
const B = "bbbb2222-0000-0000-0000-000000000047";

/** A LOGIN role that is genuinely restricted: the shape partner_runtime has in production. */
const PROBE_ROLE = "pn_probe_runtime";
const PROBE_PASSWORD = "realistic-probe-pw"; // synthetic, disposable-DB only

let admin: Client;

async function migratorClient(): Promise<Client> {
  const c = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await c.connect();
  return c;
}

/** A connection as the restricted probe role, with an optional tenant GUC already set. */
async function probeClient(tenant?: string | null): Promise<Client> {
  const url = new URL(ADMIN!);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  if (tenant !== undefined && tenant !== null) {
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
  }
  return c;
}

async function applyAllRealistic(): Promise<void> {
  const migrator = await migratorClient();
  try {
    // ORDER IS LOAD-BEARING: 0041 revokes its own SET/INHERIT membership as its final act, so the
    // INHERIT repair grant must land BETWEEN 0041 and 0042.
    const all = listMigrationFiles();
    await applyMigrations(
      migrator,
      all.filter((f) => Number(f.number) <= 41),
      { allowDestructive: true }
    );
    await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
    await applyMigrations(migrator, all, { allowDestructive: true });
  } finally {
    await migrator.end();
  }
}

/** Re-apply exactly one migration file through the REAL runner, as the migrator. */
async function applyOnly(filename: string): Promise<void> {
  const migrator = await migratorClient();
  try {
    const only = listMigrationFiles().filter((f) => f.filename === filename);
    expect(only, `${filename} must be discoverable by the real migration runner`).toHaveLength(1);
    // The journal already holds this row from applyAllRealistic; drop it so the runner re-applies.
    await migrator.query("DELETE FROM schema_migrations WHERE filename = $1", [filename]);
    await applyMigrations(migrator, only, { allowDestructive: true });
  } finally {
    await migrator.end();
  }
}

/** Run a rollback file as the MIGRATOR, having first cleared the journal rows above it. */
async function runRollbackAsMigrator(filename: string, clearAbove: number): Promise<void> {
  const migrator = await migratorClient();
  try {
    await migrator.query(
      "DELETE FROM schema_migrations WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > $1",
      [clearAbove]
    );
    await migrator.query(sqlFile(filename));
  } finally {
    await migrator.end();
  }
}

/** Restore the journal after a rollback/reapply cycle so later tests see a coherent database. */
async function restoreJournalAndSchema(): Promise<void> {
  await applyOnly(RLS_MIGRATION);
  await applyOnly(SP_MIGRATION);
  const migrator = await migratorClient();
  try {
    const all = listMigrationFiles();
    await applyMigrations(migrator, all, { allowDestructive: true });
  } finally {
    await migrator.end();
  }
}

/**
 * Seed a tenant with an organisation, a real ACTIVE PARTNER_OWNER, and a location.
 *
 * The owner-invariant row is NOT inserted by hand. It is produced by 0032's own trigger when the
 * PARTNER_OWNER role is assigned — which is the only way to get a row that is genuinely
 * representative. Hand-inserting it first also trips the invariant on the very next user write
 * (the tenant would be marked as having had an owner while having none), which is how this fixture
 * was originally wrong.
 *
 * Returns the location id; the owner's user id is recorded in `ownerOf`.
 */
const ownerOf = new Map<string, string>();

async function seedTenant(tenant: string, ref: string, locationName: string): Promise<string> {
  await admin.query(
    `INSERT INTO partner_organisations (id, public_ref, legal_name, status)
     VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT DO NOTHING`,
    [tenant, ref, `${ref} Ltd`]
  );

  const { rows: owner } = await admin.query<{ id: string }>(
    `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, status)
     VALUES ($1,$1,$2,'Owner','ACTIVE')
     ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = EXCLUDED.first_name
     RETURNING id`,
    [tenant, `owner-${ref}@example.test`]
  );
  ownerOf.set(tenant, owner[0].id);
  await admin.query(
    `INSERT INTO partner_user_roles (tenant_id, user_id, role_id)
     SELECT $1, $2, r.id FROM partner_roles r WHERE r.code = 'PARTNER_OWNER'
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [tenant, owner[0].id]
  );

  const seen = await admin.query("SELECT 1 FROM partner_owner_invariant_tenants WHERE tenant_id = $1", [tenant]);
  expect(
    seen.rows,
    "0032's invariant trigger must have registered this tenant — the fixture depends on it"
  ).toHaveLength(1);

  const existing = await admin.query<{ id: string }>(
    "SELECT id FROM partner_locations WHERE tenant_id = $1 AND public_ref = $2",
    [tenant, `loc-${ref}`]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO partner_locations (tenant_id, partner_id, public_ref, name, status)
     VALUES ($1,$1,$2,$3,'ACTIVE') RETURNING id`,
    [tenant, `loc-${ref}`, locationName]
  );
  return rows[0].id;
}

let locationA = "";
let locationB = "";
let userA = "";

/**
 * The pg_temp attack, run as the restricted probe role.
 *
 * Returns the location_name_snapshot the trigger produced, or the error message if the insert was
 * refused. The attacker shadows public.partner_locations with a temp table carrying the VICTIM's
 * location id under the ATTACKER's tenant id, so the trigger's `AND l.tenant_id = NEW.tenant_id`
 * guard is satisfied against the forged row.
 */
async function pgTempAttack(): Promise<{ snapshot: string | null; error: string | null }> {
  const probe = await probeClient(A);
  try {
    await probe.query(`CREATE TEMP TABLE partner_locations (
      id uuid, tenant_id uuid, name text, partner_id uuid, public_ref text, status text)`);
    await probe.query(
      `INSERT INTO pg_temp.partner_locations (id, tenant_id, name)
       VALUES ($1, $2, 'FORGED ORIGIN — Tenant B Shop')`,
      [locationA, A]
    );
    // pg_temp ahead of public is the DEFAULT resolution order; set it explicitly so the probe does
    // not silently depend on the server's search_path default.
    await probe.query("SET search_path = pg_temp, public");
    const { rows } = await probe.query<{ location_name_snapshot: string | null }>(
      `INSERT INTO public.partner_submissions (tenant_id, location_id, created_by, status)
       VALUES ($1, $2, $3, 'draft') RETURNING location_name_snapshot`,
      [A, locationA, userA]
    );
    return { snapshot: rows[0]?.location_name_snapshot ?? null, error: null };
  } catch (e) {
    return { snapshot: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await probe.end();
  }
}

describe.skipIf(!isLocal)("partner security repairs 0047 + 0048 (disposable PostgreSQL 17)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN! });
    await admin.connect();

    const { rows: su } = await admin.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
    );
    expect(su[0]?.rolsuper, "PARTNER_SECURITY_REPAIRS_ADMIN must be a superuser URL").toBe(true);

    await provisionRealisticRoles(admin);
    // MintVault base tables the migration chain grants against / alters. Owned by pn_migrator,
    // because the migrations run as that non-superuser role and would otherwise hit
    // "must be owner of table".
    await admin.query(
      "CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
      admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await createMintvaultCertificatesTable(admin);
    await createMintvaultLabelPrintsTable(admin);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS cert_counter (id integer PRIMARY KEY DEFAULT 1, value integer NOT NULL DEFAULT 0)"
    );
    for (const t of [
      "users",
      "submissions",
      "submission_items",
      "audit_log",
      "certificates",
      "label_prints",
      "cert_counter",
    ]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }

    await applyAllRealistic();

    // A restricted LOGIN role with exactly partner_runtime's privileges. partner_runtime itself is
    // NOLOGIN, so this is the only way to probe as it without weakening it.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
        CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END$$;`);
    await admin.query(`GRANT partner_runtime TO ${PROBE_ROLE}`);

    const { rows: attrs } = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [PROBE_ROLE]
    );
    expect(attrs[0].rolsuper, "the probe role must not be a superuser").toBe(false);
    expect(attrs[0].rolbypassrls, "the probe role must not hold BYPASSRLS").toBe(false);

    locationA = await seedTenant(A, "rA47", "Tenant A Shop");
    locationB = await seedTenant(B, "rB47", "Tenant B Shop");
    const { rows: u } = await admin.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, status)
       VALUES ($1,$1,$2,'Probe','ACTIVE') RETURNING id`,
      [A, `probe-47@example.test`]
    );
    userA = u[0].id;
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
  });

  // ---------------------------------------------------------------------------------------------
  // 0047 — RLS on partner_owner_invariant_tenants
  // ---------------------------------------------------------------------------------------------

  it("R1: both repair migrations are journalled by the real runner, and 0045 does not exist", async () => {
    const { rows } = await admin.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename IN ($1,$2) ORDER BY filename",
      [RLS_MIGRATION, SP_MIGRATION]
    );
    expect(rows.map((r) => r.filename)).toEqual([RLS_MIGRATION, SP_MIGRATION]);

    // 0045 is burnt (see docs/migration-ownership-partner-0049.md). Nothing may claim it.
    const claimed = listMigrationFiles().filter((f) => Number(f.number) === 45);
    expect(claimed, "0045 must stay unused — 0046 is already applied on staging").toHaveLength(0);
  });

  it("R2: the migration runner orders the repairs BEFORE the grading bridge", () => {
    const order = listMigrationFiles()
      .map((f) => f.filename)
      .filter((n) => /^004[5-9]_/.test(n));
    expect(order).toEqual([
      "0047_partner_owner_invariant_tenants_rls.sql",
      "0048_partner_location_snapshot_search_path.sql",
      "0049_partner_grading_work_items.sql",
    ]);
  });

  it("R3: RLS is enabled AND forced on partner_owner_invariant_tenants with exactly one policy", async () => {
    const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'partner_owner_invariant_tenants'`
    );
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);

    const { rows: pol } = await admin.query<{ policyname: string; qual: string; with_check: string }>(
      `SELECT policyname, qual, with_check FROM pg_policies
        WHERE schemaname='public' AND tablename='partner_owner_invariant_tenants'`
    );
    expect(pol).toHaveLength(1);
    expect(pol[0].policyname).toBe("partner_owner_invariant_tenants_tenant_isolation");
    expect(pol[0].qual).toMatch(/partner_current_tenant\(\)/);
    expect(pol[0].with_check).toMatch(/partner_current_tenant\(\)/);
  });

  it("R4: ISOLATION PROBE — a real restricted role with tenant A's GUC sees ONLY tenant A", async () => {
    const probe = await probeClient(A);
    try {
      const { rows } = await probe.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM partner_owner_invariant_tenants ORDER BY tenant_id"
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([A]);

      // The control surface: partner_organisations was ALWAYS isolated. Both must now agree.
      const { rows: orgs } = await probe.query<{ id: string }>("SELECT id FROM partner_organisations ORDER BY id");
      expect(orgs.map((r) => r.id)).toEqual([A]);
    } finally {
      await probe.end();
    }

    // The admin (BYPASSRLS) still sees both — proving the rows exist and R4 measured filtering,
    // not an empty table.
    const { rows: all } = await admin.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM partner_owner_invariant_tenants WHERE tenant_id IN ($1,$2)",
      [A, B]
    );
    expect(all).toHaveLength(2);
  });

  it("R5: ISOLATION PROBE — no tenant GUC and a malformed GUC both return ZERO rows (fail closed)", async () => {
    const noGuc = await probeClient();
    try {
      const { rows } = await noGuc.query("SELECT tenant_id FROM partner_owner_invariant_tenants");
      expect(rows).toHaveLength(0);
    } finally {
      await noGuc.end();
    }

    const bad = await probeClient();
    try {
      await bad.query("SELECT set_config('app.tenant_id', 'not-a-uuid', false)");
      const { rows } = await bad.query("SELECT tenant_id FROM partner_owner_invariant_tenants");
      expect(rows).toHaveLength(0);
    } catch (e) {
      // A malformed GUC raising instead of returning zero rows is also fail-closed.
      expect(String(e)).toMatch(/invalid input syntax|uuid/i);
    } finally {
      await bad.end();
    }
  });

  it("R6: the cross-tenant PIN insert is now refused by WITH CHECK", async () => {
    const probe = await probeClient(A);
    let err: string | null = null;
    try {
      await probe.query("INSERT INTO partner_owner_invariant_tenants (tenant_id) VALUES ($1)", [B]);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      await probe.end();
    }
    expect(err, "tenant A must not be able to pin tenant B into the owner invariant").toMatch(
      /row-level security policy/i
    );
  });

  it("R7: PRE-FIX CONTROL — rollback-0047 reproduces the hole, and re-applying closes it again", async () => {
    await runRollbackAsMigrator(RLS_ROLLBACK, 47);

    const probe = await probeClient(A);
    let leaked: string[];
    try {
      const { rows } = await probe.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM partner_owner_invariant_tenants WHERE tenant_id IN ($1,$2) ORDER BY tenant_id",
        [A, B]
      );
      leaked = rows.map((r) => r.tenant_id);
    } finally {
      await probe.end();
    }
    // THIS IS THE VULNERABILITY, reproduced: tenant A sees tenant B.
    expect(leaked, "the pre-fix control must reproduce the A8-F1 leak").toEqual([A, B]);

    await restoreJournalAndSchema();

    const after = await probeClient(A);
    try {
      const { rows } = await after.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM partner_owner_invariant_tenants WHERE tenant_id IN ($1,$2)",
        [A, B]
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([A]);
    } finally {
      await after.end();
    }
  }, 180_000);

  it("R8: MUTATION OWNER-RLS1 — dropping the policy turns the isolation probe RED", async () => {
    await admin.query(
      "DROP POLICY partner_owner_invariant_tenants_tenant_isolation ON partner_owner_invariant_tenants"
    );
    try {
      const probe = await probeClient(A);
      try {
        // With RLS enabled but NO policy, a non-owner sees zero rows — so the mutation is detected
        // by the policy-shape assertion, not by the row count. Prove BOTH halves go red.
        const { rows: pol } = await admin.query(
          `SELECT policyname FROM pg_policies
            WHERE schemaname='public' AND tablename='partner_owner_invariant_tenants'`
        );
        expect(pol).toHaveLength(0); // R3 would now FAIL: it demands exactly one policy.

        const { rows } = await probe.query(
          "SELECT tenant_id FROM partner_owner_invariant_tenants WHERE tenant_id IN ($1,$2)",
          [A, B]
        );
        expect(rows).toHaveLength(0); // R4 would now FAIL: it demands exactly [A].
      } finally {
        await probe.end();
      }
    } finally {
      await applyOnly(RLS_MIGRATION); // restore
    }

    const { rows: restored } = await admin.query(
      `SELECT policyname FROM pg_policies
        WHERE schemaname='public' AND tablename='partner_owner_invariant_tenants'`
    );
    expect(restored).toHaveLength(1);
  }, 120_000);

  it("R9: MUTATION OWNER-RLS1b — DISABLE ROW LEVEL SECURITY restores the full leak", async () => {
    await admin.query("ALTER TABLE partner_owner_invariant_tenants DISABLE ROW LEVEL SECURITY");
    try {
      const probe = await probeClient(A);
      try {
        const { rows } = await probe.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM partner_owner_invariant_tenants WHERE tenant_id IN ($1,$2) ORDER BY tenant_id",
          [A, B]
        );
        // R4 goes RED in the most damaging direction: the leak is back.
        expect(rows.map((r) => r.tenant_id)).toEqual([A, B]);
      } finally {
        await probe.end();
      }
    } finally {
      await admin.query("ALTER TABLE partner_owner_invariant_tenants ENABLE ROW LEVEL SECURITY");
    }
  });

  // ---------------------------------------------------------------------------------------------
  // 0048 — search_path pin on the location snapshot trigger
  // ---------------------------------------------------------------------------------------------

  it("S1: the trigger function pins search_path with pg_temp LAST and reads public.partner_locations", async () => {
    const { rows } = await admin.query<{ proconfig: string[] | null; prosrc: string }>(
      `SELECT p.proconfig, p.prosrc FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='partner_submissions_capture_location_snapshot'`
    );
    expect(rows[0].proconfig).toContain("search_path=public, pg_temp");
    expect(rows[0].prosrc).toMatch(/FROM public\.partner_locations/);
    expect(rows[0].prosrc).not.toMatch(/FROM\s+partner_locations/);

    // pg_temp must be LAST. pg_temp first would re-open the attack even with a pin present.
    const cfg = rows[0].proconfig!.find((c) => c.startsWith("search_path="))!;
    const parts = cfg
      .slice("search_path=".length)
      .split(",")
      .map((s) => s.trim());
    expect(parts[parts.length - 1]).toBe("pg_temp");
  });

  it("S2: the trigger survived CREATE OR REPLACE and is still attached to partner_submissions", async () => {
    const { rows } = await admin.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid = 'public.partner_submissions'::regclass
          AND tgname = 'trg_partner_submissions_location_snapshot'`
    );
    expect(rows).toHaveLength(1);
  });

  it("S3: pg_temp ATTACK — a shadowing temp table can no longer forge the location snapshot", async () => {
    const result = await pgTempAttack();
    expect(result.error, `attack should not error, it should be neutralised: ${result.error}`).toBeNull();
    expect(result.snapshot).toBe("Tenant A Shop");
    expect(result.snapshot).not.toMatch(/FORGED/);
  });

  it("S4: PRE-FIX CONTROL — rollback-0048 restores 0044's body and the forgery SUCCEEDS again", async () => {
    await runRollbackAsMigrator(SP_ROLLBACK, 48);

    const { rows: cfg } = await admin.query<{ proconfig: string[] | null }>(
      `SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='partner_submissions_capture_location_snapshot'`
    );
    expect(cfg[0].proconfig, "the rollback must actually clear the pin").toBeNull();

    const result = await pgTempAttack();
    // THIS IS THE VULNERABILITY, reproduced.
    expect(result.error).toBeNull();
    expect(result.snapshot).toBe("FORGED ORIGIN — Tenant B Shop");

    await restoreJournalAndSchema();

    const after = await pgTempAttack();
    expect(after.snapshot).toBe("Tenant A Shop");
  }, 180_000);

  it("S5: MUTATION SEARCHPATH1 — removing only the search_path pin turns S1 and S3 RED", async () => {
    await admin.query("ALTER FUNCTION partner_submissions_capture_location_snapshot() RESET ALL");
    try {
      const { rows } = await admin.query<{ proconfig: string[] | null }>(
        `SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='partner_submissions_capture_location_snapshot'`
      );
      expect(rows[0].proconfig).toBeNull(); // S1 would now FAIL.

      // The schema qualification alone still holds the line — that is the belt-and-braces claim
      // 0048's header makes, and this is where it is proved rather than asserted.
      const stillSafe = await pgTempAttack();
      expect(stillSafe.snapshot).toBe("Tenant A Shop");
    } finally {
      await applyOnly(SP_MIGRATION);
    }
  }, 120_000);

  it("S6: MUTATION SEARCHPATH1b — un-qualifying the read with NO pin restores the forgery", async () => {
    // Both halves of 0048 removed: this is the state 0044 shipped. The attack must work again,
    // which is what makes S3 a real test rather than a tautology.
    await admin.query(`CREATE OR REPLACE FUNCTION partner_submissions_capture_location_snapshot()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE location_name text;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.location_name_snapshot IS NULL THEN
            SELECT l.name INTO location_name FROM partner_locations l
             WHERE l.id = NEW.location_id AND l.tenant_id = NEW.tenant_id;
            IF location_name IS NULL THEN
              RAISE EXCEPTION 'partner_submissions.location_name_snapshot could not resolve location % for tenant %',
                NEW.location_id, NEW.tenant_id;
            END IF;
            NEW.location_name_snapshot := location_name;
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.location_name_snapshot IS DISTINCT FROM NEW.location_name_snapshot THEN
          RAISE EXCEPTION 'partner_submissions.location_name_snapshot is immutable after insert';
        END IF;
        RETURN NEW;
      END$$;`);
    await admin.query("ALTER FUNCTION partner_submissions_capture_location_snapshot() RESET ALL");
    try {
      const forged = await pgTempAttack();
      expect(forged.snapshot).toBe("FORGED ORIGIN — Tenant B Shop"); // S3 would now FAIL.
    } finally {
      await applyOnly(SP_MIGRATION);
    }

    const restored = await pgTempAttack();
    expect(restored.snapshot).toBe("Tenant A Shop");
  }, 120_000);

  it("S7: the legitimate path still works — a submission for tenant B snapshots tenant B's name", async () => {
    const { rows: u } = await admin.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, status)
       VALUES ($1,$1,$2,'ProbeB','ACTIVE')
       ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = EXCLUDED.first_name RETURNING id`,
      [B, "probe-47b@example.test"]
    );
    const { rows } = await admin.query<{ location_name_snapshot: string }>(
      `INSERT INTO partner_submissions (tenant_id, location_id, created_by, status)
       VALUES ($1,$2,$3,'draft') RETURNING location_name_snapshot`,
      [B, locationB, u[0].id]
    );
    expect(rows[0].location_name_snapshot).toBe("Tenant B Shop");
  });
});
