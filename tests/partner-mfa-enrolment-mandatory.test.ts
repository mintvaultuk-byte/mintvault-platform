/**
 * P0-E — mandatory second factor for a newly-accepted partner owner.
 *
 * WHAT THIS PROVES, against a real Express app over real HTTP on a DISPOSABLE local PostgreSQL 17:
 *
 *   1. Accepting an invitation now sets partner_users.mfa_required — the bug was that it did not,
 *      so a brand-new PARTNER_OWNER got a fully MFA-passed session on first login.
 *   2. That owner's session is SERVER-SIDE incomplete: every normal partner API (dashboard,
 *      customers, submissions, locations, service tiers, team, location switch) refuses it. This is
 *      not client routing — the tests never render a page.
 *   3. The enrolment path is nevertheless REACHABLE from that same incomplete session, so setting
 *      mfa_required cannot lock the first owner out. Enrol → confirm → recovery codes → full access.
 *   4. The TOTP secret is disclosed ONLY by the one-time enrolment response, and only to a caller
 *      who re-proves the password.
 *   5. Recovery codes stay hashed at rest and single-use.
 *   6. The pre-existing F1 rule survives: a password-only session cannot REPLACE an existing factor.
 *
 * Reproduce (host must be loopback; the database is dropped and recreated):
 *   PARTNER_MFA_ENROL_RT_ADMIN=postgresql://postgres@127.0.0.1:55444/mv_mfa_enrol \
 *   PARTNER_MFA_ENROL_RT_RUNTIME=postgresql://partner_app_test_mfa_enrol:synthetic@127.0.0.1:55444/mv_mfa_enrol \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-mfa-enrolment-mandatory.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "pg";
import crypto from "node:crypto";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_MFA_ENROL_RT_ADMIN;
const RUNTIME = process.env.PARTNER_MFA_ENROL_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const TENANT = "e5011000-0000-0000-0000-000000000001";
const OWNER = "e5011000-0000-0000-0000-0000000000a1";
const OWNER_EMAIL = "first-owner@example.test";
const OWNER_PASSWORD = "first-owner-password-1";
const INVITE_TOKEN = "mfa-mandatory-invitation-token-abcdefghijklmnop";

/** Every partner API a signed-in user would normally use. NONE may answer an un-enrolled session. */
const NORMAL_PARTNER_APIS: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/api/partner/dashboard" },
  { method: "GET", path: "/api/partner/users" },
  { method: "GET", path: "/api/partner/locations" },
  { method: "GET", path: "/api/partner/customers" },
  { method: "GET", path: "/api/partner/submissions" },
  { method: "GET", path: "/api/partner/service-tiers" },
  { method: "GET", path: "/api/partner/dashboard/submissions" },
  { method: "POST", path: "/api/partner/auth/revoke-all" },
  { method: "POST", path: "/api/partner/session/location", body: { locationId: TENANT } },
  { method: "POST", path: "/api/partner/customers", body: { fullName: "Mallory" } },
  { method: "POST", path: "/api/partner/submissions", body: { locationId: TENANT } },
];

describe("P0-E mandatory MFA enrolment coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_MFA_ENROL_RT_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(true);
    }
    if (!isLocal)
      console.warn("[partner-mfa-enrolment-mandatory] skipped: PARTNER_MFA_ENROL_RT_ADMIN not a loopback URL");
    expect(true).toBe(true);
  });
});

