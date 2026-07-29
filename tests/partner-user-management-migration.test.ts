import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_G5,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_USER_MGMT_MIGRATION_ADMIN;
const isLocal = !!ADMIN_DB && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN_DB);

const A = "aaaa1111-0031-0000-0000-000000000001";
const B = "bbbb2222-0031-0000-0000-000000000002";

let admin: Client;

function sql(name: string): string {
  return readFileSync(join(process.cwd(), "migrations", name), "utf8");
}

(isLocal ? describe : describe.skip)("0031 partner user management migration lifecycle (PostgreSQL 17)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
    await admin.query(`CREATE TABLE IF NOT EXISTS users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar, last_name varchar,
      profile_image_url varchar, role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), password_hash text,
      display_name text, email_verified boolean NOT NULL DEFAULT false, email_verified_at timestamp, last_login_at timestamp,
      last_login_ip text, failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp, last_failed_login_at timestamp,
      credential_version integer NOT NULL DEFAULT 1, admin_passphrase_hash text, pin_hash text, pin_set_at timestamp,
      pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp, public_name boolean NOT NULL DEFAULT false,
      can_grade boolean NOT NULL DEFAULT false, can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
      can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100)`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_G5);
  }, 60_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
  });

  it("applies, repeats, rolls back with zero residue, and reapplies with RLS/grants intact", async () => {
    const forward = sql("0031_partner_user_management.sql");
    const rollback = sql("rollback-0031-partner-user-management.sql");
    await admin.query(forward);
    await admin.query(forward);

    expect((await admin.query("SELECT to_regclass('public.partner_invitations') AS reg")).rows[0].reg).toBe(
      "partner_invitations"
    );
    for (const col of ["first_name", "last_name"]) {
      expect(
        (
          await admin.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name='partner_users' AND column_name=$1",
            [col]
          )
        ).rowCount
      ).toBe(1);
    }
    expect(
      (
        await admin.query(
          "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='partner_invitations'::regclass"
        )
      ).rows[0]
    ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM information_schema.table_privileges WHERE table_name='partner_invitations' AND grantee='PUBLIC'"
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT privilege_type FROM information_schema.table_privileges WHERE table_name='partner_invitations' AND grantee='partner_runtime' ORDER BY privilege_type"
        )
      ).rows.map((r) => r.privilege_type)
    ).toEqual(["INSERT", "SELECT", "UPDATE"]);

    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'umA','A','ACTIVE'),($2,'umB','B','ACTIVE')",
      [A, B]
    );
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES (gen_random_uuid(),'uA',$1,$1,'a@example.test','INVITED'),(gen_random_uuid(),'uB',$2,$2,'b@example.test','INVITED')",
      [A, B]
    );
    await admin.query(
      "INSERT INTO partner_invitations (tenant_id, user_id, email, role_code, token_hash, expires_at) SELECT tenant_id, id, email, 'PARTNER_OWNER', encode(sha256(email::bytea),'hex'), now() + interval '1 day' FROM partner_users"
    );
    await admin.query("SET ROLE partner_runtime");
    try {
      expect((await admin.query("SELECT count(*)::int n FROM partner_invitations")).rows[0].n).toBe(0);
      await admin.query("SELECT set_config('app.tenant_id', $1, false)", [A]);
      expect((await admin.query("SELECT count(*)::int n FROM partner_invitations")).rows[0].n).toBe(1);
      expect((await admin.query("SELECT email FROM partner_invitations")).rows[0].email).toBe("a@example.test");
    } finally {
      await admin.query("RESET ROLE");
    }

    await admin.query("DELETE FROM partner_invitations");
    await admin.query("DELETE FROM partner_users");
    await admin.query("DELETE FROM partner_organisations");
    await admin.query(rollback);
    expect((await admin.query("SELECT to_regclass('public.partner_invitations') AS reg")).rows[0].reg).toBeNull();
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM information_schema.columns WHERE table_name='partner_users' AND column_name IN ('first_name','last_name')"
        )
      ).rows[0].n
    ).toBe(0);

    await admin.query(forward);
    expect((await admin.query("SELECT to_regclass('public.partner_invitations') AS reg")).rows[0].reg).toBe(
      "partner_invitations"
    );
  });
});
