/**
 * Disposable, local-only runtime for the Command Centre rendered audit.
 *
 * This is intentionally a test runner, not an application startup mode. It owns
 * a uniquely named loopback PostgreSQL database, initialises synthetic records,
 * then starts the unmodified MintVault server with NODE_ENV=test. It refuses any
 * database URL that is not loopback and does not carry the harness name prefix.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import bcrypt from "bcryptjs";

export const COMMAND_CENTRE_RUNTIME_AUDIT_ENV = "MINTVAULT_COMMAND_CENTRE_RUNTIME_AUDIT";
export const COMMAND_CENTRE_RUNTIME_DB_PREFIX = "mintvault_command_centre_runtime_";
export const RUNTIME_ADMIN_EMAIL = "mintvaultuk@gmail.com";
export const RUNTIME_ADMIN_PASSWORD_ENV = "MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PASSWORD";
export const RUNTIME_ADMIN_PIN_ENV = "MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PIN";
export const COMMAND_CENTRE_PILOT_FLAG = "super_admin_command_centre_enabled";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function runtimeDatabaseName(value: string): string {
  const name = value.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  if (!name.startsWith(COMMAND_CENTRE_RUNTIME_DB_PREFIX)) {
    throw new Error("Command Centre runtime harness database name is not allowlisted.");
  }
  return name;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Unsafe SQL identifier.");
  return `"${value}"`;
}

/** Fail closed before either bootstrapping or starting the application. */
export function assertDisposableRuntimeDatabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Command Centre runtime harness requires a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Command Centre runtime harness requires PostgreSQL.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Command Centre runtime harness refuses non-loopback databases.");
  }
  runtimeDatabaseName(decodeURIComponent(url.pathname).replace(/^\//, ""));
  return url;
}

function localRole(): string {
  const role = process.env.USER ?? "";
  if (!/^[a-z_][a-z0-9_]*$/i.test(role)) throw new Error("Runtime harness requires a safe local PostgreSQL role.");
  return role;
}

function databaseUrl(role: string, database: string): string {
  const url = new URL("postgresql://127.0.0.1:5432/postgres");
  url.username = role;
  url.pathname = `/${database}`;
  return url.toString();
}

/** Synthetic credentials are deliberately supplied only to the disposable
 * process. They are not committed, logged, or written by this harness. */
export function requireRuntimeCredential(environmentName: string): string {
  const value = process.env[environmentName];
  if (!value || value.length < 8) {
    throw new Error(`${environmentName} is required for the disposable runtime and must not be recorded.`);
  }
  return value;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === "string") throw new Error("Unable to reserve a loopback runtime port.");
  return address.port;
}

