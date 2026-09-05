/** Test-only bootstrap for a newly owned empty Partner browser database. */
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
} from "../../tests/helpers/partner-realistic-db";

export const PARTNER_BROWSER_DB_PREFIX = "mintvault_partner_browser_runtime_";
export const PARTNER_BROWSER_TENANT = "a1111111-1111-4111-8111-111111111111";
export const PARTNER_BROWSER_LOCATION = "a2222222-2222-4222-8222-222222222222";
export const PARTNER_BROWSER_IDENTITIES = Object.freeze([
  { id: "a3333333-3333-4333-8333-333333333333", email: "owner@partner-browser.example.test", role: "PARTNER_OWNER" },
  {
    id: "a4444444-4444-4444-8444-444444444444",
    email: "manager@partner-browser.example.test",
    role: "PARTNER_MANAGER",
  },
  {
    id: "a5555555-5555-4555-8555-555555555555",
    email: "finance@partner-browser.example.test",
    role: "PARTNER_FINANCE_VIEWER",
  },
]);

export function assertPartnerBrowserDatabase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname).slice(1);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.search ||
    url.hash ||
    !database.startsWith(PARTNER_BROWSER_DB_PREFIX) ||
    !/^[a-z0-9_]{1,63}$/.test(database)
  )
    throw new Error("Partner browser fixture requires its dedicated prefixed loopback database");
  return url;
}

export async function seedPartnerBrowserDatabase(raw: string, password: string) {
  const url = assertPartnerBrowserDatabase(raw);
  if (password.length < 16) throw new Error("Synthetic Partner browser password is required");
  const admin = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'");
    if (existing.rows[0].n !== 0) throw new Error("Partner browser fixture refuses a non-empty database");
    await provisionRealisticRoles(admin);
    // Prerequisites of the real Partner migration chain, as in the existing
    // portal mount fixture. No Admin test tables are adopted or dropped.
    await admin.query(`
      CREATE TABLE users (id varchar PRIMARY KEY, email varchar UNIQUE, role varchar(20) NOT NULL DEFAULT 'customer');
      CREATE TABLE submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE);
      CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL);
      CREATE TABLE audit_log (id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL,
        action text NOT NULL, admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamp NOT NULL DEFAULT now());
      ALTER TABLE users OWNER TO pn_migrator;
      ALTER TABLE submissions OWNER TO pn_migrator;
      ALTER TABLE submission_items OWNER TO pn_migrator;
      ALTER TABLE audit_log OWNER TO pn_migrator;
    `);
    await applyMigrationsRealistic(
      admin,
      url.toString(),
      [
        ...PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
        "0045_partner_stations",
        // Cumulative catalogue, as in partner-rbac-migration.test.ts. The existing
        // realistic helper supplies the application-scope prerequisite for 0073.
        "0073_lineage_convergence",
        "0085_partner_scanner_operator_role",
        "0092_partner_station_calibrate_permission",
        "0098_scanner_operator_credit_view",
        // Numeric filename order is essential: 0083 must grant its purchase
        // capability AFTER 0034 creates the Owner role, never before it exists.
      ].sort()
    );
    const runtimeRole = `partner_browser_${randomBytes(10).toString("hex")}`;
    const runtimePassword = randomBytes(24).toString("hex");
    // Both strings are generated hex/identifier literals, never browser input.
    await admin.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    await admin.query(`GRANT partner_runtime TO ${runtimeRole}`);
    const passwordHash = await bcrypt.hash(password, 12);
    await admin.query("BEGIN");
    await admin.query(
      "INSERT INTO partner_organisations (id,public_ref,legal_name,status) VALUES ($1,'browser-shop','Synthetic Browser Shop','ACTIVE')",
      [PARTNER_BROWSER_TENANT]
    );
    await admin.query(
      "INSERT INTO partner_locations (id,public_ref,tenant_id,partner_id,name,status,address_line1,address_city,address_postcode,address_country) VALUES ($1,'browser-location',$2,$2,'Synthetic Browser Location','ACTIVE','1 Test Street','Test Town','TE1 1ST','GB')",
      [PARTNER_BROWSER_LOCATION, PARTNER_BROWSER_TENANT]
    );
    for (const identity of PARTNER_BROWSER_IDENTITIES) {
      await admin.query(
        "INSERT INTO partner_users (id,public_ref,tenant_id,partner_id,email,password_hash,password_set_at,status,mfa_required) VALUES ($1,$2,$3,$3,$4,$5,now(),'ACTIVE',false)",
        [identity.id, identity.role, PARTNER_BROWSER_TENANT, identity.email, passwordHash]
      );
      const role = await admin.query(
        "INSERT INTO partner_user_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM partner_roles WHERE code=$3 RETURNING role_id",
        [PARTNER_BROWSER_TENANT, identity.id, identity.role]
      );
      if (role.rowCount !== 1) throw new Error("Migration-seeded Partner role is missing");
      await admin.query("INSERT INTO partner_user_locations (tenant_id,user_id,location_id) VALUES ($1,$2,$3)", [
        PARTNER_BROWSER_TENANT,
        identity.id,
        PARTNER_BROWSER_LOCATION,
      ]);
    }
    for (const flag of ["partner_portal_enabled", "partner_login_enabled"]) {
      await admin.query(
        "INSERT INTO partner_feature_flags (tenant_id,location_id,flag,enabled) VALUES (NULL,NULL,$1,true)",
        [flag]
      );
    }
    await admin.query("COMMIT");
    const runtimeUrl = new URL(url.toString());
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    const runtime = new Client({
      connectionString: runtimeUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await runtime.connect();
    try {
      const role = await runtime.query(
        "SELECT rolsuper,rolbypassrls,pg_has_role(current_user,'partner_runtime','MEMBER') AS member FROM pg_roles WHERE rolname=current_user"
      );
      if (role.rowCount !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls || !role.rows[0].member)
        throw new Error("Browser runtime role is not restricted");
      const hidden = await runtime.query("SELECT count(*)::int n FROM partner_organisations");
      if (hidden.rows[0].n !== 0) throw new Error("Unscoped browser runtime can see tenant data");
    } finally {
      await runtime.end();
    }
    return {
      runtimeUrl: runtimeUrl.toString(),
      identities: PARTNER_BROWSER_IDENTITIES,
      tenantId: PARTNER_BROWSER_TENANT,
    };
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await admin.end();
  }
}
