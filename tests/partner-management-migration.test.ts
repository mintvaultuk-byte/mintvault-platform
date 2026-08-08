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
import { provisionRealisticRoles, migratorUrlFrom, createMintvaultCertificatesTable, createMintvaultLabelPrintsTable, MIGRATOR_ROLE } from "./helpers/partner-realistic-db";
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

  it("grants: data tables SELECT to partner_runtime; evidence tables reachable by NO role but their owner (0052); no PUBLIC", async () => {
    const grantsFor = async (t: string, grantee: string) =>
      (await admin.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee=$2 ORDER BY privilege_type", [t, grantee])).rows.map((r) => r.privilege_type);
    for (const t of ["partner_profiles", "partner_contacts", "partner_branding"]) {
      expect(await grantsFor(t, "partner_runtime")).toEqual(["SELECT"]);
      expect(await grantsFor(t, "partner_connector_runtime")).toEqual([]);
    }
    /**
     * 0052 REVOKEd the 0015:159 `GRANT SELECT, INSERT … TO partner_connector_runtime` on both
     * internal-evidence tables. It was dead privilege: every reference to either table in the
     * repository runs on the privileged admin pool, so nothing lost reach.
     *
     * The pin below is deliberately STRONGER than "the connector grant is now []". Pinning only
     * that would go green again the moment some future blanket GRANT loop (which is exactly how
     * the kill-switch defect 0051 had to repair came about) handed the privilege to a DIFFERENT
     * role. What 0052 actually establishes is that NO role other than the table OWNER holds any
     * privilege on these tables, by any route, at TABLE or COLUMN level — so that is what is
     * asserted, as an allowlist of one. A table-level REVOKE does not remove column grants, which
     * is why column_privileges is swept separately rather than trusted to follow.
     */
    for (const t of ["partner_internal_notes", "partner_management_audit"]) {
      expect(await grantsFor(t, "partner_connector_runtime")).toEqual([]);
      expect(await grantsFor(t, "partner_runtime")).toEqual([]); // never partner-visible
      const otherGrantees = (
        await admin.query<{ grantee: string }>(
          "SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=$1 AND grantee <> $2 ORDER BY grantee",
          [t, MIGRATOR_ROLE]
        )
      ).rows.map((r) => r.grantee);
      expect(otherGrantees, `${t}: a non-owner role holds a table privilege on an internal-evidence table`).toEqual([]);
      const otherColumnGrantees = (
        await admin.query<{ grantee: string }>(
          "SELECT DISTINCT grantee FROM information_schema.column_privileges WHERE table_schema='public' AND table_name=$1 AND grantee <> $2 ORDER BY grantee",
          [t, MIGRATOR_ROLE]
        )
      ).rows.map((r) => r.grantee);
      expect(otherColumnGrantees, `${t}: column-level privilege residue survives the 0052 REVOKE`).toEqual([]);
      // The owner keeps full DML — it is the identity the privileged admin pool connects as, and
      // it is the ONLY principal that legitimately writes these tables after 0052.
      expect(await grantsFor(t, MIGRATOR_ROLE)).toEqual(["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]);
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
  });

  /**
   * 0052 gave the two internal-evidence tables the SAME treatment 0015:138-149 gave the three data
   * tables. This test previously pinned `relrowsecurity === false` on them and described that as
   * intentional ("evidence tables have NO RLS, internal, admin-written"). That was true when 0015
   * was the newest migration; it is now the pre-repair state, and pinning it would mean the suite
   * demands the vulnerability back.
   *
   * The shape asserted here is exactly what 0052's own post-flight requires, restated from the
   * catalogue rather than trusted from the migration: ENABLE **and** FORCE (ENABLE alone leaves the
   * owner unbound), exactly ONE policy per table, and that policy tenant-scoped in BOTH directions.
   * USING alone would leave INSERT unconstrained; WITH CHECK alone would leave SELECT unconstrained.
   */
  it("0052: FORCE RLS + a both-directions tenant policy on the 2 internal-evidence tables", async () => {
    for (const t of ["partner_internal_notes", "partner_management_audit"]) {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relname=$1",
        [t]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].relrowsecurity, `${t}: RLS is not enabled`).toBe(true);
      expect(rows[0].relforcerowsecurity, `${t}: RLS is enabled but not FORCEd — the owner stays unbound`).toBe(true);
      const pol = await admin.query<{ policyname: string; qual: string; with_check: string }>(
        "SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename=$1",
        [t]
      );
      // FINAL state, after the whole chain: 0052 installs %I_tenant_isolation, and 0056 then
      // DROPS it and replaces it with a deny-all %I_no_tenant_access (0056:138-142). These are HQ
      // control tables — no tenant-scoped role may read or write them at all, so the deny-all is
      // strictly stronger than the tenant policy it supersedes. Asserting the 0052-era name here
      // was pinning an intermediate state that 0056 deliberately removes.
      expect(pol.rows.map((r) => r.policyname)).toEqual([`${t}_no_tenant_access`]);
      expect(pol.rows[0].qual, `${t}: the deny-all must not be readable by any tenant`).toContain("false");
      expect(pol.rows[0].with_check, `${t}: the deny-all must not be writable by any tenant`).toContain("false");
    }
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

  /**
   * ==========================================================================================
   * THE APPEND-ONLY PROOF, AFTER 0052
   * ==========================================================================================
   * Before 0052 the append-only property of the two internal-evidence tables was enforced by the
   * SHAPE OF A GRANT: 0015:159 gave partner_connector_runtime SELECT + INSERT and nothing else, so
   * UPDATE / DELETE / TRUNCATE came back 42501. That is what this block used to assert.
   *
   * 0052 REVOKEd that grant outright, because it was dead privilege — every reference to either
   * table in the repository runs on the privileged admin pool. So the old assertion now fails on
   * the very FIRST statement with "permission denied for table partner_internal_notes", and the
   * connector role is no longer a principal that writes these tables at all.
   *
   * Simply flipping the expected values to "42501 on everything" would record the weaker half of
   * what changed. The three tests below pin the whole of it:
   *
   *   (1) LOCKOUT — the primary repair. Neither restricted role can touch either table by any DML
   *       verb. A revoked privilege beats a policy: it cannot be defeated by a policy mistake.
   *   (2) APPEND-ONLY UNDER A RESTORED GRANT — the defence in depth. 0001's blanket GRANT loop is
   *       precisely how the kill-switch defect 0051 had to repair came about, so the repair has to
   *       survive the grant coming back. Restoring the exact 0015:159 grant inside the test and
   *       re-attacking is the ONLY way to show the second layer binds at all; the catalogue flags
   *       alone would not. Append-only AND tenant-scoping are both proved, then the grant is
   *       removed again and the post-0052 catalogue re-asserted, so the test cannot leave the
   *       database in the pre-repair state for anything that runs after it.
   *   (3) THE LEGITIMATE WRITER — the admin pool. It is the only principal that still writes these
   *       tables, and after 0052 its cross-tenant reads work ONLY because it holds BYPASSRLS: FORCE
   *       ROW LEVEL SECURITY binds even the table OWNER, so an owner-privileged NOBYPASSRLS
   *       connection would see zero rows and HQ's notes/audit reads would silently return nothing.
   *       That makes the pool's BYPASSRLS load-bearing rather than incidental, and (3) proves both
   *       sides of it against real roles instead of taking 0052's header comment on trust.
   */
  it("0052 (1): both restricted roles are locked out of the evidence tables entirely — no DML verb reaches them", async () => {
    for (const role of ["partner_connector_runtime", "partner_runtime"]) {
      await admin.query(`SET ROLE ${role}`);
      try {
        for (const t of ["partner_internal_notes", "partner_management_audit"]) {
          await expect(admin.query(`SELECT * FROM ${t}`), `${role} can SELECT ${t}`).rejects.toMatchObject({ code: "42501" });
          await expect(admin.query(`DELETE FROM ${t}`), `${role} can DELETE ${t}`).rejects.toMatchObject({ code: "42501" });
          await expect(admin.query(`TRUNCATE ${t}`), `${role} can TRUNCATE ${t}`).rejects.toMatchObject({ code: "42501" });
        }
        await expect(
          admin.query("INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email) VALUES ($1,'x',gen_random_uuid(),'a@e.com')", [A])
        ).rejects.toMatchObject({ code: "42501" });
        await expect(admin.query("UPDATE partner_internal_notes SET body='y'")).rejects.toMatchObject({ code: "42501" });
        await expect(
          admin.query(
            "INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result) VALUES ($1,'note_added',gen_random_uuid(),'a@e.com','r1','attempted')",
            [A]
          )
        ).rejects.toMatchObject({ code: "42501" });
        await expect(admin.query("UPDATE partner_management_audit SET result='succeeded'")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await admin.query("RESET ROLE");
      }
    }
  });

  it("0052 (2): with the 0015 grant restored, writes stay append-only AND tenant-scoped — then the grant is gone again", async () => {
    // The exact statement 0052 revoked, restored verbatim.
    await admin.query("GRANT SELECT, INSERT ON partner_internal_notes, partner_management_audit TO partner_connector_runtime");
    try {
      await admin.query("SET ROLE partner_connector_runtime");
      await admin.query("SELECT set_config('app.tenant_id', $1, false)", [A]);
      // After 0056 an OWN-tenant row is refused TOO. 0052 made these tables tenant-scoped; 0056
      // then made them HQ-only outright (deny-all, USING false / WITH CHECK false), so restoring
      // 0015's grant now buys a tenant-scoped role nothing at all — which is a strictly stronger
      // outcome than the tenant-scoped write this originally asserted.
      await expect(
        admin.query("INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email) VALUES ($1,'own-tenant note',gen_random_uuid(),'a@e.com')", [A])
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        admin.query(
          "INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result) VALUES ($1,'note_added',gen_random_uuid(),'a@e.com','r1','attempted')",
          [A]
        )
      ).rejects.toMatchObject({ code: "42501" });
      // …an OTHER-tenant row is not. Without 0052's policy this would have succeeded: the grant
      // alone carries no tenant scope, which is the whole reason the second layer exists.
      await expect(
        admin.query("INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email) VALUES ($1,'cross-tenant forge',gen_random_uuid(),'b@e.com')", [B])
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        admin.query(
          "INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result) VALUES ($1,'note_added',gen_random_uuid(),'b@e.com','r-forge','attempted')",
          [B]
        )
      ).rejects.toMatchObject({ code: "42501" });
      // …and the reads are confined to the acting tenant, so a restored grant is not a leak either.
      const seen = await admin.query<{ n: number }>("SELECT count(*) FILTER (WHERE tenant_id <> $1)::int AS n FROM partner_internal_notes", [A]);
      expect(seen.rows[0].n, "a restored grant let the connector role read another tenant's notes").toBe(0);
      // APPEND-ONLY: the restored grant carries SELECT + INSERT only, so mutation is still 42501.
      await expect(admin.query("UPDATE partner_internal_notes SET body='y'")).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query("DELETE FROM partner_internal_notes")).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query("TRUNCATE partner_management_audit")).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query("UPDATE partner_management_audit SET result='succeeded'")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await admin.query("RESET ROLE").catch(() => {});
      await admin.query("REVOKE ALL ON partner_internal_notes, partner_management_audit FROM partner_connector_runtime").catch(() => {});
    }
    // The database is back in the post-0052 state this suite asserts everywhere else.
    const residue = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='partner_connector_runtime' AND table_name IN ('partner_internal_notes','partner_management_audit')"
    );
    expect(residue.rows[0].n, "this test left the pre-0052 grant behind").toBe(0);
  });

  it("0052 (3): the admin pool still writes and reads both tables across tenants — and only because it holds BYPASSRLS", async () => {
    // Seed one row per tenant on the superuser connection (which models the privileged pool).
    await admin.query("SELECT set_config('app.tenant_id', '', false)");
    for (const t of [A, B]) {
      await admin.query("INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email) VALUES ($1,'pool-written',gen_random_uuid(),'hq@e.com')", [t]);
    }
    const both = await admin.query<{ n: number }>("SELECT count(DISTINCT tenant_id)::int n FROM partner_internal_notes WHERE body='pool-written'");
    expect(both.rows[0].n).toBe(2);

    /**
     * Now the same reach through two roles that differ ONLY in BYPASSRLS, both holding identical
     * table privileges. partner_definer is the estate's BYPASSRLS role (provisioned by
     * partner-realistic-db); pn_migrator OWNS these tables and is NOBYPASSRLS.
     */
    const roleFacts = await admin.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('partner_definer', $1) ORDER BY rolname",
      [MIGRATOR_ROLE]
    );
    expect(roleFacts.rows.find((r) => r.rolname === "partner_definer")).toMatchObject({ rolbypassrls: true, rolsuper: false });
    expect(roleFacts.rows.find((r) => r.rolname === MIGRATOR_ROLE)).toMatchObject({ rolbypassrls: false, rolsuper: false });

    await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON partner_internal_notes TO partner_definer");
    try {
      // No tenant context at all — exactly how the admin pool reads, with its own WHERE clause.
      await admin.query("SELECT set_config('app.tenant_id', '', false)");
      await admin.query("SET ROLE partner_definer");
      const bypass = await admin.query<{ n: number }>("SELECT count(DISTINCT tenant_id)::int n FROM partner_internal_notes");
      expect(bypass.rows[0].n, "BYPASSRLS did not outrank FORCE RLS — the admin pool's cross-tenant reads are broken").toBe(2);
      await admin.query("RESET ROLE");

      // The OWNER, with strictly more table privilege but no BYPASSRLS, is bound by FORCE RLS.
      await admin.query(`SET ROLE ${MIGRATOR_ROLE}`);
      const owned = await admin.query<{ n: number }>("SELECT count(*)::int n FROM partner_internal_notes");
      expect(owned.rows[0].n, "FORCE ROW LEVEL SECURITY is not binding the table owner").toBe(0);
    } finally {
      await admin.query("RESET ROLE").catch(() => {});
      await admin.query("REVOKE ALL ON partner_internal_notes FROM partner_definer").catch(() => {});
    }
    const residue = await admin.query<{ n: number }>(
      "SELECT count(*)::int n FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='partner_definer' AND table_name='partner_internal_notes'"
    );
    expect(residue.rows[0].n, "this test left a grant on partner_definer behind").toBe(0);
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