async function seedRuntimeDatabase(
  database: string,
  password: string,
  pin: string,
  commandCentreEnabled: boolean,
): Promise<void> {
  assertDisposableRuntimeDatabaseUrl(database);
  const client = new Client({ connectionString: database });
  await client.connect();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const pinHash = await bcrypt.hash(pin, 12);
    await client.query(`
      /* The fixture owns only the relations read by the rendered Command Centre
         and real admin login. It deliberately does not run Drizzle: the local
         PostgreSQL estate lacks pgvector, which the unrelated full schema needs. */
      CREATE TABLE users (
        id varchar PRIMARY KEY, email varchar UNIQUE, first_name varchar, last_name varchar,
        profile_image_url varchar, role varchar(20) NOT NULL DEFAULT 'customer', deleted_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        password_hash text, display_name text, email_verified boolean NOT NULL DEFAULT false,
        email_verified_at timestamp, last_login_at timestamp, last_login_ip text,
        failed_login_count integer NOT NULL DEFAULT 0, locked_until timestamp, last_failed_login_at timestamp,
        credential_version integer NOT NULL DEFAULT 1, admin_passphrase_hash text, pin_hash text,
        pin_set_at timestamp, pin_failed_count integer NOT NULL DEFAULT 0, pin_locked_until timestamp,
        public_name boolean NOT NULL DEFAULT false, can_grade boolean NOT NULL DEFAULT false,
        can_scan boolean NOT NULL DEFAULT false, can_print boolean NOT NULL DEFAULT false,
        can_edit_sets boolean NOT NULL DEFAULT false, review_rate integer NOT NULL DEFAULT 100
      );
      CREATE TABLE submissions (
        id serial PRIMARY KEY, user_id varchar NOT NULL, status varchar(30) NOT NULL DEFAULT 'draft',
        tracking_number text NOT NULL UNIQUE, card_count integer NOT NULL DEFAULT 0,
        payment_status varchar(20) NOT NULL DEFAULT 'unpaid', payment_amount numeric,
        payment_currency varchar(3), payment_timestamp timestamp, deleted_at timestamp,
        scan_status varchar(20) NOT NULL DEFAULT 'unassigned', received_at timestamp
      );
      /* These four relations support the unchanged Admin shell availability
         response. They are deliberately inert synthetic rows: the harness
         never invokes its mutation controls, but the Super Admin navigation
         must render exactly as it would after a successful protected check. */
      CREATE TABLE card_master (id serial PRIMARY KEY, is_deleted boolean NOT NULL DEFAULT false);
      CREATE TABLE card_sets (id serial PRIMARY KEY, is_deleted boolean NOT NULL DEFAULT false);
      CREATE TABLE cert_counter (id integer PRIMARY KEY, last_issued integer NOT NULL DEFAULT 0, updated_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE certificates (
        id serial PRIMARY KEY, certificate_number text NOT NULL UNIQUE, deleted_at timestamp,
        status varchar(30) NOT NULL DEFAULT 'active', grader_status varchar(30) NOT NULL DEFAULT 'unassigned', graded_at timestamp
      );
      CREATE TABLE transfer_verifications (
        id serial PRIMARY KEY, cert_id text NOT NULL, from_email text NOT NULL, to_email text NOT NULL,
        owner_token_hash text NOT NULL, owner_expires_at timestamp NOT NULL, disputed_at timestamp,
        finalised_at timestamp, cancelled_at timestamp
      );
      CREATE TABLE audit_log (id serial PRIMARY KEY, entity_type text, entity_id text, action text, admin_user text, details jsonb, created_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE pin_attempts (id serial PRIMARY KEY, email text, success boolean, reason text, ip_hash text, attempted_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE login_attempts (id serial PRIMARY KEY, email text, ip text, success boolean, user_agent text, created_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS session (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
      CREATE INDEX IF NOT EXISTS session_expire_idx ON session(expire);
      CREATE TABLE IF NOT EXISTS print_batches (id serial PRIMARY KEY, status text NOT NULL, created_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS partner_organisations (id text PRIMARY KEY, public_ref text NOT NULL DEFAULT 'CC-TEST', legal_name text NOT NULL DEFAULT 'Synthetic Partner', trading_name text, status text NOT NULL, created_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS partner_profiles (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_locations (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_users (id text PRIMARY KEY, status text NOT NULL DEFAULT 'ACTIVE');
      CREATE TABLE IF NOT EXISTS partner_user_roles (id serial PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_roles (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_sessions (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_submissions (id text PRIMARY KEY, status text NOT NULL);
      CREATE TABLE IF NOT EXISTS partner_connector_records (id text PRIMARY KEY, state text NOT NULL, updated_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS partner_connector_admin_actions (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_security_events (id text PRIMARY KEY, severity text NOT NULL, created_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS partner_emergency_controls (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_audit_events (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_management_audit (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partner_stations (id text PRIMARY KEY, status text NOT NULL);
      CREATE TABLE IF NOT EXISTS partner_feature_flags (
        id text PRIMARY KEY, tenant_id text, location_id text, flag text NOT NULL,
        enabled boolean NOT NULL DEFAULT false, created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS command_centre_runtime_audit_marker (id boolean PRIMARY KEY DEFAULT true CHECK (id), created_at timestamp NOT NULL DEFAULT now());
    `);
    await client.query(
      `INSERT INTO users (id, email, role, admin_passphrase_hash, pin_hash, credential_version)
       VALUES ($1, $2, 'admin', $3, $4, 1)`,
      ["cc-runtime-super-admin", RUNTIME_ADMIN_EMAIL, passwordHash, pinHash],
    );
    await client.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)");
    await client.query(
      `INSERT INTO submissions (user_id, status, tracking_number, card_count, payment_status, payment_amount, payment_currency, payment_timestamp, scan_status, received_at)
       VALUES
         ('cc-runtime-super-admin', 'received', 'CC-RUNTIME-RECEIVED', 1, 'paid', 25, 'GBP', now(), 'unassigned', now() - interval '15 minutes'),
         ('cc-runtime-super-admin', 'completed', 'CC-RUNTIME-COMPLETED', 1, 'paid', 25, 'GBP', now(), 'assigned', now() - interval '1 hour')`,
    );
    await client.query(
      `INSERT INTO certificates (certificate_number, grader_status, graded_at)
       VALUES ('CC-RUNTIME-REVIEW', 'pending_review', now() - interval '10 minutes'),
              ('CC-RUNTIME-GRADING', 'unassigned', now() - interval '5 minutes')`,
    );
    await client.query("INSERT INTO print_batches (status, created_at) VALUES ('failed', now() - interval '20 minutes')");
    await client.query(
      `INSERT INTO transfer_verifications (cert_id, from_email, to_email, owner_token_hash, owner_expires_at, disputed_at)
       VALUES ('CC-RUNTIME-TRANSFER', 'from@example.test', 'to@example.test', 'synthetic-token', now() + interval '1 day', now() - interval '30 minutes')`,
    );
    await client.query(
      `INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ('cc-runtime-partner', 'CC-TEST-1', 'Synthetic Partner', 'ACTIVE');
       INSERT INTO partner_users (id, status) VALUES ('cc-runtime-user', 'ACTIVE');
       INSERT INTO partner_submissions (id, status) VALUES ('cc-runtime-partner-submission', 'queued');
       INSERT INTO partner_connector_records (id, state, updated_at) VALUES ('cc-runtime-connector', 'manual_review', now() - interval '25 minutes');
      INSERT INTO partner_security_events (id, severity, created_at) VALUES ('cc-runtime-security', 'high', now() - interval '5 minutes');
      INSERT INTO partner_stations (id, status) VALUES ('cc-runtime-station', 'PENDING');
      INSERT INTO command_centre_runtime_audit_marker DEFAULT VALUES;`,
    );
    await client.query(
      `INSERT INTO partner_feature_flags (id, tenant_id, location_id, flag, enabled)
       VALUES ('cc-runtime-command-centre-flag', NULL, NULL, $1, $2)`,
      [COMMAND_CENTRE_PILOT_FLAG, commandCentreEnabled],
    );
  } finally {
    await client.end();
  }
}