(isLocal ? describe : describe.skip)("P0-E mandatory MFA enrolment for a new partner owner", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";
  let currentTotp: (secret: string, at: number) => string;
  let decryptSecret: (ref: string) => string;

  /** Minimal cookie jar — fetch() does not keep one, and the whole point is session behaviour. */
  let cookie = "";
  async function call(method: string, path: string, body?: unknown, withCookie = true) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(withCookie && cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie && withCookie) cookie = setCookie.split(";")[0];
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON body (404 html) — status is what matters */
    }
    return { status: res.status, json, text };
  }

  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    // Synthetic key, disposable DB only. Without it mount.ts gate 1 closes the whole surface —
    // which is itself why mandatory MFA cannot strand an owner on a misconfigured deployment.
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);

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
    await admin.query("DROP ROLE IF EXISTS partner_app_test_mfa_enrol").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_mfa_enrol LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_mfa_enrol");

    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'mfaOrg','Mandatory MFA Ltd','ACTIVE')",
      [TENANT]
    );
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES ($1,'mfaOwner',$2,$2,$3,'INVITED')",
      [OWNER, TENANT, OWNER_EMAIL]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [TENANT, OWNER]
    );
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true)"
    );
    await admin.query(
      "INSERT INTO partner_invitations (tenant_id, user_id, email, role_code, token_hash, expires_at) VALUES ($1,$2,$3,'PARTNER_OWNER',encode(sha256($4::bytea),'hex'),now()+interval '1 day')",
      [TENANT, OWNER, OWNER_EMAIL, INVITE_TOKEN]
    );

    // PRODUCTION registration order: public routes first, then the gated authenticated mount.
    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
    const mfa = await import("../server/partner/mfa");
    currentTotp = mfa.currentTotp;
    decryptSecret = mfa.decryptSecret;

    const app = express();
    app.use(express.json());
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  it("marks a newly-accepted owner as MFA-required", async () => {
    const accepted = await call("POST", "/api/partner/invitations/accept", {
      token: INVITE_TOKEN,
      password: OWNER_PASSWORD,
    });
    expect(accepted.status).toBe(200);

    const row = await admin.query<{ status: string; mfa_required: boolean; mfa_enabled: boolean }>(
      "SELECT status, mfa_required, mfa_enabled FROM partner_users WHERE id=$1",
      [OWNER]
    );
    // THE FIX: mfa_required is true. It was false before, which is what made every later gate moot.
    expect(row.rows[0]).toEqual({ status: "ACTIVE", mfa_required: true, mfa_enabled: false });
  });

  it("signs the owner in but tells them ENROLMENT (not a code challenge) is the next step", async () => {
    const login = await call("POST", "/api/partner/auth/login", {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    expect(login.status).toBe(200);
    // The login contract is deliberately UNCHANGED (`{ok, mfaRequired}`) — "enrolment or code
    // challenge?" is answered by GET /session, asserted in the next test.
    expect(login.json).toEqual({ ok: true, mfaRequired: true });
    expect(cookie).toContain("mv.partner.sid=");

    // The session row itself is mfa_passed=false — the server, not the client, holds this state.
    const s = await admin.query<{ mfa_passed: boolean }>(
      "SELECT mfa_passed FROM partner_sessions WHERE user_id=$1 AND revoked_at IS NULL",
      [OWNER]
    );
    expect(s.rows.map((r) => r.mfa_passed)).toEqual([false]);
  });

  it("withholds identity and permissions from the incomplete session", async () => {
    const sess = await call("GET", "/api/partner/session");
    expect(sess.status).toBe(200);
    expect(sess.json).toEqual({ mfaPassed: false, mfaRequired: true, mfaEnrolmentRequired: true });
    // No authorization profile, and above all no secret material of any kind.
    expect(sess.json).not.toHaveProperty("permissions");
    expect(sess.json).not.toHaveProperty("userId");
    expect(sess.text).not.toMatch(/secret|otpauth|recovery/i);
  });

  it("SERVER-SIDE refuses every normal partner API before enrolment is complete", async () => {
    for (const api of NORMAL_PARTNER_APIS) {
      const res = await call(api.method, api.path, api.body);
      expect([401, 403], `${api.method} ${api.path} answered ${res.status} to an un-enrolled session`).toContain(
        res.status
      );
    }
  });

  it("keeps the enrolment path reachable from that same incomplete session, and completes it", async () => {
    // Wrong password must NOT hand out a secret, even though the session is otherwise valid.
    const bad = await call("POST", "/api/partner/mfa/enrol", { password: "not-the-password" });
    expect(bad.status).toBe(401);
    expect(bad.text).not.toMatch(/otpauth/);

    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: OWNER_PASSWORD });
    expect(enrol.status).toBe(200);
    const secret = enrol.json.secret as string;
    expect(secret).toBeTruthy();
    expect(enrol.json.otpauthUri as string).toContain("otpauth://totp/MintVault:");

    // A PENDING secret is NOT yet a factor: access is still refused.
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(401);

    const confirm = await call("POST", "/api/partner/mfa/confirm", { code: currentTotp(secret, Date.now()) });
    expect(confirm.status).toBe(200);
    const codes = confirm.json.recoveryCodes as string[];
    expect(codes).toHaveLength(10);

    // Recovery codes are stored HASHED and are not the plaintext (protection preserved).
    const stored = await admin.query<{ code_hash: string }>(
      "SELECT code_hash FROM partner_recovery_codes WHERE user_id=$1 AND used_at IS NULL",
      [OWNER]
    );
    expect(stored.rows).toHaveLength(10);
    for (const plain of codes) {
      expect(stored.rows.some((r) => r.code_hash === plain)).toBe(false);
    }
    process.env.__MFA_TEST_SECRET = secret;
    process.env.__MFA_TEST_RECOVERY = codes.join(",");
  });

  it("grants normal access only after enrolment, and reports honest MFA state", async () => {
    const sess = await call("GET", "/api/partner/session");
    expect(sess.status).toBe(200);
    expect(sess.json).toMatchObject({
      mfaPassed: true,
      mfaRequired: true,
      mfaEnrolled: true,
      mfaEnrolmentRequired: false,
      recoveryCodesRemaining: 10,
    });
    expect(Array.isArray(sess.json.permissions)).toBe(true);
    // Still no secret material on the session surface.
    expect(sess.text).not.toMatch(/otpauth|secret/i);

    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);
    expect((await call("GET", "/api/partner/locations")).status).toBe(200);
  });

  it("never exposes the stored TOTP secret in cleartext at rest", async () => {
    const secret = process.env.__MFA_TEST_SECRET!;
    const rows = await admin.query<{ secret_ref: string; status: string }>(
      "SELECT secret_ref, status FROM partner_mfa_methods WHERE user_id=$1",
      [OWNER]
    );
    const active = rows.rows.filter((r) => r.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0].secret_ref).not.toContain(secret);
    // …and it is genuinely the same secret, only encrypted (fail-closed abstraction still in play).
    expect(decryptSecret(active[0].secret_ref)).toBe(secret);
  });

  it("still requires the CURRENT factor before a password-only session can replace it (F1)", async () => {
    // Fresh sign-in: password accepted, second factor outstanding, an ACTIVE method now exists.
    const login = await call("POST", "/api/partner/auth/login", {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    expect(login.json).toEqual({ ok: true, mfaRequired: true });
    // Now that a factor EXISTS, the session reports a code challenge — not enrolment.
    const sess = await call("GET", "/api/partner/session");
    expect(sess.json).toEqual({ mfaPassed: false, mfaRequired: true, mfaEnrolmentRequired: false });

    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: OWNER_PASSWORD });
    expect(enrol.status).toBe(403);
    expect(enrol.json.error).toBe("requires_current_factor");

    const confirm = await call("POST", "/api/partner/mfa/confirm", { code: "000000" });
    expect(confirm.status).toBe(403);
    expect(confirm.json.error).toBe("requires_current_factor");
  });

  it("accepts a recovery code exactly once as the second factor", async () => {
    const [firstCode, secondCode] = process.env.__MFA_TEST_RECOVERY!.split(",");

    const ok = await call("POST", "/api/partner/auth/mfa", { recoveryCode: firstCode });
    expect(ok.status).toBe(200);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);

    // Replay of the SAME code on a new sign-in is refused; a different unused code works.
    await call("POST", "/api/partner/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const replay = await call("POST", "/api/partner/auth/mfa", { recoveryCode: firstCode });
    expect(replay.status).toBe(401);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(401);

    const fresh = await call("POST", "/api/partner/auth/mfa", { recoveryCode: secondCode });
    expect(fresh.status).toBe(200);

    const left = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_recovery_codes WHERE user_id=$1 AND used_at IS NULL",
      [OWNER]
    );
    expect(Number(left.rows[0].n)).toBe(8);
  });

  it("refuses a TOTP replay within the same step (F3 preserved)", async () => {
    const secret = process.env.__MFA_TEST_SECRET!;
    const code = currentTotp(secret, Date.now());

    await call("POST", "/api/partner/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect((await call("POST", "/api/partner/auth/mfa", { code })).status).toBe(200);

    await call("POST", "/api/partner/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const replay = await call("POST", "/api/partner/auth/mfa", { code });
    expect(replay.status).toBe(401);
  });

  it("does not leak the enrolment secret through any other authenticated route", async () => {
    const secret = process.env.__MFA_TEST_SECRET!;
    await call("POST", "/api/partner/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    await call("POST", "/api/partner/auth/mfa", { code: currentTotp(secret, Date.now() + 30_000) });

    for (const path of [
      "/api/partner/session",
      "/api/partner/dashboard",
      "/api/partner/users",
      "/api/partner/locations",
    ]) {
      const res = await call("GET", path);
      expect(res.text).not.toContain(secret);
    }
  });

  it("uses a token hash, never a raw token, for the consumed invitation", async () => {
    const inv = await admin.query<{ token_hash: string; status: string }>(
      "SELECT token_hash, status FROM partner_invitations WHERE user_id=$1",
      [OWNER]
    );
    expect(inv.rows[0].status).toBe("CONSUMED");
    expect(inv.rows[0].token_hash).toBe(crypto.createHash("sha256").update(INVITE_TOKEN).digest("hex"));
    expect(inv.rows[0].token_hash).not.toBe(INVITE_TOKEN);
  });
});
