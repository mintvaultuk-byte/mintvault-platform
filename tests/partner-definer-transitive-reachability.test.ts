/**
 * DEFECT 2 — TRANSITIVE reachability of the SECURITY DEFINER roles, on real PostgreSQL.
 *
 * The previous guard read pg_auth_members directly. That table records ONE hop of the role graph,
 * but PostgreSQL role membership is transitive, so
 *
 *     GRANT partner_credit_lifecycle_definer TO ops_intermediate;
 *     GRANT ops_intermediate TO partner_runtime;
 *
 * gives partner_runtime full inherited use of the definer while producing NO pg_auth_members row
 * that links the two. The guard reported healthy and the escalation path was invisible. Chains of
 * arbitrary depth behave the same way.
 *
 * Two definer roles are protected:
 *   partner_definer                     owns the PRE-AUTH lookups and is BYPASSRLS. A role that can
 *                                       inherit it reads every tenant's credentials. This role
 *                                       previously had NO membership check at all.
 *   partner_credit_lifecycle_definer    owns the credit settlement function.
 *
 * HARNESS INTEGRITY: pg_has_role reports true for a SUPERUSER against every role, so a superuser
 * connection cannot distinguish a healthy model from a compromised one. The proof therefore runs
 * as a dedicated NON-superuser login and asserts that fact before making any claim.
 *
 * MUTATION TARGET: ROLE3 (add transitive access through an intermediate role) must turn this red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  definerReachabilityViolations,
  partnerCreditDefinerModelViolations,
  definerModelViolations,
  DEFINER_ROLE,
  CREDIT_LIFECYCLE_DEFINER_ROLE,
  RUNTIME_ROLE,
  CONNECTOR_RUNTIME_ROLE,
} from "../server/partner/definer-guard";

let cluster: DisposablePostgres17;
let admin: Client; // superuser — provisioning and mutation only
let probe: Client; // NON-superuser — every assertion is evaluated through this connection

const PROBE_LOGIN = "partner_definer_probe";
const PROBE_PASSWORD = "synthetic"; // disposable cluster only

const q = (client: Client) => (sql: string, params?: unknown[]) => client.query(sql, params);

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz, grading_status varchar(30),
    assigned_grader_id varchar, scan_status varchar(30), scan_assigned_to varchar,
    shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
    return_tracking text, return_carrier text, return_service text,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query("CREATE TABLE certificates (id serial primary key, cert_id text)");
  await admin.query("CREATE TABLE label_prints (id serial primary key, certificate_id integer)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/** Create a throwaway NOLOGIN role for grant-graph experiments. */