async function waitForHealth(port: number, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Test runtime exited before it became healthy.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) return;
    } catch {
      // The actual app is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Command Centre test runtime.");
}

async function dropRuntimeDatabase(maintenanceUrl: string, database: string): Promise<void> {
  runtimeDatabaseName(database);
  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
  } finally {
    await admin.end();
  }
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/mv\.sid=[^;]+/);
  if (!match) throw new Error("Command Centre runtime login did not return an admin session cookie.");
  return match[0];
}

async function verifyCommandCentreRuntime(
  port: number,
  commandCentreEnabled: boolean,
  password: string,
  pin: string,
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (!commandCentreEnabled) {
    const disabled = await fetch(`${baseUrl}/api/admin/command/dashboard`);
    if (disabled.status !== 404) {
      throw new Error(`Disabled Command Centre runtime returned ${disabled.status}, expected 404.`);
    }
    return;
  }

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (login.status !== 200) throw new Error(`Synthetic Super Admin password step returned ${login.status}.`);
  const pendingCookie = sessionCookie(login);
  const pinResponse = await fetch(`${baseUrl}/api/admin/pin`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: pendingCookie },
    body: JSON.stringify({ pin }),
  });
  if (pinResponse.status !== 200) throw new Error(`Synthetic Super Admin PIN step returned ${pinResponse.status}.`);
  const authenticatedCookie = sessionCookie(pinResponse);
  const dashboard = await fetch(`${baseUrl}/api/admin/command/dashboard`, {
    headers: { cookie: authenticatedCookie },
  });
  if (dashboard.status !== 200) {
    throw new Error(`Enabled Command Centre runtime returned ${dashboard.status}, expected 200 after Super Admin login.`);
  }
}

