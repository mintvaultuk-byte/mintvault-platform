import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_FINAL_OWNER_ADMIN;
const isLocal = !!ADMIN && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const T = "ff00ff00-0032-0000-0000-000000000001";
const U1 = "ff00ff00-0032-0000-0000-0000000000a1";
const U2 = "ff00ff00-0032-0000-0000-0000000000a2";

(isLocal ? describe : describe.skip)("partner final owner DB invariant (PostgreSQL 17)", () => {
  let admin: Client;

  beforeAll(async () => {
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'fo','Final Owner Ltd','ACTIVE')",
      [T]
    );
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES
       ($1,'u1',$3,$3,'owner1@example.test','ACTIVE'),
       ($2,'u2',$3,$3,'owner2@example.test','ACTIVE')`,
      [U1, U2, T]
    );
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id, user_id, role_id)
       SELECT $1, u, r.id FROM partner_roles r, (VALUES ($2::uuid),($3::uuid)) AS v(u)
        WHERE r.code='PARTNER_OWNER'`,
      [T, U1, U2]
    );
  }, 60_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
  });

  it("allows one owner to be suspended but rejects raw SQL that removes the final active owner", async () => {
    await admin.query("UPDATE partner_users SET status='SUSPENDED' WHERE id=$1", [U1]);
    await expect(admin.query("UPDATE partner_users SET status='SUSPENDED' WHERE id=$1", [U2])).rejects.toThrow(
      /partner_final_owner_required/
    );
    const owners = await admin.query<{ n: number }>(
      `SELECT count(*)::int n FROM partner_users u
       JOIN partner_user_roles ur ON ur.user_id=u.id
       JOIN partner_roles r ON r.id=ur.role_id
       WHERE u.tenant_id=$1 AND u.status='ACTIVE' AND r.code='PARTNER_OWNER'`,
      [T]
    );
    expect(owners.rows[0].n).toBe(1);
  });

  it("rejects final owner role deletion but permits it once the partner is revoked", async () => {
    await expect(admin.query("DELETE FROM partner_user_roles WHERE user_id=$1", [U2])).rejects.toThrow(
      /partner_final_owner_required/
    );
    await admin.query("UPDATE partner_organisations SET status='REVOKED' WHERE id=$1", [T]);
    await admin.query("DELETE FROM partner_user_roles WHERE user_id=$1", [U2]);
    expect((await admin.query("SELECT count(*)::int n FROM partner_user_roles WHERE user_id=$1", [U2])).rows[0].n).toBe(
      0
    );
  });
});
