/**
 * DB-F1 / DB-F2 — SECURITY DEFINER ownership model under FORCE RLS, proven under REALISTIC
 * (non-superuser) ownership on a disposable Postgres.
 *
 * Reproduces the original defect condition — non-superuser, non-BYPASSRLS table owner, FORCE RLS,
 * pre-auth function called with no tenant context — and proves migration 0006 fixes it WITHOUT
 * granting broad privilege to partner_runtime. Also proves the fail-closed guard (definerModelViolations)
 * catches every way the model can be broken, and that the DB-F2 rollbacks are correct.
 *
 * Runs ONLY when PARTNER_DEFINER_ADMIN (a superuser URL to a DISPOSABLE local Postgres) is set:
 *   PARTNER_DEFINER_ADMIN=postgresql://postgres@127.0.0.1:5545/definerdb \
 *   npx vitest run tests/partner-definer-ownership.test.ts
 * The positive REAL-HTTP auth+session proof under this same non-superuser ownership lives in
 * tests/partner-runtime-integration.test.ts (which now applies migrations via the realistic helper).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { applyMigrationsRealistic } from "./helpers/partner-realistic-db";
import { definerModelViolations, DEFINER_FUNCTIONS } from "../server/partner/definer-guard";

const ADMIN = process.env.PARTNER_DEFINER_ADMIN;
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN);

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const UA = "11111111-0000-0000-0000-0000000000a1";

let admin: Client;
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

(isLocal ? describe : describe.skip)("Partner definer ownership under FORCE RLS (realistic, disposable DB)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    // fresh state
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    // apply 0001–0006 under the realistic non-superuser owner model
    await applyMigrationsRealistic(admin, ADMIN!);
    // seed two tenants + a user/session/reset-token AS SUPERUSER (bypasses RLS for seeding only)
    await q(
      "INSERT INTO partner_organisations (id,public_ref,legal_name,status) VALUES ($1,'rA','A Ltd','ACTIVE'),($2,'rB','B Ltd','ACTIVE') ON CONFLICT DO NOTHING",
      [A, B]
    );
    await q(
      "INSERT INTO partner_users (id,public_ref,tenant_id,partner_id,email,password_hash,status,credential_version) VALUES ($1,'ua',$2,$2,'owner@a.com','h','ACTIVE',1) ON CONFLICT DO NOTHING",
      [UA, A]
    );
    await q(
      "INSERT INTO partner_sessions (tenant_id,user_id,token_hash,credential_version,absolute_expires_at) VALUES ($1,$2,'TOK',1, now()+interval '12 hour')",
      [A, UA]
    );
    await q(
      "INSERT INTO partner_password_reset_tokens (tenant_id,user_id,token_hash,expires_at) VALUES ($1,$2,'RST', now()+interval '30 min')",
      [A, UA]
    );
  }, 40_000);

  afterAll(async () => {
    await admin?.query("RESET ROLE").catch(() => {});
    await admin?.end().catch(() => {});
  });

  it("1-3: partner tables are FORCE RLS and owned by a NON-superuser, NON-BYPASSRLS role", async () => {
    const { rows } = await q(
      `SELECT c.relforcerowsecurity AS force, r.rolsuper AS super, r.rolbypassrls AS bypass
         FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname='partner_users'`
    );
    expect(rows[0].force).toBe(true);
    expect(rows[0].super).toBe(false);
    expect(rows[0].bypass).toBe(false);
  });

  it("4-7: partner_runtime is NOSUPERUSER/NOBYPASSRLS and owns no tables or definer functions", async () => {
    const role = await q("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='partner_runtime'");
    expect(role.rows[0].rolsuper).toBe(false);
    expect(role.rows[0].rolbypassrls).toBe(false);
    const ownsTables = await q(
      "SELECT count(*)::int n FROM pg_class WHERE relkind='r' AND relowner=(SELECT oid FROM pg_roles WHERE rolname='partner_runtime')"
    );
    expect(ownsTables.rows[0].n).toBe(0);
    const ownsFns = await q(
      "SELECT count(*)::int n FROM pg_proc WHERE proowner=(SELECT oid FROM pg_roles WHERE rolname='partner_runtime')"
    );
    expect(ownsFns.rows[0].n).toBe(0);
  });

  it("8-11: partner_definer is NOLOGIN/NOSUPERUSER/BYPASSRLS and owns ONLY the three approved functions", async () => {
    const r = await q("SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='partner_definer'");
    expect(r.rows[0].rolcanlogin).toBe(false);
    expect(r.rows[0].rolsuper).toBe(false);
    expect(r.rows[0].rolbypassrls).toBe(true);
    const owned = await q(
      "SELECT proname FROM pg_proc WHERE proowner=(SELECT oid FROM pg_roles WHERE rolname='partner_definer') ORDER BY proname"
    );
    expect(owned.rows.map((x) => x.proname).sort()).toEqual([...DEFINER_FUNCTIONS].sort());
  });

  it("12-14: PUBLIC and unrelated roles cannot execute; partner_runtime can", async () => {
    await q("DROP ROLE IF EXISTS df_outsider").catch(() => {});
    await q("CREATE ROLE df_outsider NOLOGIN");
    for (const fn of DEFINER_FUNCTIONS) {
      const sig = `${fn}(text)`;
      expect((await q(`SELECT has_function_privilege('public','${sig}','EXECUTE') b`)).rows[0].b).toBe(false);
      expect((await q(`SELECT has_function_privilege('df_outsider','${sig}','EXECUTE') b`)).rows[0].b).toBe(false);
      expect((await q(`SELECT has_function_privilege('partner_runtime','${sig}','EXECUTE') b`)).rows[0].b).toBe(true);
    }
    await q("DROP ROLE IF EXISTS df_outsider");
  });

  it("15-18: pre-auth lookups return the right data under NON-superuser ownership (auth/session/reset)", async () => {
    await q("SET ROLE partner_runtime");
    try {
      expect((await q("SELECT count(*)::int n FROM partner_auth_lookup('owner@a.com')")).rows[0].n).toBe(1);
      expect((await q("SELECT count(*)::int n FROM partner_auth_lookup('nobody@a.com')")).rows[0].n).toBe(0);
      expect((await q("SELECT count(*)::int n FROM partner_session_lookup('TOK')")).rows[0].n).toBe(1);
      expect((await q("SELECT partner_reset_token_tenant('RST') t")).rows[0].t).toBe(A);
    } finally {
      await q("RESET ROLE");
    }
  });

  it("19-20: cross-tenant isolation — runtime direct table read is RLS-blocked; lookup only returns the supplied identity", async () => {
    await q("SET ROLE partner_runtime");
    try {
      // no tenant context → RLS blocks direct reads entirely
      expect((await q("SELECT count(*)::int n FROM partner_users")).rows[0].n).toBe(0);
      // the definer lookup returns ONLY the row for the supplied email (tenant A), never tenant B's
      const r = await q("SELECT tenant_id FROM partner_auth_lookup('owner@a.com')");
      expect(r.rows.every((x) => x.tenant_id === A)).toBe(true);
    } finally {
      await q("RESET ROLE");
    }
  });

  it("21: calling the definer function does not establish persistent tenant context on the connection", async () => {
    await q("SET ROLE partner_runtime");
    try {
      await q("SELECT * FROM partner_auth_lookup('owner@a.com')");
      const ctx = await q("SELECT current_setting('app.tenant_id', true) AS t");
      expect(ctx.rows[0].t === null || ctx.rows[0].t === "").toBe(true);
    } finally {
      await q("RESET ROLE");
    }
  });

  it("22: search_path cannot be hijacked with a malicious temp object (SEC-1)", async () => {
    // Create an EMPTY temp table named like the real one. It PERSISTS for this connection (no
    // ON COMMIT DROP), so it is genuinely visible to the next query. With the hardened search_path
    // (public, pg_temp — pg_temp LAST), the definer function must still resolve the REAL
    // public.partner_users (1 row), NOT the empty temp shadow. Without the fix this returns 0.
    await q(
      "CREATE TEMP TABLE partner_users (id uuid, email text, tenant_id uuid, partner_id uuid, password_hash text, status text, credential_version int, failed_login_count int, locked_until timestamptz, mfa_required boolean)"
    );
    try {
      // sanity: the temp shadow is empty and visible on THIS connection
      expect((await q("SELECT count(*)::int n FROM pg_temp.partner_users")).rows[0].n).toBe(0);
      await q("SET ROLE partner_runtime");
      try {
        expect((await q("SELECT count(*)::int n FROM partner_auth_lookup('owner@a.com')")).rows[0].n).toBe(1);
      } finally {
        await q("RESET ROLE");
      }
    } finally {
      await q("DROP TABLE pg_temp.partner_users");
    }
  });

  it("23: function input cannot cause SQL injection", async () => {
    await q("SET ROLE partner_runtime");
    try {
      const evil = "x'; DROP TABLE partner_users; --";
      expect((await q("SELECT count(*)::int n FROM partner_auth_lookup($1)", [evil])).rows[0].n).toBe(0);
    } finally {
      await q("RESET ROLE");
    }
    // table still exists
    expect((await q("SELECT to_regclass('public.partner_users') r")).rows[0].r).toBe("partner_users");
  });

  describe("24-27: the fail-closed guard catches every broken configuration", () => {
    const violations = () => definerModelViolations(q);

    it("healthy model has zero violations", async () => {
      expect(await violations()).toEqual([]);
    });

    it("24: disabling BYPASSRLS on partner_definer is caught", async () => {
      await q("ALTER ROLE partner_definer NOBYPASSRLS");
      expect((await violations()).some((v) => /partner_definer must have BYPASSRLS/.test(v))).toBe(true);
      await q("ALTER ROLE partner_definer BYPASSRLS");
      expect(await violations()).toEqual([]);
    });

    it("25: changing a function owner away from partner_definer is caught", async () => {
      await q("ALTER FUNCTION partner_auth_lookup(text) OWNER TO CURRENT_USER");
      expect((await violations()).some((v) => /partner_auth_lookup must be owned by partner_definer/.test(v))).toBe(
        true
      );
      // restore
      await q("GRANT CREATE ON SCHEMA public TO partner_definer");
      await q("ALTER FUNCTION partner_auth_lookup(text) OWNER TO partner_definer");
      await q("REVOKE CREATE ON SCHEMA public FROM partner_definer");
      expect(await violations()).toEqual([]);
    });

    it("26: granting EXECUTE to PUBLIC is caught", async () => {
      await q("GRANT EXECUTE ON FUNCTION partner_auth_lookup(text) TO PUBLIC");
      expect((await violations()).some((v) => /must NOT be executable by PUBLIC/.test(v))).toBe(true);
      await q("REVOKE EXECUTE ON FUNCTION partner_auth_lookup(text) FROM PUBLIC");
      expect(await violations()).toEqual([]);
    });

    it("27: granting BYPASSRLS to partner_runtime is caught", async () => {
      await q("ALTER ROLE partner_runtime BYPASSRLS");
      expect((await violations()).some((v) => /partner_runtime must NOT have BYPASSRLS/.test(v))).toBe(true);
      await q("ALTER ROLE partner_runtime NOBYPASSRLS");
      expect(await violations()).toEqual([]);
    });

    it("27b (A8-F9): granting BYPASSRLS to partner_connector_runtime is caught too", async () => {
      // The connector runtime is a runtime role in exactly the same sense as partner_runtime —
      // 0008 leans on its NOBYPASSRLS attribute for connector-plane tenant isolation and 0045 makes
      // that attribute load-bearing twice more — but the guard only ever checked partner_runtime.
      // This asserts the ROLE EXISTS first, so a fixture that lacks it cannot turn this proof into
      // a vacuous pass (definerModelViolations is silent on a missing role, by design).
      const present = await q("SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime'");
      expect(present.rows.length).toBe(1);

      // try/finally because role attributes are CLUSTER-scoped, not database-scoped: an assertion
      // failure here would otherwise leave partner_connector_runtime BYPASSRLS for every other
      // suite sharing the cluster, and those suites would then fail for an unrelated reason.
      try {
        await q("ALTER ROLE partner_connector_runtime BYPASSRLS");
        expect((await violations()).some((v) => /partner_connector_runtime must NOT have BYPASSRLS/.test(v))).toBe(
          true
        );
      } finally {
        await q("ALTER ROLE partner_connector_runtime NOBYPASSRLS");
      }
      expect(await violations()).toEqual([]);
    });
  });

  it("28: re-running migration 0006 is deterministic (no error, model still healthy)", async () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "0006_partner_definer_role.sql"), "utf8");
    await q(sql); // idempotent re-apply as superuser
    expect(await definerModelViolations(q)).toEqual([]);
  });
});
