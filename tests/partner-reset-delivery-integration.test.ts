/**
 * WP-1.5 P2 — partner password-reset delivery, end to end through the PRODUCTION-mounted public
 * routes on a disposable PostgreSQL 17 database.
 *
 * No real email is ever sent: a capturing delivery adapter stands in at the adapter seam, and the
 * Resend-backed default is never reached (RESEND_API_KEY is cleared for the whole file).
 *
 * Gated on the same wired env pair as tests/partner-public-routes-integration.test.ts
 * (PARTNER_PUBLIC_RT_ADMIN / PARTNER_PUBLIC_RT_RUNTIME) but provisions its OWN database so it never
 * shares state with that suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
} from "./helpers/partner-realistic-db";

const SEED_ADMIN = process.env.PARTNER_PUBLIC_RT_ADMIN;
const SEED_RUNTIME = process.env.PARTNER_PUBLIC_RT_RUNTIME;
const isLocal = !!SEED_ADMIN && !!SEED_RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(SEED_ADMIN);

const OWN_DB = "mintvault_partner_reset";
const APP_ROLE = "partner_reset_app_test";
const APP_PASSWORD = "synthetic";

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const A = "bb31bb31-0000-0000-0000-000000000001";
const USER = "bb31bb31-0000-0000-0000-0000000000a1";
const USER_EMAIL = "reset-user@example.test";
const UNKNOWN_EMAIL = "nobody-here@example.test";
const START_PASSWORD = "initial-partner-password-1";
const NEW_PASSWORD = "rotated-partner-password-1";

(isLocal ? describe : describe.skip)("Partner password-reset delivery (production routes, real DB)", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";
  let delivered: Array<{ email: string; token: string }> = [];
  let setResetDeliveryAdapter: (a: ((e: string, t: string) => Promise<void>) | null) => void;
  // R5: every process.env key this suite overwrites, restored in afterAll.
  const OVERWRITTEN_ENV = [
    "RESEND_API_KEY",
    "MINTVAULT_DATABASE_URL",
    "PARTNER_ADMIN_DATABASE_URL",
    "PARTNER_DATABASE_URL",
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedEnv = Object.fromEntries(OVERWRITTEN_ENV.map((k) => [k, process.env[k]]));
    // Guarantee the Resend-backed default can never fire from this suite.
    delete process.env.RESEND_API_KEY;

    // --- provision our OWN database off the wired cluster ---
    // Connect to the maintenance DB so we never depend on another suite's database existing.
    const bootstrap = new Client({ connectionString: withDb(SEED_ADMIN!, "postgres") });
    await bootstrap.connect();
    await bootstrap.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [OWN_DB]
    );
    await bootstrap.query(`DROP DATABASE IF EXISTS "${OWN_DB}"`);
    await bootstrap.query(`CREATE DATABASE "${OWN_DB}"`);
    await bootstrap.end();

    const ADMIN_URL = withDb(SEED_ADMIN!, OWN_DB);
    const RUNTIME_URL = (() => {
      const u = new URL(withDb(SEED_RUNTIME!, OWN_DB));
      u.username = APP_ROLE;
      u.password = APP_PASSWORD;
      return u.toString();
    })();

    process.env.MINTVAULT_DATABASE_URL = ADMIN_URL;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_URL;
    process.env.PARTNER_DATABASE_URL = RUNTIME_URL;

    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
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
    await applyMigrationsRealistic(admin, ADMIN_URL, PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT);

    await admin.query(
      `DO $$ BEGIN CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}';
       EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query(`GRANT partner_runtime TO ${APP_ROLE}`);

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    const { hashPassword } = await import("../server/partner/auth");
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'resetA','Reset A','ACTIVE')",
      [A]
    );
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status, password_hash)
       VALUES ($1,'resetUser',$2,$2,$3,'ACTIVE',$4)`,
      [USER, A, USER_EMAIL, await hashPassword(START_PASSWORD)]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [A, USER]
    );
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true)"
    );

    const delivery = await import("../server/partner/delivery");
    setResetDeliveryAdapter = delivery.setResetDeliveryAdapter;
    setResetDeliveryAdapter(async (email, token) => {
      delivered.push({ email, token });
    });

    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const app = express();
    app.use(express.json());
    registerPartnerPublicRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    setResetDeliveryAdapter?.(null);
    for (const k of OVERWRITTEN_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  }, 60_000);

  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/partner${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /**
   * Delivery is dispatched WITHOUT await in the request path (the timing-oracle fix), so the
   * response can land before the adapter runs. Poll rather than assume ordering.
   */
  async function deliveredCount(n: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (delivered.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(delivered).toHaveLength(n);
  }

  it("delivers a token out of band, resets the password once, and refuses the replay", async () => {
    delivered = [];
    const requested = await post("/auth/password-reset/request", { email: USER_EMAIL });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ ok: true });

    // Token reached the delivery seam, and NEVER the HTTP response.
    await deliveredCount(1);
    expect(delivered[0].email).toBe(USER_EMAIL);
    const token = delivered[0].token;
    expect(token.length).toBeGreaterThan(20);

    // Stored only as a hash.
    const stored = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_password_reset_tokens WHERE token_hash = encode(sha256($1::bytea),'hex')",
      [token]
    );
    expect(stored.rows[0].n).toBe("1");

    const consumed = await post("/auth/password-reset/consume", { token, newPassword: NEW_PASSWORD });
    expect(consumed.status).toBe(200);
    expect(await consumed.json()).toEqual({ ok: true });

    // The new password actually works through the production login route.
    const login = await post("/auth/login", { email: USER_EMAIL, password: NEW_PASSWORD });
    expect(login.status).toBe(200);

    // Single use: the same token cannot be replayed.
    const replay = await post("/auth/password-reset/consume", {
      token,
      newPassword: "yet-another-password-1",
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ ok: false });
    const stillNew = await post("/auth/login", { email: USER_EMAIL, password: NEW_PASSWORD });
    expect(stillNew.status).toBe(200);
  }, 60_000);

  it("refuses an expired token (30-minute window)", async () => {
    delivered = [];
    const { RESET_TOKEN_MINUTES } = await import("../server/partner/auth");
    expect(RESET_TOKEN_MINUTES).toBe(30);

    const requested = await post("/auth/password-reset/request", { email: USER_EMAIL });
    expect(requested.status).toBe(200);
    await deliveredCount(1);
    const token = delivered[0].token;

    // Age the token past its window.
    const aged = await admin.query(
      `UPDATE partner_password_reset_tokens SET expires_at = now() - interval '1 minute'
        WHERE token_hash = encode(sha256($1::bytea),'hex')`,
      [token]
    );
    expect(aged.rowCount).toBe(1);

    const consumed = await post("/auth/password-reset/consume", {
      token,
      newPassword: "expired-attempt-password-1",
    });
    expect(consumed.status).toBe(400);
    const login = await post("/auth/login", { email: USER_EMAIL, password: "expired-attempt-password-1" });
    expect(login.status).not.toBe(200);
  }, 60_000);

  it("returns an identical response for unknown and existing accounts, and mints nothing for unknown", async () => {
    delivered = [];
    const before = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_password_reset_tokens"
    );

    const unknown = await post("/auth/password-reset/request", { email: UNKNOWN_EMAIL });
    const known = await post("/auth/password-reset/request", { email: USER_EMAIL });

    expect(unknown.status).toBe(known.status);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());

    // Exactly one new token — the known account's. Nothing for the unknown address.
    const after = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_password_reset_tokens"
    );
    expect(Number(after.rows[0].n) - Number(before.rows[0].n)).toBe(1);
    await deliveredCount(1);
    expect(delivered.map((d) => d.email)).toEqual([USER_EMAIL]);
  }, 60_000);

  it("stays fail-closed and still generic when no delivery adapter is registered", async () => {
    setResetDeliveryAdapter(null);
    delivered = [];
    const before = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_password_reset_tokens"
    );

    const { resetDeliveryConfigured } = await import("../server/partner/delivery");
    expect(resetDeliveryConfigured()).toBe(false);

    const res = await post("/auth/password-reset/request", { email: USER_EMAIL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // No token minted at all — the route short-circuits before createPasswordResetToken.
    const after = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_password_reset_tokens"
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(delivered).toHaveLength(0);
  }, 60_000);

  // --- R2: rate-limit keying. These MUST run last — they deliberately exhaust the IP buckets. ---

  it("bounds reset REQUESTS per IP regardless of the email supplied (no fresh bucket per probe)", async () => {
    setResetDeliveryAdapter(null); // no delivery side effects while probing
    let sawThrottle = false;
    for (let i = 0; i < 20 && !sawThrottle; i++) {
      // A DIFFERENT address every time — under the old body-derived key each of these minted its
      // own bucket and this loop could never throttle.
      const res = await post("/auth/password-reset/request", { email: `probe-${i}@example.test` });
      if (res.status === 429) sawThrottle = true;
      else expect(res.status).toBe(200);
    }
    expect(sawThrottle).toBe(true);
  }, 60_000);

  it("bounds reset CONSUMES per IP regardless of any email field in the body", async () => {
    let sawThrottle = false;
    for (let i = 0; i < 20 && !sawThrottle; i++) {
      const res = await post("/auth/password-reset/consume", {
        email: `bucket-${i}@example.test`, // ignored by the route; must NOT create a new bucket
        token: `no-such-token-${i}`,
        newPassword: "irrelevant-password-1",
      });
      if (res.status === 429) sawThrottle = true;
      else expect(res.status).toBe(400);
    }
    expect(sawThrottle).toBe(true);
  }, 60_000);
});
