/** Local-only browser proof fixture. Run with SUPPLY_BROWSER_DATABASE_URL set to a disposable
 * loopback database. It deliberately uses the repository's realistic migration helpers rather
 * than a hand-written schema; all identities and credentials are synthetic. */
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyEveryMigrationRealistic,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  migratorUrlFrom,
  provisionRealisticRoles,
} from "../../../../tests/helpers/partner-realistic-db";

const url = process.env.SUPPLY_BROWSER_DATABASE_URL;
if (!url) throw new Error("SUPPLY_BROWSER_DATABASE_URL is required for this local-only proof fixture.");

async function main(): Promise<void> {
  const [adminPassphraseHash, adminPinHash, partnerPasswordHash] = await Promise.all([
    bcrypt.hash("MintVaultLocalAdmin!2026", 12),
    bcrypt.hash("682947", 12),
    bcrypt.hash("MintVaultLocalPartner!2026", 12),
  ]);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    await provisionRealisticRoles(admin);
    await createMintvaultCertificatesTable(admin);
    await admin.query(`CREATE TABLE users (
      id varchar primary key default gen_random_uuid(), email varchar unique, first_name varchar, last_name varchar,
      profile_image_url varchar, role varchar(20) not null default 'customer', deleted_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), password_hash text,
      display_name text, email_verified boolean not null default false, email_verified_at timestamptz, last_login_at timestamptz,
      last_login_ip text, failed_login_count integer not null default 0, locked_until timestamptz, last_failed_login_at timestamptz,
      credential_version integer not null default 1, admin_passphrase_hash text, pin_hash text, pin_set_at timestamptz,
      pin_failed_count integer not null default 0, pin_locked_until timestamptz, public_name boolean not null default false,
      can_grade boolean not null default false, can_scan boolean not null default false, can_print boolean not null default false,
      can_edit_sets boolean not null default false, review_rate integer not null default 100
    )`);
    await admin.query(`CREATE TABLE submissions (
      id serial primary key, user_id varchar, status varchar(30) not null default 'draft', tracking_number text unique,
      deleted_at timestamptz, grading_status varchar(30), assigned_grader_id varchar, scan_status varchar(30),
      scan_assigned_to varchar, shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
      return_tracking text, return_carrier text, return_service text, status_history jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now()
    )`);
    await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
    await createMintvaultLabelPrintsTable(admin);
    await admin.query(`CREATE TABLE audit_log (
      id serial primary key, entity_type text not null, entity_id text not null, action text not null,
      admin_user text, details jsonb, created_at timestamptz not null default now()
    )`);
    for (const table of ["users", "submissions", "submission_items", "label_prints", "audit_log", "certificates"]) {
      await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
    }
    const migrator = new Client({ connectionString: migratorUrlFrom(url) });
    await migrator.connect();
    try {
      await applyEveryMigrationRealistic(migrator);
    } finally {
      await migrator.end();
    }
    await admin.query(
      "CREATE TABLE session (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamptz NOT NULL)"
    );
    await admin.query("CREATE INDEX session_expire_idx ON session (expire)");
    await admin.query(
      `INSERT INTO users (id, email, role, admin_passphrase_hash, pin_hash, pin_set_at)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'mintvaultuk@gmail.com', 'admin', $1, $2, now())`,
      [adminPassphraseHash, adminPinHash]
    );
    await admin.query(`INSERT INTO partner_organisations (id, public_ref, legal_name, status)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'browser-supply-org', 'Browser Supply Shop Ltd', 'ACTIVE')`);
    await admin.query(`INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, address, status)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001', 'browser-supply-location',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'Browser Supply Shop', '10 Proof Street, Bristol, BS1 4AA', 'ACTIVE')`);
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002', 'browser-supply-owner',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'owner@browser-supply.test', $1, 'SUSPENDED')`,
      [partnerPasswordHash]
    );
    await admin.query(`INSERT INTO partner_user_locations (tenant_id, user_id, location_id)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001')`);
    await admin.query(`INSERT INTO partner_user_roles (tenant_id, user_id, role_id)
      SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002', id
        FROM partner_roles WHERE code='PARTNER_OWNER'`);
    // Activate only once its owner role exists so the database-level final-owner invariant is
    // exercised in the same way as a real invitation acceptance.
    await admin.query("UPDATE partner_users SET status='ACTIVE' WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002'");
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003', 'browser-supply-finance',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'finance@browser-supply.test', $1, 'SUSPENDED')`,
      [partnerPasswordHash]
    );
    await admin.query(`INSERT INTO partner_user_locations (tenant_id, user_id, location_id)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001')`);
    await admin.query(`INSERT INTO partner_user_roles (tenant_id, user_id, role_id)
      SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003', id
        FROM partner_roles WHERE code='PARTNER_FINANCE_VIEWER'`);
    await admin.query("UPDATE partner_users SET status='ACTIVE' WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003'");
    await admin.query(`INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES
      (NULL, 'partner_portal_enabled', true), (NULL, 'partner_login_enabled', true),
      (NULL, 'partner_emergency_stop', false)`);
    await admin.query(
      "UPDATE partner_supply_products SET active_price_pence=2000 WHERE code='holographic_printing_paper'"
    );
    // A paid, server-shaped local fixture lets the browser prove both Partner history and the
    // Super Admin operational transitions without contacting Stripe. Provider payment/refund
    // effects are proven separately by the real-PostgreSQL service contract test.
    await admin.query(`INSERT INTO partner_supply_orders
      (id, tenant_id, location_id, idempotency_key, status, delivery_address, gross_total_pence,
       tax_treatment, submitted_by_user_id, paid_at)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0011', 'PAID',
              '{"source":"approved_location","locationName":"Browser Supply Shop","address":"10 Proof Street, Bristol, BS1 4AA"}'::jsonb,
              7500, 'UNCONFIGURED', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002', now())`);
    await admin.query(`INSERT INTO partner_supply_order_items
      (tenant_id, order_id, product_code, product_name_snapshot, units_per_pack_snapshot, quantity,
       gross_unit_price_pence, gross_line_total_pence)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
              'plastic_mintvault_slab_box', 'Plastic MintVault slabs', 50, 1, 7500, 7500)`);
    await admin.query(`INSERT INTO partner_supply_payments
      (tenant_id, order_id, stripe_checkout_session_id, stripe_payment_intent_id, status,
       gross_total_pence, tax_treatment, paid_at)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
              'cs_browser_paid_1', 'pi_browser_paid_1', 'PAID', 7500, 'UNCONFIGURED', now())`);
    await admin.query(`INSERT INTO partner_supply_order_events
      (tenant_id, order_id, action, actor_type, actor_user_id, actor_email, details)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
              'stripe_payment_confirmed', 'stripe_webhook', NULL, NULL, '{"event_id":"evt_browser_paid_1"}'::jsonb)`);
    // Roles are PostgreSQL-cluster-wide while this fixture database is deliberately fresh per
    // browser run. Make the restricted local-only role reusable so a previous disposable proof
    // cannot prevent a later fresh database from bootstrapping.
    await admin.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supply_browser_runtime') THEN
          CREATE ROLE supply_browser_runtime LOGIN PASSWORD 'synthetic-browser-runtime' NOSUPERUSER NOBYPASSRLS INHERIT;
        END IF;
      END$$`);
    await admin.query("GRANT partner_runtime TO supply_browser_runtime");
  } finally {
    await admin.end();
  }
}

main().then(
  () => console.log("local browser database ready"),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