async function makeRole(name: string): Promise<void> {
  await admin.query(
    `DO $$ BEGIN CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOBYPASSRLS;
     EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
  );
}

async function dropRole(name: string): Promise<void> {
  await admin.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
}

describe("Partner definer transitive reachability (real PostgreSQL, non-superuser probe)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-definer-transitive");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);

    await admin.query(`DO $$ BEGIN
        CREATE ROLE ${PROBE_LOGIN} LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    const probeUrl = new URL(cluster.url);
    probeUrl.username = PROBE_LOGIN;
    probeUrl.password = PROBE_PASSWORD;
    probe = new Client({ connectionString: probeUrl.toString() });
    await probe.connect();
  }, 120_000);

  afterAll(async () => {
    await probe?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // ------------------------------------------------------------------ harness integrity
  describe("harness integrity", () => {
    it("FAILS LOUDLY if the probe connection is a superuser", async () => {
      const r = await probe.query<{ rolname: string; rolsuper: boolean; bypassrls: boolean }>(
        `SELECT current_user AS rolname,
                (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS rolsuper,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls`
      );
      // pg_has_role() returns true for a superuser against EVERY role, so a superuser probe cannot
      // tell a healthy model from a compromised one. Every assertion below would be vacuous.
      expect(r.rows[0].rolsuper, `probe ${r.rows[0].rolname} must NOT be a superuser`).toBe(false);
      expect(r.rows[0].bypassrls, `probe ${r.rows[0].rolname} must NOT have BYPASSRLS`).toBe(false);
    });

    it("both definer roles exist and are NOSUPERUSER + NOLOGIN + BYPASSRLS", async () => {
      for (const role of [DEFINER_ROLE, CREDIT_LIFECYCLE_DEFINER_ROLE]) {
        const r = await probe.query<{ rolsuper: boolean; rolcanlogin: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname=$1",
          [role]
        );
        expect(r.rowCount, `${role} must exist`).toBe(1);
        expect(r.rows[0].rolsuper).toBe(false);
        expect(r.rows[0].rolcanlogin).toBe(false);
        expect(r.rows[0].rolbypassrls).toBe(true);
      }
    });

    it("a superuser probe would report the model healthy no matter what — proving the probe matters", async () => {
      // Grant partner_runtime full inherited use of the credit definer, then evaluate the SAME
      // check through the superuser connection. It sees nothing, because pg_has_role is true for a
      // superuser everywhere and the offender filter drops superusers. Only the non-superuser
      // probe below can detect this.
      await admin.query(`GRANT ${CREDIT_LIFECYCLE_DEFINER_ROLE} TO ${RUNTIME_ROLE} WITH INHERIT TRUE, SET FALSE`);
      try {
        const viaProbe = await definerReachabilityViolations(q(probe), CREDIT_LIFECYCLE_DEFINER_ROLE);
        expect(viaProbe.some((v) => v.includes(RUNTIME_ROLE))).toBe(true);
      } finally {
        await admin.query(`REVOKE ${CREDIT_LIFECYCLE_DEFINER_ROLE} FROM ${RUNTIME_ROLE} CASCADE`);
      }
    });
  });

  // ------------------------------------------------------------------ healthy baseline
  describe("legitimate provider state is NOT flagged", () => {
    it("the realistic post-migration model is clean for both definers", async () => {
      expect(await definerReachabilityViolations(q(probe), CREDIT_LIFECYCLE_DEFINER_ROLE)).toEqual([]);
      expect(await definerReachabilityViolations(q(probe), DEFINER_ROLE)).toEqual([]);
    });

    it("the full guards report healthy", async () => {
      expect(await partnerCreditDefinerModelViolations(q(probe))).toEqual([]);
      expect(await definerModelViolations(q(probe))).toEqual([]);
    });

    it("the database owner's INHERIT is tolerated — it is required to maintain the functions", async () => {
      // pn_migrator IS the database owner in the realistic model and holds INHERIT after the
      // owner-approved 0042 repair. Flagging it would make 0042 unappliable and 0041
      // un-rollback-able, which is exactly the contradiction that produced HTTP 409 on Neon.
      const owner = await probe.query<{ inherits: boolean; is_owner: boolean }>(
        `SELECT pg_has_role(r.oid, d.oid, 'USAGE') AS inherits,
                (r.oid = (SELECT datdba FROM pg_database WHERE datname=current_database())) AS is_owner
           FROM pg_roles r JOIN pg_roles d ON d.rolname=$1
          WHERE r.rolname='pn_migrator'`,
        [CREDIT_LIFECYCLE_DEFINER_ROLE]
      );
      expect(owner.rows[0].is_owner).toBe(true);
      expect(owner.rows[0].inherits).toBe(true);
      expect(await definerReachabilityViolations(q(probe), CREDIT_LIFECYCLE_DEFINER_ROLE)).toEqual([]);
    });

    it("an ADMIN-option-only membership row confers no capability and is tolerated", async () => {
      await makeRole("ops_admin_only");
      try {
        await admin.query(
          `GRANT ${CREDIT_LIFECYCLE_DEFINER_ROLE} TO ops_admin_only WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
        );
        expect(await definerReachabilityViolations(q(probe), CREDIT_LIFECYCLE_DEFINER_ROLE)).toEqual([]);
      } finally {
        await admin.query(`REVOKE ${CREDIT_LIFECYCLE_DEFINER_ROLE} FROM ops_admin_only CASCADE`).catch(() => {});
        await dropRole("ops_admin_only");
      }
    });
  });

  // ------------------------------------------------------------------ escalation detection
  for (const definer of [CREDIT_LIFECYCLE_DEFINER_ROLE, DEFINER_ROLE]) {
    describe(`escalation paths into ${definer}`, () => {
      it("DIRECT grant with INHERIT is detected (USAGE)", async () => {
        await makeRole("ops_direct");
        try {
          await admin.query(`GRANT ${definer} TO ops_direct WITH INHERIT TRUE, SET FALSE`);
          const v = await definerReachabilityViolations(q(probe), definer);
          expect(v.some((x) => x.includes("ops_direct") && x.includes("USAGE"))).toBe(true);
        } finally {
          await admin.query(`REVOKE ${definer} FROM ops_direct CASCADE`).catch(() => {});
          await dropRole("ops_direct");
        }
      });

      it("DIRECT grant with SET only is detected (SET ROLE)", async () => {
        // SET-only confers no inherited privilege but DOES allow `SET ROLE definer`, which is a
        // complete escalation the moment the session chooses to use it.
        await makeRole("ops_setonly");
        try {
          await admin.query(`GRANT ${definer} TO ops_setonly WITH INHERIT FALSE, SET TRUE`);
          const v = await definerReachabilityViolations(q(probe), definer);
          expect(v.some((x) => x.includes("ops_setonly") && x.includes("SET ROLE"))).toBe(true);
        } finally {
          await admin.query(`REVOKE ${definer} FROM ops_setonly CASCADE`).catch(() => {});
          await dropRole("ops_setonly");
        }
      });

      it("INTERMEDIATE-role grant is detected — the case pg_auth_members cannot see", async () => {
        await makeRole("ops_intermediate");
        await makeRole("ops_leaf");
        try {
          await admin.query(`GRANT ${definer} TO ops_intermediate WITH INHERIT TRUE, SET FALSE`);
          await admin.query("GRANT ops_intermediate TO ops_leaf WITH INHERIT TRUE, SET FALSE");

          // There is NO pg_auth_members row linking ops_leaf to the definer.
          const direct = await probe.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_auth_members m
               JOIN pg_roles role ON role.oid=m.roleid
               JOIN pg_roles member ON member.oid=m.member
              WHERE role.rolname=$1 AND member.rolname='ops_leaf'`,
            [definer]
          );
          expect(direct.rows[0].n).toBe("0");

          // ...and yet ops_leaf inherits the definer in full.
          const v = await definerReachabilityViolations(q(probe), definer);
          expect(v.some((x) => x.includes("ops_leaf"))).toBe(true);
        } finally {
          await admin.query(`REVOKE ${definer} FROM ops_intermediate CASCADE`).catch(() => {});
          await dropRole("ops_leaf");
          await dropRole("ops_intermediate");
        }
      });

      it("MULTI-LEVEL inherited grant (3 hops) is detected", async () => {
        await makeRole("ops_l1");
        await makeRole("ops_l2");
        await makeRole("ops_l3");
        try {
          await admin.query(`GRANT ${definer} TO ops_l1 WITH INHERIT TRUE, SET FALSE`);
          await admin.query("GRANT ops_l1 TO ops_l2 WITH INHERIT TRUE, SET FALSE");
          await admin.query("GRANT ops_l2 TO ops_l3 WITH INHERIT TRUE, SET FALSE");
          const v = await definerReachabilityViolations(q(probe), definer);
          expect(v.some((x) => x.includes("ops_l3"))).toBe(true);
        } finally {
          await admin.query(`REVOKE ${definer} FROM ops_l1 CASCADE`).catch(() => {});
          await dropRole("ops_l3");
          await dropRole("ops_l2");
          await dropRole("ops_l1");
        }
      });

      for (const runtime of [RUNTIME_ROLE, CONNECTOR_RUNTIME_ROLE]) {
        it(`RUNTIME escalation via an intermediate role is detected and named: ${runtime}`, async () => {
          await makeRole("ops_bridge");
          try {
            await admin.query(`GRANT ${definer} TO ops_bridge WITH INHERIT TRUE, SET FALSE`);
            await admin.query(`GRANT ops_bridge TO ${runtime} WITH INHERIT TRUE, SET FALSE`);
            const v = await definerReachabilityViolations(q(probe), definer);
            expect(v.some((x) => x.includes(`RUNTIME ROLE ${runtime}`))).toBe(true);
          } finally {
            await admin.query(`REVOKE ops_bridge FROM ${runtime} CASCADE`).catch(() => {});
            await admin.query(`REVOKE ${definer} FROM ops_bridge CASCADE`).catch(() => {});
            await dropRole("ops_bridge");
          }
        });
      }

      it("the full guard surfaces the escalation, not just the low-level helper", async () => {
        await makeRole("ops_guard_check");
        try {
          await admin.query(`GRANT ${definer} TO ops_guard_check WITH INHERIT TRUE, SET FALSE`);
          const v =
            definer === CREDIT_LIFECYCLE_DEFINER_ROLE
              ? await partnerCreditDefinerModelViolations(q(probe))
              : await definerModelViolations(q(probe));
          expect(v.some((x) => x.includes("ops_guard_check"))).toBe(true);
        } finally {
          await admin.query(`REVOKE ${definer} FROM ops_guard_check CASCADE`).catch(() => {});
          await dropRole("ops_guard_check");
        }
      });

      it("the model returns to clean once the grant is removed", async () => {
        expect(await definerReachabilityViolations(q(probe), definer)).toEqual([]);
      });
    });
  }
});
