/**
 * REALISTIC (NON-SUPERUSER) MIGRATOR PROOF — G6D role model and per-card settlement migration.
 *
 * WHY THIS FILE EXISTS: the previous harness applied migration 0041 as a SUPERUSER. A superuser
 * passes every ownership check, and 0041's own closing assertion short-circuits on `rolsuper`, so
 * the suite was structurally incapable of detecting either of the two defects that reached
 * staging:
 *   1. `definer-guard.ts` rejected the ADMIN-only membership row that survives on managed
 *      PostgreSQL, so credit settlement returned HTTP 409 on the real database.
 *   2. 0041 left the deployment owner without INHERIT on the definer, so the migration was
 *      neither re-runnable nor rollback-capable.
 *
 * Every migration here runs as the non-superuser `pn_migrator`, which mirrors Neon's project
 * owner: NOSUPERUSER, CREATEROLE, owns schema public, and holds a provider-granted ADMIN-option
 * membership whose grantor is someone else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  applyMigrationsRealistic,
  migratorUrlFrom,
  MIGRATOR_ROLE,
  PARTNER_MIGRATIONS_WITH_G6D,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { partnerCreditDefinerModelViolations } from "../server/partner/definer-guard";

const MIGRATION_TIMEOUT = 180_000;

function queryFn(client: pg.Client) {
  return (text: string, params?: unknown[]) => client.query(text, params);
}

/** Minimal MintVault-side tables the partner migrations reference. */
async function seedMintVaultTables(admin: pg.Client): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO ${MIGRATOR_ROLE}`);
  }
}

describe("Realistic non-superuser migrator — G6D role model", () => {
  let cluster: DisposablePostgres17;
  let admin: pg.Client;

  beforeAll(async () => {
    cluster = await startPostgres17("realistic-migrator-proof");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables(admin);
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_G6D);
  }, MIGRATION_TIMEOUT);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("applies 0041 successfully as a NON-superuser migrator", async () => {
    const who = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
      "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname=$1",
      [MIGRATOR_ROLE]
    );
    expect(who.rows[0].rolsuper).toBe(false);
    expect(who.rows[0].rolcreaterole).toBe(true);

    const fn = await admin.query<{ owner: string }>(
      `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
        WHERE proname='partner_connector_release_submission_credit'`
    );
    expect(fn.rows[0].owner).toBe("partner_credit_lifecycle_definer");
  });

  it("reproduces Neon: the provider ADMIN row survives, with NO usable SET/INHERIT", async () => {
    const rows = await admin.query<{
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(
      `SELECT m.admin_option, m.inherit_option, m.set_option
         FROM pg_auth_members m
         JOIN pg_roles role ON role.oid=m.roleid
         JOIN pg_roles member ON member.oid=m.member
        WHERE role.rolname='partner_credit_lifecycle_definer' AND member.rolname=$1`,
      [MIGRATOR_ROLE]
    );
    // This is the exact shape observed on staging and the shape the old harness could not produce.
    expect(rows.rows.some((r) => r.admin_option === true)).toBe(true);
    expect(rows.rows.some((r) => r.inherit_option === true)).toBe(false);
    expect(rows.rows.some((r) => r.set_option === true)).toBe(false);
  });

  it("GUARD: passes the harmless provider membership row (regression for the 409 defect)", async () => {
    const violations = await partnerCreditDefinerModelViolations(queryFn(admin));
    expect(violations).toEqual([]);
  });

  it("GUARD: rejects a DANGEROUS partner_runtime membership", async () => {
    await admin.query("GRANT partner_credit_lifecycle_definer TO partner_runtime WITH INHERIT TRUE");
    try {
      const violations = await partnerCreditDefinerModelViolations(queryFn(admin));
      // The guard is now a TRANSITIVE capability check (pg_has_role), so the message names the
      // reachable role and how it reaches the definer, rather than the old row-based wording.
      expect(violations.join(" ")).toMatch(/RUNTIME ROLE partner_runtime can reach partner_credit_lifecycle_definer/);
      expect(violations.join(" ")).toMatch(/only the database owner may hold maintenance capability/);
      expect(violations.join(" ")).toContain("partner_runtime");
    } finally {
      await admin.query("REVOKE partner_credit_lifecycle_definer FROM partner_runtime");
    }
    expect(await partnerCreditDefinerModelViolations(queryFn(admin))).toEqual([]);
  });

  it("partner_runtime cannot SET ROLE into the lifecycle definer", async () => {
    await admin.query(`DO $$ BEGIN
        CREATE ROLE pn_rt_probe LOGIN PASSWORD 'probe-pw' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query("GRANT partner_runtime TO pn_rt_probe");
    const url = new URL(cluster.url);
    url.username = "pn_rt_probe";
    url.password = "probe-pw";
    const probe = new pg.Client({ connectionString: url.toString() });
    await probe.connect();
    try {
      await expect(probe.query("SET ROLE partner_credit_lifecycle_definer")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await probe.end();
    }
  });

  it("DEADLOCK PROOF: without the role repair the migrator CANNOT maintain definer-owned functions", async () => {
    const migrator = new pg.Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      // This is exactly what a re-apply of 0041 (or any later migration replacing these
      // functions) attempts, and exactly what fails on staging today.
      await expect(
        migrator.query(`CREATE OR REPLACE FUNCTION partner_destination_credit_hold_guard() RETURNS trigger
             LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
             AS $$ BEGIN RETURN NEW; END; $$;`)
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await migrator.end();
    }
  });

  it("REPAIR PROOF: the owner-approved GRANT (INHERIT only) restores maintenance without SET ROLE", async () => {
    const migrator = new pg.Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      // The exact statement proposed for staging. Executed by the migrator itself — no superuser.
      // SET FALSE is load-bearing: PostgreSQL 16+ defaults role grants to SET TRUE, so omitting
      // it would silently confer SET ROLE. This test caught exactly that defect in the first
      // draft of the staging repair statement.
      await migrator.query(
        `GRANT partner_credit_lifecycle_definer TO ${MIGRATOR_ROLE} WITH INHERIT TRUE, SET FALSE`
      );
      // Maintenance now works...
      await migrator.query(`CREATE OR REPLACE FUNCTION partner_certificate_destination_submission_id(
           p_card_id integer, p_submission_item_id integer) RETURNS integer
           LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
           AS $$ DECLARE v integer; BEGIN RETURN v; END; $$;`);
      // ...but SET ROLE still does not, because SET was never granted.
      await expect(migrator.query("SET ROLE partner_credit_lifecycle_definer")).rejects.toMatchObject({
        code: "42501",
      });
      // And the guard still passes, because the holder is the database owner.
      expect(await partnerCreditDefinerModelViolations(queryFn(admin))).toEqual([]);

      // Revocation restores the pre-repair state exactly.
      await migrator.query(
        `REVOKE INHERIT OPTION FOR partner_credit_lifecycle_definer FROM ${MIGRATOR_ROLE}`
      );
      const after = await admin.query<{ inherit_option: boolean }>(
        `SELECT m.inherit_option FROM pg_auth_members m
           JOIN pg_roles role ON role.oid=m.roleid
           JOIN pg_roles member ON member.oid=m.member
          WHERE role.rolname='partner_credit_lifecycle_definer' AND member.rolname=$1`,
        [MIGRATOR_ROLE]
      );
      expect(after.rows.some((r) => r.inherit_option === true)).toBe(false);
    } finally {
      await migrator.end();
    }
  });
});

