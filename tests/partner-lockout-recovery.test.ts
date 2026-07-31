/**
 * P0-F — lockout recovery through the password-reset path.
 *
 * WHAT THIS PROVES, against real Express routes over real HTTP on a DISPOSABLE local PostgreSQL 17:
 *
 *   1. Five failed logins lock the account (unchanged behaviour — the control is NOT weakened).
 *   2. A locked user who completes a secure password reset can sign in again. Before the fix
 *      `consumePasswordResetToken` set only password_hash + credential_version, so `locked_until`
 *      and `failed_login_count` survived the reset and the account stayed locked with NO admin
 *      unlock route anywhere in the codebase — a permanent, unrecoverable lockout.
 *   3. Every security property of the reset token survives: 32 random bytes, only a SHA-256 hash at
 *      rest, 30-minute expiry, strictly single-use, tenant derived server-side FROM THE TOKEN, a
 *      generic always-{ok:true} request response, and the deliberately un-awaited delivery dispatch
 *      that removes the timing oracle.
 *   4. A SUSPENDED account no longer accumulates lockout counter state it can never clear, so
 *      reactivating a user does not hand them a locked account.
 *
 * Reproduce (host must be loopback; the database is dropped and recreated):
 *   PARTNER_LOCKOUT_RT_ADMIN=postgresql://postgres@127.0.0.1:55444/mv_lockout \
 *   PARTNER_LOCKOUT_RT_RUNTIME=postgresql://partner_app_test_lockout:synthetic@127.0.0.1:55444/mv_lockout \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-lockout-recovery.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_LOCKOUT_RT_ADMIN;
const RUNTIME = process.env.PARTNER_LOCKOUT_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const TENANT = "10c00000-0000-0000-0000-000000000001";
const VICTIM = "10c00000-0000-0000-0000-0000000000a1";
const VICTIM_EMAIL = "locked-out@example.test";
const OLD_PASSWORD = "original-password-abc";
const NEW_PASSWORD = "recovered-password-xyz";

const SUSPENDED = "10c00000-0000-0000-0000-0000000000a2";
const SUSPENDED_EMAIL = "suspended@example.test";
const SUSPENDED_PASSWORD = "suspended-password-abc";

/** Reset tokens captured from the delivery adapter, with the dispatch timing recorded. */
const delivered: { email: string; token: string; at: number }[] = [];
let deliveryGate: Promise<void> = Promise.resolve();

describe("P0-F lockout recovery coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_LOCKOUT_RT_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(true);
    }
    if (!isLocal) console.warn("[partner-lockout-recovery] skipped: PARTNER_LOCKOUT_RT_ADMIN not a loopback URL");
    expect(true).toBe(true);
  });
});

