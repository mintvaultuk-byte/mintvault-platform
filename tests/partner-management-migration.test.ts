/**
 * Partner Network — Phase G5: migration 0015 (partner management) proof on a disposable Postgres with
 * the realistic non-superuser role model.
 *
 * Proves: 0015 applies + is journaled; reapply is a clean no-op; preflight classifies the 5 new tables
 * as Partner Network (ok); exact index inventory; grants (partner_runtime SELECT on the 3 data tables,
 * partner_connector_runtime SELECT+INSERT on the 2 evidence tables, no PUBLIC anywhere); FORCE RLS +
 * tenant policy on the 3 data tables; RLS cross-tenant SELECT isolation for partner_runtime; append-
 * only immutability (42501 on UPDATE/DELETE/TRUNCATE) on the 2 evidence tables; the contact-primary
 * and audit-idempotency partial-uniques; and rollback drop + de-journal + reapply.
 *
 * Runs ONLY when PARTNER_MANAGEMENT_MIGRATION_ADMIN is a superuser URL to a DISPOSABLE loopback
 * Postgres that is the ONLY partner database in its cluster.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom, createMintvaultCertificatesTable, createMintvaultLabelPrintsTable } from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { runPreflight } from "../scripts/db/preflight-schema";

const ADMIN = process.env.PARTNER_MANAGEMENT_MIGRATION_ADMIN;
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
const rb = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");
const A = "aaaa1111-0000-0000-0000-0000000000a5";
const B = "bbbb2222-0000-0000-0000-0000000000b5";

let admin: Client;

async function applyAllRealistic(): Promise<void> {
  await provisionRealisticRoles(admin);
  /**
   * G6D credit-lifecycle roles. This suite drives the REAL migrate runner over EVERY migration
   * file, which now includes 0041 and 0042, so it must reproduce the one-time elevated
   * provisioning applyMigrationsRealistic() performs. The ADMIN-only grant models Neon's
   * provider-granted membership row; the INHERIT grant below models the owner-approved staging
   * repair 0042 documents as its prerequisite. SET is never granted.
   */
  await admin.query(
    `DO $$ BEGIN
       CREATE ROLE partner_credit_lifecycle_definer
         NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
     EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
  );
  await admin.query(
    `DO $$ BEGIN
       CREATE ROLE pn_credit_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
  );
  await admin.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE");
  const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await migrator.connect();
  try {
    /**
     * ORDER IS LOAD-BEARING. 0041 revokes its own SET/INHERIT membership as its final act, so the
     * repair grant must land BETWEEN 0041 and 0042 — granting it up front is silently undone.
     *
     * allowDestructive: 0043 must DROP the single-hold-per-destination unique index. The runner
     * correctly refuses destructive SQL unless the operator opts in; that is safe on this suite's
     * own disposable database, and still requires owner approval anywhere real.
     */
    const all = listMigrationFiles();
    await applyMigrations(migrator, all.filter((f) => Number(f.number) <= 41), { allowDestructive: true });
    await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
    await applyMigrations(migrator, all, { allowDestructive: true });
  } finally {
    await migrator.end();
  }
}

/** Run fn as the restricted partner_runtime role with an app.tenant_id GUC set (mirrors partner-rls). */
async function asPartner(tenant: string | null, fn: () => Promise<void>): Promise<void> {
  await admin.query("SET ROLE partner_runtime");
  if (tenant === null) await admin.query("SELECT set_config('app.tenant_id', '', false)");
  else await admin.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
  try {
    await fn();
  } finally {
    await admin.query("RESET ROLE");
  }
}