describe("Realistic non-superuser migrator — 0042 per-card settlement", () => {
  let cluster: DisposablePostgres17;
  let admin: pg.Client;

  beforeAll(async () => {
    cluster = await startPostgres17("realistic-migrator-percard");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables(admin);
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);
  }, MIGRATION_TIMEOUT);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("applies 0042 as the realistic migrator after the role repair", async () => {
    const fn = await admin.query<{ owner: string; prosecdef: boolean; src: string }>(
      `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, prosrc AS src
         FROM pg_proc WHERE proname='partner_connector_release_submission_credit'`
    );
    expect(fn.rows[0].owner).toBe("partner_credit_lifecycle_definer");
    expect(fn.rows[0].prosecdef).toBe(true);
    // The per-card body is in place, not 0041's single-reservation body.
    expect(fn.rows[0].src).toContain("per_card_settlement");
    expect(fn.rows[0].src).not.toContain("LIMIT 2");
  });

  it("0042 is idempotent — applying it twice succeeds", async () => {
    const migrator = new pg.Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      const sql = (await import("node:fs")).readFileSync(
        (await import("node:path")).join(process.cwd(), "migrations", "0042_partner_per_card_credit_settlement.sql"),
        "utf8"
      );
      await expect(migrator.query(sql)).resolves.toBeTruthy();
    } finally {
      await migrator.end();
    }
  });

  it("the definer can read card rows (needed to reconcile credits to card units)", async () => {
    const granted = await admin.query<{ ok: boolean }>(
      `SELECT has_table_privilege('partner_credit_lifecycle_definer','partner_submission_cards','SELECT') AS ok`
    );
    expect(granted.rows[0].ok).toBe(true);
  });

  it("0042 grants the definer NO write access to cards, wallets or ledger", async () => {
    for (const [table, priv] of [
      ["partner_submission_cards", "UPDATE"],
      ["partner_submission_cards", "INSERT"],
      ["partner_wallets", "SELECT"],
      ["partner_credit_ledger", "SELECT"],
    ] as const) {
      const r = await admin.query<{ ok: boolean }>(
        `SELECT has_table_privilege('partner_credit_lifecycle_definer',$1,$2) AS ok`,
        [table, priv]
      );
      expect(`${table}.${priv}=${r.rows[0].ok}`).toBe(`${table}.${priv}=false`);
    }
  });

  it("ROLLBACK: 0042 rolls back cleanly and restores the single-reservation body", async () => {
    const migrator = new pg.Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const sql = fs.readFileSync(
        path.join(process.cwd(), "migrations", "rollback-0042-partner-per-card-credit-settlement.sql"),
        "utf8"
      );
      await migrator.query(sql);
      const fn = await admin.query<{ src: string; owner: string }>(
        `SELECT prosrc AS src, pg_get_userbyid(proowner) AS owner
           FROM pg_proc WHERE proname='partner_connector_release_submission_credit'`
      );
      expect(fn.rows[0].src).not.toContain("per_card_settlement");
      expect(fn.rows[0].owner).toBe("partner_credit_lifecycle_definer");
      // Re-applying 0042 after its own rollback must work (ordering is reversible).
      const forward = fs.readFileSync(
        path.join(process.cwd(), "migrations", "0042_partner_per_card_credit_settlement.sql"),
        "utf8"
      );
      await expect(migrator.query(forward)).resolves.toBeTruthy();
    } finally {
      await migrator.end();
    }
  }, 60_000);
});