(isLocal ? describe : describe.skip)("P0-F partner lockout recovery via password reset", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* status is what matters */
    }
    return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") };
  }

  const login = (email: string, password: string) => post("/api/partner/auth/login", { email, password });

  async function userRow(id: string) {
    const { rows } = await admin.query<{
      failed_login_count: number;
      locked_until: string | null;
      credential_version: number;
      status: string;
    }>("SELECT failed_login_count, locked_until, credential_version, status FROM partner_users WHERE id=$1", [id]);
    return rows[0];
  }

  const isLocked = (r: { locked_until: string | null }) =>
    !!r.locked_until && new Date(r.locked_until).getTime() > Date.now();

  /**
   * Check a candidate password against the stored hash directly.
   *
   * Used where a test only needs to know WHICH password is now set, rather than to exercise the
   * login route again. partnerLoginLimiter deliberately allows only 10 attempts per account per 15
   * minutes, and that budget is a control this suite must not weaken or raise just to make itself
   * fit — so assertions that do not genuinely need the HTTP path verify at rest instead.
   */
  async function storedPasswordIs(id: string, candidate: string): Promise<boolean> {
    const { rows } = await admin.query<{ password_hash: string | null }>(
      "SELECT password_hash FROM partner_users WHERE id=$1",
      [id]
    );
    if (!rows[0]?.password_hash) return false;
    return bcrypt.compare(candidate, rows[0].password_hash);
  }

  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic, disposable DB only

    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
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
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_RBAC_SEED);
    await admin.query("DROP ROLE IF EXISTS partner_app_test_lockout").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_lockout LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_lockout");

    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'lockOrg','Lockout Ltd','ACTIVE')",
      [TENANT]
    );
    const pw = await bcrypt.hash(OLD_PASSWORD, 12);
    const spw = await bcrypt.hash(SUSPENDED_PASSWORD, 12);
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status) VALUES
         ($1,'lockVictim',$3,$3,$4,$5,'ACTIVE'),
         ($2,'lockSuspended',$3,$3,$6,$7,'SUSPENDED')`,
      [VICTIM, SUSPENDED, TENANT, VICTIM_EMAIL, pw, SUSPENDED_EMAIL, spw]
    );
    for (const uid of [VICTIM, SUSPENDED]) {
      await admin.query(
        "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
        [TENANT, uid]
      );
    }
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true)"
    );

    // Capture reset tokens instead of sending email. The gate lets a test hold delivery open so the
    // un-awaited dispatch (public-routes.ts) can be observed rather than assumed.
    const { setResetDeliveryAdapter } = await import("../server/partner/delivery");
    setResetDeliveryAdapter(async (email, token) => {
      await deliveryGate;
      delivered.push({ email, token, at: Date.now() });
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
    const { setResetDeliveryAdapter } = await import("../server/partner/delivery");
    setResetDeliveryAdapter(null);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  it("still locks the account after five failed logins (control NOT weakened)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(VICTIM_EMAIL, "wrong-password");
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "invalid credentials" });
    }
    const row = await userRow(VICTIM);
    expect(row.failed_login_count).toBeGreaterThanOrEqual(5);
    expect(isLocked(row)).toBe(true);
  });

  it("refuses the CORRECT password while locked, and the refusal stays generic", async () => {
    const res = await login(VICTIM_EMAIL, OLD_PASSWORD);
    expect(res.status).toBe(401);
    // Identical body to a wrong-password failure — "locked" is never disclosed.
    expect(res.json).toEqual({ error: "invalid credentials" });
    expect(res.setCookie).toBeNull();
  });

  // Regression for the self-extending lockout found by hostile review (Lane C). The locked branch
  // counted its OWN refusals, so `locked_until = now() + 15 min` was re-evaluated on every attempt
  // once the counter was already past the threshold. An unauthenticated attacker could therefore
  // hold a named partner account offline indefinitely at ~4 requests/hour — inside both login
  // limiters — and the victim's only exit (password reset) could be immediately undone.
  it("does NOT extend the lockout when a locked account is probed again", async () => {
    const before = await admin.query<{ locked_until: string; failed_login_count: number }>(
      "SELECT locked_until, failed_login_count FROM partner_users WHERE email=$1",
      [VICTIM_EMAIL]
    );
    expect(before.rows[0].locked_until).not.toBeNull();

    await login(VICTIM_EMAIL, "another-wrong-password");
    await login(VICTIM_EMAIL, OLD_PASSWORD);

    const after = await admin.query<{ locked_until: string; failed_login_count: number }>(
      "SELECT locked_until, failed_login_count FROM partner_users WHERE email=$1",
      [VICTIM_EMAIL]
    );
    // The property under test is that the lock does not EXTEND. Assert on the ordering rather
    // than exact equality so the case stays valid regardless of which sibling test ran first or
    // whether a probe was absorbed by the rate limiter before reaching the auth path.
    const beforeMs = new Date(before.rows[0].locked_until).getTime();
    const afterMs = new Date(after.rows[0].locked_until).getTime();
    expect(afterMs).toBeLessThanOrEqual(beforeMs);
    expect(Number(after.rows[0].failed_login_count)).toBeLessThanOrEqual(Number(before.rows[0].failed_login_count));
  });

  it("still audits every probe against a locked account", async () => {
    const r = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM partner_audit_events WHERE action='partner_login_failure' AND reason='locked'"
    );
    expect(Number(r.rows[0].n)).toBeGreaterThan(0);
  });

  it("answers a reset request generically and dispatches delivery WITHOUT awaiting it", async () => {
    // Hold delivery open: if the handler awaited it, the HTTP response could not arrive first.
    let release!: () => void;
    deliveryGate = new Promise<void>((r) => (release = r));

    const before = delivered.length;
    const res = await post("/api/partner/auth/password-reset/request", { email: VICTIM_EMAIL });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    // Response returned while delivery is still blocked → the dispatch is genuinely un-awaited.
    expect(delivered.length).toBe(before);

    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(delivered.length).toBe(before + 1);
    deliveryGate = Promise.resolve();
  });

  it("issues a 32-byte token stored ONLY as a SHA-256 hash, expiring in 30 minutes", async () => {
    const { token, email } = delivered[delivered.length - 1];
    expect(email).toBe(VICTIM_EMAIL);
    // 32 random bytes, base64url → 43 chars, and decodes back to exactly 32 bytes.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);

    const { rows } = await admin.query<{ token_hash: string; expires_at: string; used_at: string | null }>(
      "SELECT token_hash, expires_at, used_at FROM partner_password_reset_tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [VICTIM]
    );
    expect(rows[0].token_hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    // The raw token is nowhere at rest.
    expect(rows[0].token_hash).not.toBe(token);
    const ttlMinutes = (new Date(rows[0].expires_at).getTime() - Date.now()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(28);
    expect(ttlMinutes).toBeLessThanOrEqual(30);
    expect(rows[0].used_at).toBeNull();
  });

  it("does not disclose account existence for an unknown address", async () => {
    const before = delivered.length;
    const unknown = await post("/api/partner/auth/password-reset/request", { email: "nobody@example.test" });
    const known = await post("/api/partner/auth/password-reset/request", { email: VICTIM_EMAIL });
    // Byte-identical responses; only the known address actually produces a delivery.
    expect(unknown.status).toBe(known.status);
    expect(unknown.text).toBe(known.text);
    expect(unknown.json).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(delivered.length).toBe(before + 1);
  });

  it("CLEARS the lockout on a successful reset and lets the user sign in again", async () => {
    const beforeRow = await userRow(VICTIM);
    expect(isLocked(beforeRow)).toBe(true);
    const { token } = delivered[delivered.length - 1];

    const consumed = await post("/api/partner/auth/password-reset/consume", {
      token,
      newPassword: NEW_PASSWORD,
    });
    expect(consumed.status).toBe(200);
    expect(consumed.json).toEqual({ ok: true });

    const afterRow = await userRow(VICTIM);
    // THE FIX: both lockout fields cleared…
    expect(afterRow.failed_login_count).toBe(0);
    expect(afterRow.locked_until).toBeNull();
    // …while the pre-existing guarantees are untouched.
    expect(afterRow.credential_version).toBe(beforeRow.credential_version + 1);

    // And the whole point: the user is genuinely back in.
    const ok = await login(VICTIM_EMAIL, NEW_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toContain("mv.partner.sid=");
  });

  it("revokes live sessions and retires the OLD password on reset", async () => {
    const live = await admin.query(
      "SELECT 1 FROM partner_sessions WHERE user_id=$1 AND revoked_at IS NULL AND credential_version < (SELECT credential_version FROM partner_users WHERE id=$1)",
      [VICTIM]
    );
    expect(live.rowCount).toBe(0);

    const stale = await login(VICTIM_EMAIL, OLD_PASSWORD);
    expect(stale.status).toBe(401);
  });

  it("keeps the reset token strictly SINGLE-USE", async () => {
    const { token } = delivered[delivered.length - 1];
    const versionBefore = (await userRow(VICTIM)).credential_version;

    const replay = await post("/api/partner/auth/password-reset/consume", {
      token,
      newPassword: "attacker-chosen-password-1",
    });
    expect(replay.status).toBe(400);
    expect(replay.json).toEqual({ ok: false });

    // Nothing changed: the attacker's password was never set and no version bump occurred.
    expect((await userRow(VICTIM)).credential_version).toBe(versionBefore);
    expect(await storedPasswordIs(VICTIM, "attacker-chosen-password-1")).toBe(false);
    expect(await storedPasswordIs(VICTIM, NEW_PASSWORD)).toBe(true);

    const used = await admin.query<{ used_at: string | null }>(
      "SELECT used_at FROM partner_password_reset_tokens WHERE token_hash=$1",
      [crypto.createHash("sha256").update(token).digest("hex")]
    );
    expect(used.rows[0].used_at).not.toBeNull();
  });

  it("rejects a forged/unknown token without leaking which part was wrong", async () => {
    const forged = crypto.randomBytes(32).toString("base64url");
    const res = await post("/api/partner/auth/password-reset/consume", {
      token: forged,
      newPassword: "some-valid-length-password",
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false });
  });

  it("ignores any client-supplied tenant id — the tenant comes from the token (L6)", async () => {
    await post("/api/partner/auth/password-reset/request", { email: VICTIM_EMAIL });
    await new Promise((r) => setTimeout(r, 50));
    const { token } = delivered[delivered.length - 1];

    const res = await post("/api/partner/auth/password-reset/consume", {
      token,
      newPassword: "tenant-derived-password-1",
      // Attacker-controlled noise that must have no effect whatsoever.
      tenantId: "00000000-0000-0000-0000-00000000dead",
      userId: SUSPENDED,
    });
    expect(res.status).toBe(200);

    // The reset landed on the token's OWN user, not the injected one.
    expect(await storedPasswordIs(VICTIM, "tenant-derived-password-1")).toBe(true);
    // The injected user's credentials and status are completely untouched.
    expect(await storedPasswordIs(SUSPENDED, "tenant-derived-password-1")).toBe(false);
    expect(await storedPasswordIs(SUSPENDED, SUSPENDED_PASSWORD)).toBe(true);
    expect((await userRow(SUSPENDED)).status).toBe("SUSPENDED");
  });

  it("does not accumulate lockout state on a SUSPENDED account", async () => {
    // Six attempts — more than the threshold — against a suspended user.
    for (let i = 0; i < 6; i++) {
      const res = await login(SUSPENDED_EMAIL, "wrong-password");
      expect(res.status).toBe(401);
    }
    const row = await userRow(SUSPENDED);
    // Previously these attempts incremented the counter and armed locked_until, with no reset path
    // while suspended — so reactivating the user handed them an immediately-locked account.
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it("lets a reactivated user sign in immediately, with no inherited lockout", async () => {
    await admin.query("UPDATE partner_users SET status='ACTIVE' WHERE id=$1", [SUSPENDED]);
    const res = await login(SUSPENDED_EMAIL, SUSPENDED_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.setCookie).toContain("mv.partner.sid=");
  });

  it("still records every failed attempt in the audit trail", async () => {
    const { rows } = await admin.query<{ reason: string; n: string }>(
      "SELECT reason, count(*)::text n FROM partner_audit_events WHERE action='partner_login_failure' GROUP BY reason"
    );
    const byReason = Object.fromEntries(rows.map((r) => [r.reason, Number(r.n)]));
    // Suspended attempts are no longer counted towards lockout, but they ARE still audited.
    expect(byReason.suspended).toBeGreaterThanOrEqual(6);
    expect(byReason.invalid).toBeGreaterThanOrEqual(5);
  });
});