(isLocal ? describe : describe.skip)("Partner Network G5 — migration 0015 partner management (disposable DB)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await provisionRealisticRoles(admin);
    // MintVault-internal tables the connector migrations (0010+) grant against — owned by pn_migrator.
    await admin.query("CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)");
    await admin.query("CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)");
    await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)");
    /**
     * Later migrations this suite now applies need more MintVault base tables than G5 ever did:
     * 0018 indexes audit_log, and 0041 attaches credit-hold guard triggers to certificates and
     * label_prints. Without them the runner aborts in beforeAll with `relation "audit_log" does
     * not exist` — a FILE-level failure that vitest reports as "10 skipped", which reads exactly
     * like an ungated suite. The suite only ever passed against a database left populated by an
     * earlier run.
     */
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
      admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await createMintvaultCertificatesTable(admin);
    await createMintvaultLabelPrintsTable(admin);
    for (const t of ["audit_log", "certificates", "label_prints"]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyAllRealistic();
    // two orgs for FK + RLS isolation
    await admin.query("INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'rA5','A5 Ltd','ACTIVE'),($2,'rB5','B5 Ltd','ACTIVE') ON CONFLICT DO NOTHING", [A, B]);
    // seed one contact per org (owner insert bypasses RLS)
    await admin.query("INSERT INTO partner_contacts (tenant_id, full_name, contact_type, is_primary) VALUES ($1,'Alice A','general',true),($2,'Bob B','general',true)", [A, B]);
  }, 60_000);

  afterAll(async () => {
    await admin?.query("RESET ROLE").catch(() => {});
    await admin?.end().catch(() => {});
  });

  it("0015 is applied and journaled", async () => {
    const { rows } = await admin.query("SELECT status FROM schema_migrations WHERE filename = '0015_partner_management.sql'");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("applied");
  });

  it("reapplying the full set is a clean no-op", async () => {
    const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
    await migrator.connect();
    try {
      const plan = await planMigrations(migrator, listMigrationFiles());
      expect(plan.pending).toHaveLength(0);
      expect(plan.checksumMismatches).toHaveLength(0);
      await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE").catch(() => {});
      const { applied } = await applyMigrations(migrator, listMigrationFiles(), { allowDestructive: true });
      expect(applied).toHaveLength(0);
    } finally {
      await migrator.end();
    }
  });

  it("preflight classifies the 5 new tables as Partner Network and stays ok", async () => {
    const r = await runPreflight(ADMIN!);
    expect(r.ok).toBe(true);
    expect(r.unknown).toEqual([]);
    expect(r.partnerNetwork).toEqual(
      expect.arrayContaining(["partner_profiles", "partner_contacts", "partner_branding", "partner_internal_notes", "partner_management_audit"])
    );
  });

  it("exact index inventory per new table", async () => {
    const idx = async (t: string) => (await admin.query("SELECT indexname FROM pg_indexes WHERE tablename=$1 ORDER BY indexname", [t])).rows.map((r) => r.indexname);
    expect(await idx("partner_profiles")).toEqual(["partner_profiles_pkey", "partner_profiles_tenant_id_key"]);
    expect(await idx("partner_contacts")).toEqual(["idx_partner_contacts_tenant", "partner_contacts_pkey", "uq_partner_contacts_primary"]);
    expect(await idx("partner_branding")).toEqual(["partner_branding_pkey", "partner_branding_tenant_id_key"]);
    expect(await idx("partner_internal_notes")).toEqual(["idx_partner_internal_notes_tenant", "partner_internal_notes_pkey"]);
    expect(await idx("partner_management_audit")).toEqual([
      "idx_partner_management_audit_tenant",
      "partner_management_audit_pkey",
      "uq_partner_management_audit_idem",
    ]);
  });

  it("grants: data tables SELECT to partner_runtime; evidence tables SELECT+INSERT to partner_connector_runtime; no PUBLIC", async () => {
    const grantsFor = async (t: string, grantee: string) =>
      (await admin.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee=$2 ORDER BY privilege_type", [t, grantee])).rows.map((r) => r.privilege_type);
    for (const t of ["partner_profiles", "partner_contacts", "partner_branding"]) {
      expect(await grantsFor(t, "partner_runtime")).toEqual(["SELECT"]);
      expect(await grantsFor(t, "partner_connector_runtime")).toEqual([]);
    }
    for (const t of ["partner_internal_notes", "partner_management_audit"]) {
      expect(await grantsFor(t, "partner_connector_runtime")).toEqual(["INSERT", "SELECT"]);
      expect(await grantsFor(t, "partner_runtime")).toEqual([]); // never partner-visible
    }
    const pub = await admin.query(
      "SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_name IN ('partner_profiles','partner_contacts','partner_branding','partner_internal_notes','partner_management_audit')"
    );
    expect(pub.rows[0].n).toBe(0);
  });

  it("FORCE RLS + tenant policy on the 3 data tables", async () => {
    const forced = await admin.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('partner_profiles','partner_contacts','partner_branding') ORDER BY relname"
    );
    for (const r of forced.rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
    const pol = await admin.query("SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('partner_profiles','partner_contacts','partner_branding')");
    expect(pol.rows.map((r) => r.policyname).sort()).toEqual([
      "partner_branding_tenant_isolation",
      "partner_contacts_tenant_isolation",
      "partner_profiles_tenant_isolation",
    ]);
    // evidence tables have NO RLS (internal, admin-written)
    const noRls = await admin.query("SELECT relrowsecurity FROM pg_class WHERE relname IN ('partner_internal_notes','partner_management_audit')");
    for (const r of noRls.rows) expect(r.relrowsecurity).toBe(false);
  });

  it("RLS cross-tenant SELECT isolation for partner_runtime on partner_contacts", async () => {
    await asPartner(A, async () => {
      const r = await admin.query<{ full_name: string }>("SELECT full_name FROM partner_contacts");
      expect(r.rows.map((x) => x.full_name)).toEqual(["Alice A"]); // only A's row
    });
    await asPartner(B, async () => {
      const r = await admin.query<{ full_name: string }>("SELECT full_name FROM partner_contacts");
      expect(r.rows.map((x) => x.full_name)).toEqual(["Bob B"]);
    });
    await asPartner(null, async () => {
      const r = await admin.query("SELECT full_name FROM partner_contacts");
      expect(r.rows).toHaveLength(0); // fail-closed on missing context
    });
  });

  it("append-only: partner_connector_runtime INSERT/SELECT ok; UPDATE/DELETE/TRUNCATE reject 42501", async () => {
    await admin.query("SET ROLE partner_connector_runtime");
    try {
      await admin.query("INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email) VALUES ($1,'x',gen_random_uuid(),'a@e.com')", [A]);
      await admin.query("INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result) VALUES ($1,'note_added',gen_random_uuid(),'a@e.com','r1','attempted')", [A]);
      await expect(admin.query("UPDATE partner_internal_notes SET body='y'")).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query("DELETE FROM partner_internal_notes")).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query("TRUNCATE partner_management_audit")).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query("UPDATE partner_management_audit SET result='succeeded'")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await admin.query("RESET ROLE");
    }
  });

  it("contact-primary partial-unique blocks a 2nd active primary; audit idempotency blocks a 2nd succeeded key", async () => {
    await expect(
      admin.query("INSERT INTO partner_contacts (tenant_id, full_name, contact_type, is_primary, active) VALUES ($1,'Second Primary','general',true,true)", [A])
    ).rejects.toMatchObject({ code: "23505" });
    // a non-primary (or inactive) contact for the same org is fine
    await admin.query("INSERT INTO partner_contacts (tenant_id, full_name, contact_type, is_primary, active) VALUES ($1,'Non Primary','billing',false,true)", [A]);
    await admin.query("INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, result) VALUES ($1,'note_added',gen_random_uuid(),'a@e.com','r2','idem-g5-1','succeeded')", [A]);
    await expect(
      admin.query("INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, result) VALUES ($1,'note_added',gen_random_uuid(),'a@e.com','r3','idem-g5-1','succeeded')", [A])
    ).rejects.toMatchObject({ code: "23505" });
  });

  /**
   * The G5 rollback REFUSES once later migrations are applied, and that refusal is the correct
   * behaviour to pin.
   *
   * This test previously asserted the rollback succeeded — valid when 0015 was the newest
   * migration. The suite now drives the real runner over EVERY migration file, so 0016+ are
   * journalled and `rollback-partner-management.sql` correctly refuses: dropping the G5 tables
   * underneath the wallet, reservation and credit-lifecycle migrations that build on them would
   * corrupt the schema. Asserting the old outcome would mean weakening a guard to satisfy a test.
   *
   * The refusal is also SAFE: the script is wrapped in a single transaction, so nothing is
   * dropped. That is what the survival assertions below prove.
   */
  it("the G5 rollback refuses while later migrations are applied, and drops nothing", async () => {
    const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
    await migrator.connect();
    try {
      await expect(migrator.query(rb("rollback-partner-management.sql"))).rejects.toThrow(
        /refusing G5 rollback: a later migration \(0016\+\) is applied/i
      );
      // Every G5 table survives the refused rollback, and the journal row is intact.
      for (const t of [
        "partner_profiles",
        "partner_contacts",
        "partner_branding",
        "partner_internal_notes",
        "partner_management_audit",
      ]) {
        const e = await admin.query("SELECT to_regclass($1) AS t", [`public.${t}`]);
        expect(e.rows[0].t, `${t} must survive a refused rollback`).not.toBeNull();
      }
      const j = await admin.query("SELECT 1 FROM schema_migrations WHERE filename='0015_partner_management.sql'");
      expect(j.rows).toHaveLength(1);
      // G4 table is untouched either way.
      expect((await admin.query("SELECT to_regclass('partner_connector_admin_actions') AS t")).rows[0].t).not.toBeNull();
    } finally {
      await migrator.end();
    }
  });
});