async function main(): Promise<void> {
  if (process.env[COMMAND_CENTRE_RUNTIME_AUDIT_ENV] !== "1") {
    throw new Error(`${COMMAND_CENTRE_RUNTIME_AUDIT_ENV}=1 is required; this harness never runs implicitly.`);
  }
  const runtimeAdminPassword = requireRuntimeCredential(RUNTIME_ADMIN_PASSWORD_ENV);
  const runtimeAdminPin = requireRuntimeCredential(RUNTIME_ADMIN_PIN_ENV);
  const role = localRole();
  // This is an audit-only process argument, not a product feature switch. It
  // lets the rendered audit prove the existing server-side kill switch with the
  // same local-only database safeguards as the enabled runtime.
  const commandCentreEnabled = !process.argv.includes("--feature-off");
  const database = runtimeDatabaseName(`${COMMAND_CENTRE_RUNTIME_DB_PREFIX}${process.pid}_${randomUUID().slice(0, 8)}`);
  const maintenanceUrl = databaseUrl(role, "postgres");
  const runtimeUrl = databaseUrl(role, database);
  assertDisposableRuntimeDatabaseUrl(runtimeUrl);

  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
  } finally {
    await admin.end();
  }

  let app: ChildProcess | undefined;
  const stop = async (exitCode: number) => {
    if (app && app.exitCode === null) {
      app.kill("SIGINT");
      await Promise.race([once(app, "exit"), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    await dropRuntimeDatabase(maintenanceUrl, database);
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));

  try {
    await seedRuntimeDatabase(runtimeUrl, runtimeAdminPassword, runtimeAdminPin, commandCentreEnabled);
    const port = await unusedPort();
    const { SUPER_ADMIN_COMMAND_CENTRE_ENABLED: _legacyCommandCentreFlag, ...parentEnvironment } = process.env;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...parentEnvironment,
      NODE_ENV: "test",
      PORT: String(port),
      APP_URL: `http://localhost:${port}`,
      MINTVAULT_DATABASE_URL: runtimeUrl,
      PARTNER_ADMIN_DATABASE_URL: runtimeUrl,
      PARTNER_DATABASE_URL: runtimeUrl,
      PARTNER_CONNECTOR_DATABASE_URL: runtimeUrl,
      SUPER_ADMIN_EMAILS: RUNTIME_ADMIN_EMAIL,
      SESSION_SECRET: "command-centre-runtime-test-session-secret",
      SIGNED_URL_SECRET: "command-centre-runtime-test-signed-url-secret",
      ADMIN_PASSWORD: runtimeAdminPassword,
      ADMIN_PIN: runtimeAdminPin,
      RESEND_API_KEY: "",
      R2_ENDPOINT: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
      R2_BUCKET_NAME: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_PUBLISHABLE_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
    };
    app = spawn("./node_modules/.bin/tsx", ["server/index.ts"], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    await waitForHealth(port, app);
    await verifyCommandCentreRuntime(port, commandCentreEnabled, runtimeAdminPassword, runtimeAdminPin);
    console.log(`COMMAND_CENTRE_RUNTIME_READY=http://localhost:${port}`);
    console.log(`COMMAND_CENTRE_RUNTIME_COMMAND_CENTRE_ENABLED=${commandCentreEnabled}`);
    console.log("COMMAND_CENTRE_RUNTIME_AUTH=synthetic two-step Super Admin fixture (credentials intentionally not logged)");
  } catch (error) {
    console.error(`[command-centre-runtime-harness] ${(error as Error).message}`);
    await stop(1);
  }
}

if (process.argv[1]?.endsWith("command-centre-runtime-harness.ts")) {
  void main();
}
