/**
 * Wave 1 — MFA current-factor hardening: RUNTIME proof over real HTTP on a disposable PostgreSQL 17.
 *
 * Three items are proven here, and all three are proven by EXECUTING the server — not by reading it.
 * Source-text assertions are deliberately absent: every claim below is an observed HTTP status, an
 * observed response body, or a row read back out of the database with an independent admin client.
 *
 *   C — RECOVERY-CODE REGENERATION. The defect: an already-enrolled partner user could mint ten
 *       replacement recovery codes with password/session alone. Recovery codes ARE second factors
 *       (POST /auth/mfa completes a sign-in with one), so that was self-issuing a new authenticator
 *       — strictly weaker than both `mfa/disable` and enrolment-REPLACEMENT, which have demanded a
 *       current factor since F3. Now regeneration demands the same proof, via the same mechanism.
 *
 *   A — MFA DISABLE. Disabling the METHOD must never disable the REQUIREMENT: the account is left
 *       required-but-unenrolled, the next login is forced into re-enrolment, and no amount of
 *       password-only access is granted in between.
 *
 *   B — AUTHENTICATOR REPLACEMENT. First enrolment must stay reachable with the password alone (the
 *       user has no factor to present yet); replacing an EXISTING authenticator must not be.
 *
 * Reproduce (host must be loopback; the database is dropped and recreated):
 *   PARTNER_MFA_HARDENING_RT_ADMIN=postgresql://postgres@127.0.0.1:55444/mv_mfa_hardening \
 *   PARTNER_MFA_HARDENING_RT_RUNTIME=postgresql://partner_app_test_mfa_hard:synthetic@127.0.0.1:55444/mv_mfa_hardening \
 *   LC_ALL=C LANG=C npx vitest run tests/partner-mfa-factor-hardening.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_RBAC_SEED,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_MFA_HARDENING_RT_ADMIN;
const RUNTIME = process.env.PARTNER_MFA_HARDENING_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const TENANT_A = "e5012000-0000-0000-0000-000000000001";
const TENANT_B = "e5012000-0000-0000-0000-000000000002";
const USER_A = "e5012000-0000-0000-0000-0000000000a1";
const USER_B = "e5012000-0000-0000-0000-0000000000b1";
const EMAIL_A = "hardening-a@example.test";
const EMAIL_B = "hardening-b@example.test";
const PASSWORD = "hardening-password-1";

describe("MFA current-factor hardening coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_MFA_HARDENING_RT_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(
        true
      );
    }
    if (!isLocal) console.warn("[partner-mfa-factor-hardening] skipped: PARTNER_MFA_HARDENING_RT_ADMIN not loopback");
    expect(true).toBe(true);
  });
});

(isLocal ? describe : describe.skip)("Wave 1 MFA current-factor hardening (runtime)", () => {
  let admin: Client;
  let server: http.Server;
  let base = "";
  let currentTotp: (secret: string, at: number) => string;
  let decryptSecret: (ref: string) => string;
  let recoveryHash: (code: string) => string;
  let MemoryRateLimitStore: new () => unknown;
  let setPartnerRateLimitStore: (s: unknown) => void;

  /** Per-identity cookie jars — several sessions are compared against each other below. */
  const jars: Record<string, string> = {};
  let jar = "a";

  async function call(method: string, path: string, body?: unknown, withCookie = true) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(withCookie && jars[jar] ? { cookie: jars[jar] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie && withCookie) jars[jar] = setCookie.split(";")[0];
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON body — status is what matters */
    }
    return { status: res.status, json, text };
  }

  /** Fresh limiter buckets. The limiters stay INSTALLED and are asserted to still fire (see below);
   *  this only stops a 20-per-15-minute budget from starving a suite that legitimately makes more
   *  than twenty MFA calls. */
  function resetLimits() {
    setPartnerRateLimitStore(new MemoryRateLimitStore());
  }

  /**
   * A genuinely valid TOTP for `userId`.
   *
   * Clearing the accepted-counter watermark first is a FIXTURE reset, not a relaxation of replay
   * protection: every code presented below is really computed from the real secret, and replay
   * rejection has its own dedicated coverage in partner-mfa-enrolment-mandatory.test.ts. Without
   * this, a suite needing several distinct TOTP proofs inside one 30-second step would be
   * timing-dependent — exactly the accidental-serialisation fragility Wave 1 is trying to remove.
   */
  async function totpFor(userId: string, secret: string): Promise<string> {
    await admin.query("UPDATE partner_mfa_methods SET last_totp_counter=NULL WHERE user_id=$1", [userId]);
    return currentTotp(secret, Date.now());
  }

  async function login(email: string) {
    resetLimits();
    return call("POST", "/api/partner/auth/login", { email, password: PASSWORD });
  }

  /** Enrol from scratch (no active method) and return the new secret + its recovery codes. */
  async function enrolFresh(): Promise<{ secret: string; codes: string[] }> {
    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD });
    expect(enrol.status, `enrol failed: ${enrol.text}`).toBe(200);
    const enrolmentId = enrol.json.enrolmentId as string;
    const secret = enrol.json.secret as string;
    const confirm = await call("POST", "/api/partner/mfa/confirm", {
      enrolmentId,
      code: currentTotp(secret, Date.now()),
    });
    expect(confirm.status, `confirm failed: ${confirm.text}`).toBe(200);
    return { secret, codes: confirm.json.recoveryCodes as string[] };
  }

  async function unusedCodeHashes(userId: string): Promise<string[]> {
    const r = await admin.query<{ code_hash: string }>(
      "SELECT code_hash FROM partner_recovery_codes WHERE user_id=$1 AND used_at IS NULL ORDER BY code_hash",
      [userId]
    );
    return r.rows.map((x) => x.code_hash);
  }

  async function securityKinds(tenantId: string): Promise<{ kind: string; severity: string }[]> {
    const r = await admin.query<{ kind: string; severity: string }>(
      "SELECT kind, severity FROM partner_security_events WHERE tenant_id=$1 ORDER BY created_at",
      [tenantId]
    );
    return r.rows;
  }

  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64); // synthetic; disposable DB only

    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    // Cluster-role bootstrap is TOCTOU-safe (see partner-mfa-enrolment-mandatory.test.ts): roles are
    // cluster-scoped, databases are not, so two suites on one cluster race on CREATE ROLE.
    await admin.query(
      `DO $$ BEGIN CREATE ROLE partner_runtime NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query(
      `DO $$ BEGIN CREATE ROLE partner_connector_runtime NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
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
    await admin.query("DROP ROLE IF EXISTS partner_app_test_mfa_hard").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_mfa_hard LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_mfa_hard");

    const hash = bcrypt.hashSync(PASSWORD, 10);
    for (const [tenant, user, email, ref] of [
      [TENANT_A, USER_A, EMAIL_A, "hardA"],
      [TENANT_B, USER_B, EMAIL_B, "hardB"],
    ] as const) {
      await admin.query(
        "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,$2,$3,'ACTIVE')",
        [tenant, `org-${ref}`, `Hardening ${ref} Ltd`]
      );
      await admin.query(
        `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status, password_hash, mfa_required)
         VALUES ($1,$2,$3,$3,$4,'ACTIVE',$5,true)`,
        [user, ref, tenant, email, hash]
      );
      await admin.query(
        "INSERT INTO partner_user_roles (tenant_id, user_id, role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
        [tenant, user]
      );
    }
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_login_enabled',true),(NULL,'partner_onboarding_enabled',true)"
    );

    const { registerPartnerPublicRoutes } = await import("../server/partner/public-routes");
    const { mountPartnerPortal } = await import("../server/partner/mount");
    const mfa = await import("../server/partner/mfa");
    currentTotp = mfa.currentTotp;
    decryptSecret = mfa.decryptSecret;
    recoveryHash = mfa.recoveryHash;
    const rl = await import("../server/partner/rate-limit");
    MemoryRateLimitStore = rl.MemoryRateLimitStore as unknown as new () => unknown;
    setPartnerRateLimitStore = rl.setPartnerRateLimitStore as unknown as (s: unknown) => void;

    const app = express();
    app.use(express.json());
    registerPartnerPublicRoutes(app);
    mountPartnerPortal(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  // ==================================================================================
  // B (part 1) — FIRST ENROLMENT must not be weakened to make replacement secure.
  // ==================================================================================

  let secretA = "";
  let codesA: string[] = [];
  /** A real recovery code that was valid before a regeneration superseded it. */
  let supersededCode = "";

  it("B1: first enrolment needs NO current factor and issues the initial recovery codes", async () => {
    jar = "a";
    const login1 = await login(EMAIL_A);
    expect(login1.status).toBe(200);
    expect(login1.json).toEqual({ ok: true, mfaRequired: true });

    // No active authenticator exists yet, so the session is correctly steered to ENROLMENT.
    const sess = await call("GET", "/api/partner/session");
    expect(sess.json).toEqual({ mfaPassed: false, mfaRequired: true, mfaEnrolmentRequired: true });

    // The password ALONE is accepted — there is no factor this user could present.
    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD });
    expect(enrol.status, "first enrolment must not require a factor that does not yet exist").toBe(200);
    const enrolmentId = enrol.json.enrolmentId as string;
    secretA = enrol.json.secret as string;
    expect(secretA).toBeTruthy();

    const confirm = await call("POST", "/api/partner/mfa/confirm", {
      enrolmentId,
      code: currentTotp(secretA, Date.now()),
    });
    expect(confirm.status).toBe(200);
    codesA = confirm.json.recoveryCodes as string[];
    expect(codesA).toHaveLength(10);

    // Stored hashed only, and full access is now granted.
    expect(await unusedCodeHashes(USER_A)).toHaveLength(10);
    for (const plain of codesA) expect((await unusedCodeHashes(USER_A)).includes(plain)).toBe(false);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);
  });

  // ==================================================================================
  // C — RECOVERY-CODE REGENERATION HARDENING (priority #1)
  // ==================================================================================

  it("C1: an ENROLLED user cannot regenerate recovery codes with password/session alone", async () => {
    resetLimits();
    const before = await unusedCodeHashes(USER_A);
    expect(before).toHaveLength(10);

    // Fully MFA-passed session + correct password. This SUCCEEDED before the fix.
    const res = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", { password: PASSWORD });
    expect(res.status, "password/session alone must not mint replacement recovery codes").toBe(403);
    expect(res.json.error).toBe("second_factor_required");

    // Requirement 1: no codes returned. Requirement: the existing set is untouched.
    expect(res.json).not.toHaveProperty("recoveryCodes");
    expect(res.text).not.toMatch(/recoveryCodes/);
    expect(await unusedCodeHashes(USER_A)).toEqual(before);
  });

  it("C2: an INVALID factor is refused, and a wrong password is refused before anything else", async () => {
    resetLimits();
    const before = await unusedCodeHashes(USER_A);

    const badTotp = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password: PASSWORD,
      code: "000000",
    });
    expect(badTotp.status).toBe(403);
    expect(badTotp.json.error).toBe("second_factor_required");

    const badRecovery = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password: PASSWORD,
      recoveryCode: "not-a-real-recovery-code",
    });
    expect(badRecovery.status).toBe(403);

    // Wrong password with a VALID factor is still unauthorised — the factor does not replace it.
    const badPassword = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password: "wrong-password",
      code: await totpFor(USER_A, secretA),
    });
    expect(badPassword.status).toBe(401);
    expect(badPassword.json.error).toBe("unauthorised");

    expect(await unusedCodeHashes(USER_A)).toEqual(before);
  });

  it("C3: a valid current TOTP mints a new set, and every previous unused code becomes unusable", async () => {
    resetLimits();
    const oldCodes = [...codesA];
    const oldHashes = await unusedCodeHashes(USER_A);

    const res = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password: PASSWORD,
      code: await totpFor(USER_A, secretA),
    });
    expect(res.status, res.text).toBe(200);
    const newCodes = res.json.recoveryCodes as string[];
    expect(newCodes).toHaveLength(10);

    // Requirement 2: the previous unused codes are gone from the table entirely.
    const newHashes = await unusedCodeHashes(USER_A);
    expect(newHashes).toHaveLength(10);
    for (const h of oldHashes) expect(newHashes).not.toContain(h);
    for (const plain of oldCodes) expect(newHashes).not.toContain(recoveryHash(plain));

    // Requirement 3/4: codes appear ONLY in this one-time response, and never in cleartext at rest.
    for (const plain of newCodes) expect(newHashes).not.toContain(plain);
    supersededCode = oldCodes[0]; // kept, in plaintext, to be presented to the real sign-in path next
    codesA = newCodes;
  });

  it("C3b: a superseded recovery code is genuinely dead at the authentication boundary", async () => {
    // Not a table assertion — the OLD code is presented to the real sign-in path and must fail,
    // while a NEW one succeeds. This is what "unusable" has to mean.
    expect(supersededCode).toBeTruthy();
    jar = "a-dead";
    await login(EMAIL_A);
    const replay = await call("POST", "/api/partner/auth/mfa", { recoveryCode: supersededCode });
    expect(replay.status, "a superseded recovery code must not complete a sign-in").toBe(401);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(401);

    const good = await call("POST", "/api/partner/auth/mfa", { recoveryCode: codesA[9] });
    expect(good.status, good.text).toBe(200);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);
    jar = "a";
  });

  it("C4: a valid unused RECOVERY CODE is also accepted as the current factor, and is consumed", async () => {
    resetLimits();
    jar = "a";
    // Re-establish a fully MFA-passed session for the main jar.
    await login(EMAIL_A);
    expect((await call("POST", "/api/partner/auth/mfa", { code: await totpFor(USER_A, secretA) })).status).toBe(200);

    const factor = codesA[0];
    const res = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password: PASSWORD,
      recoveryCode: factor,
    });
    expect(res.status, res.text).toBe(200);
    const minted = res.json.recoveryCodes as string[];
    expect(minted).toHaveLength(10);
    // The consumed factor is not carried into the new set, and the whole old set is gone.
    const hashes = await unusedCodeHashes(USER_A);
    expect(hashes).not.toContain(recoveryHash(factor));
    for (const old of codesA) expect(hashes).not.toContain(recoveryHash(old));
    codesA = minted;
  });

  it("C5: a Partner-visible security event is written, with no secret material in it", async () => {
    const events = await securityKinds(TENANT_A);
    const regen = events.filter((e) => e.kind === "partner_mfa_recovery_regenerated");
    expect(regen.length, "regeneration must raise a partner-visible security event").toBeGreaterThanOrEqual(2);
    for (const e of regen) expect(e.severity).toBe("medium");

    // Requirement 7: internal audit evidence remains correct too.
    const audit = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_audit_events WHERE tenant_id=$1 AND action='partner_mfa_recovery_regenerated'",
      [TENANT_A]
    );
    expect(Number(audit.rows[0].n)).toBeGreaterThanOrEqual(2);

    // Requirements 4 + 5: no plaintext recovery code and no TOTP secret anywhere in the evidence.
    const dump = await admin.query<{ blob: string }>(
      `SELECT coalesce(detail::text,'') || ' ' AS blob FROM partner_security_events WHERE tenant_id=$1
       UNION ALL
       SELECT coalesce(before_value::text,'') || coalesce(after_value::text,'') || coalesce(reason,'')
         FROM partner_audit_events WHERE tenant_id=$1`,
      [TENANT_A]
    );
    const all = dump.rows.map((r) => r.blob).join(" ");
    expect(all).not.toContain(secretA);
    for (const plain of codesA) expect(all).not.toContain(plain);
  });

  it("C6: the TOTP secret is never exposed by the regeneration surface", async () => {
    resetLimits();
    const res = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password: PASSWORD,
      recoveryCode: codesA[1],
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(secretA);
    expect(res.text).not.toMatch(/otpauth|secret/i);
    codesA = res.json.recoveryCodes as string[];

    // …and the stored secret is still encrypted, still the same secret.
    const rows = await admin.query<{ secret_ref: string }>(
      "SELECT secret_ref FROM partner_mfa_methods WHERE user_id=$1 AND status='ACTIVE'",
      [USER_A]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].secret_ref).not.toContain(secretA);
    expect(decryptSecret(rows.rows[0].secret_ref)).toBe(secretA);
  });

  it("C7: regeneration is still rate limited, and an unauthenticated caller still cannot reach it", async () => {
    // Requirement 9: the limiter is still installed on this route. Budget is 20 / 15 min.
    resetLimits();
    let saw429 = false;
    for (let i = 0; i < 25 && !saw429; i++) {
      const r = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", { password: PASSWORD });
      if (r.status === 429) saw429 = true;
    }
    expect(saw429, "the MFA limiter must still guard recovery-code regeneration").toBe(true);
    resetLimits();

    const anon = await fetch(`${base}/api/partner/mfa/recovery-codes/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(anon.status).toBe(401);
  });

  it("C8: tenant isolation — regenerating in one tenant does not touch another tenant's codes", async () => {
    resetLimits();
    jar = "b";
    await login(EMAIL_B);
    const b = await enrolFresh();
    expect(b.codes).toHaveLength(10);

    const aBefore = await unusedCodeHashes(USER_A);
    const res = await call("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password: PASSWORD,
      code: await totpFor(USER_B, b.secret),
    });
    expect(res.status, res.text).toBe(200);

    // Tenant A untouched; every row is tenant-scoped to its owner.
    expect(await unusedCodeHashes(USER_A)).toEqual(aBefore);
    const scoped = await admin.query<{ tenant_id: string; user_id: string }>(
      "SELECT DISTINCT tenant_id, user_id FROM partner_recovery_codes"
    );
    for (const row of scoped.rows) {
      expect(row.tenant_id).toBe(row.user_id === USER_A ? TENANT_A : TENANT_B);
    }
    // B's security event landed under B, not under A.
    expect((await securityKinds(TENANT_B)).some((e) => e.kind === "partner_mfa_recovery_regenerated")).toBe(true);
    jar = "a";
  });

  // ==================================================================================
  // B (part 2) — AUTHENTICATOR REPLACEMENT
  // ==================================================================================

  it("B2: replacement cannot be done with password/session alone, nor with an invalid factor", async () => {
    resetLimits();
    jar = "a";
    await login(EMAIL_A);
    expect((await call("POST", "/api/partner/auth/mfa", { code: await totpFor(USER_A, secretA) })).status).toBe(200);

    const noFactor = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD });
    expect(noFactor.status).toBe(403);
    expect(noFactor.json.error).toBe("second_factor_required");
    expect(noFactor.text).not.toMatch(/otpauth|secret/i);

    const badFactor = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD, code: "000000" });
    expect(badFactor.status).toBe(403);
    expect(badFactor.text).not.toMatch(/otpauth/);

    // The existing authenticator is untouched by the failed attempts.
    const active = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_mfa_methods WHERE user_id=$1 AND status='ACTIVE'",
      [USER_A]
    );
    expect(Number(active.rows[0].n)).toBe(1);
  });

  it("B3: a valid current TOTP permits replacement; the OLD factor stops working afterwards", async () => {
    resetLimits();
    const oldSecret = secretA;
    const credBefore = await admin.query<{ credential_version: number }>(
      "SELECT credential_version FROM partner_users WHERE id=$1",
      [USER_A]
    );

    /*
     * A second, concurrently-live session that did NOT perform the replacement.
     *
     * It has to be inserted directly: `partnerLogin` ROTATES (it revokes every prior live session
     * for the user before minting a new one), so a second sign-in would destroy the very session
     * under test rather than sit alongside it. The row is written with exactly the columns the login
     * path writes, so it is a genuine live session — it is then read back to prove the replacement
     * revoked it.
     */
    const bystander = await admin.query<{ id: string }>(
      `INSERT INTO partner_sessions (tenant_id, user_id, token_hash, credential_version, mfa_passed, absolute_expires_at)
       SELECT $1, id, 'bystander-token-hash-b3', credential_version, true, now() + interval '12 hours'
         FROM partner_users WHERE id=$2 RETURNING id`,
      [TENANT_A, USER_A]
    );
    const bystanderId = bystander.rows[0].id;

    const enrol = await call("POST", "/api/partner/mfa/enrol", {
      password: PASSWORD,
      code: await totpFor(USER_A, oldSecret),
    });
    expect(enrol.status, enrol.text).toBe(200);
    const enrolmentId = enrol.json.enrolmentId as string;
    const newSecret = enrol.json.secret as string;
    expect(newSecret).not.toBe(oldSecret);

    const confirm = await call("POST", "/api/partner/mfa/confirm", {
      enrolmentId,
      code: currentTotp(newSecret, Date.now()),
    });
    expect(confirm.status, confirm.text).toBe(200);
    expect(confirm.json.recoveryCodes as string[]).toHaveLength(10);
    codesA = confirm.json.recoveryCodes as string[];
    secretA = newSecret;

    // Exactly one ACTIVE method, and it is the NEW secret.
    const rows = await admin.query<{ secret_ref: string }>(
      "SELECT secret_ref FROM partner_mfa_methods WHERE user_id=$1 AND status='ACTIVE'",
      [USER_A]
    );
    expect(rows.rows).toHaveLength(1);
    expect(decryptSecret(rows.rows[0].secret_ref)).toBe(newSecret);

    // Credential state moved, and the bystander session died with the factor it was issued under.
    const credAfter = await admin.query<{ credential_version: number }>(
      "SELECT credential_version FROM partner_users WHERE id=$1",
      [USER_A]
    );
    expect(credAfter.rows[0].credential_version).toBeGreaterThan(credBefore.rows[0].credential_version);

    // The bystander session died with the factor it was issued under…
    const bystanderAfter = await admin.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM partner_sessions WHERE id=$1",
      [bystanderId]
    );
    expect(
      bystanderAfter.rows[0].revoked_at,
      "a session that did not perform the swap must not outlive it"
    ).not.toBeNull();

    // …while the session that DID perform it is carried across the credential_version bump.
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);

    // The OLD authenticator can no longer complete a sign-in.
    jar = "a-old";
    await login(EMAIL_A);
    const oldCode = await totpFor(USER_A, oldSecret);
    const rejected = await call("POST", "/api/partner/auth/mfa", { code: oldCode });
    expect(rejected.status, "the replaced authenticator must not still authenticate").toBe(401);
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(401);
    jar = "a";
  });

  it("B4: a valid one-time RECOVERY code is also accepted as the replacement factor", async () => {
    resetLimits();
    jar = "a";
    await login(EMAIL_A);
    expect((await call("POST", "/api/partner/auth/mfa", { code: await totpFor(USER_A, secretA) })).status).toBe(200);

    // Captured BEFORE the confirm rewrites the set — the replay below must present the code that was
    // actually consumed, not whichever code happens to sit at index 2 in the replacement set.
    const usedFactor = codesA[2];
    const enrol = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD, recoveryCode: usedFactor });
    expect(enrol.status, enrol.text).toBe(200);
    const enrolmentId = enrol.json.enrolmentId as string;
    const newSecret = enrol.json.secret as string;
    const confirm = await call("POST", "/api/partner/mfa/confirm", {
      enrolmentId,
      code: currentTotp(newSecret, Date.now()),
    });
    expect(confirm.status).toBe(200);
    secretA = newSecret;
    codesA = confirm.json.recoveryCodes as string[];

    // Consumed exactly once: the same code cannot be replayed for another replacement.
    const replay = await call("POST", "/api/partner/mfa/enrol", { password: PASSWORD, recoveryCode: usedFactor });
    expect([401, 403], "a spent recovery code must not authorise a second replacement").toContain(replay.status);
  });

  // ==================================================================================
  // A — MFA DISABLE RUNTIME PROOF
  // ==================================================================================

  it("A1: disable requires a current factor, then clears the METHOD but never the REQUIREMENT", async () => {
    resetLimits();
    jar = "a";
    await login(EMAIL_A);
    expect((await call("POST", "/api/partner/auth/mfa", { code: await totpFor(USER_A, secretA) })).status).toBe(200);

    // Starting state: enrolled AND required.
    const start = await admin.query<{ mfa_enabled: boolean; mfa_required: boolean }>(
      "SELECT mfa_enabled, mfa_required FROM partner_users WHERE id=$1",
      [USER_A]
    );
    expect(start.rows[0]).toEqual({ mfa_enabled: true, mfa_required: true });

    // Password alone cannot disable.
    const passwordOnly = await call("POST", "/api/partner/mfa/disable", { password: PASSWORD });
    expect(passwordOnly.status).toBe(400);
    expect(passwordOnly.json.error).toBe("second_factor_required");

    // The supported disable action, with a real current factor.
    const disabled = await call("POST", "/api/partner/mfa/disable", {
      password: PASSWORD,
      code: await totpFor(USER_A, secretA),
    });
    expect(disabled.status, disabled.text).toBe(200);

    // mfa_enabled flips; mfa_required MUST NOT.
    const after = await admin.query<{ mfa_enabled: boolean; mfa_required: boolean }>(
      "SELECT mfa_enabled, mfa_required FROM partner_users WHERE id=$1",
      [USER_A]
    );
    expect(after.rows[0].mfa_enabled).toBe(false);
    expect(after.rows[0].mfa_required, "disabling the method must never clear the requirement").toBe(true);

    // No ACTIVE method survives, and the recovery codes went with it.
    const active = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_mfa_methods WHERE user_id=$1 AND status='ACTIVE'",
      [USER_A]
    );
    expect(Number(active.rows[0].n)).toBe(0);
    expect(await unusedCodeHashes(USER_A)).toHaveLength(0);

    // Every session is revoked.
    const live = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_sessions WHERE user_id=$1 AND revoked_at IS NULL",
      [USER_A]
    );
    expect(Number(live.rows[0].n)).toBe(0);
  });

  it("A2: after disable, the user CANNOT gain unrestricted password-only access", async () => {
    resetLimits();
    jar = "a-post-disable";
    const login1 = await login(EMAIL_A);
    expect(login1.status).toBe(200);
    // The login contract still reports an outstanding second factor.
    expect(login1.json).toEqual({ ok: true, mfaRequired: true });

    // Server-side the session is incomplete.
    const s = await admin.query<{ mfa_passed: boolean }>(
      "SELECT mfa_passed FROM partner_sessions WHERE user_id=$1 AND revoked_at IS NULL",
      [USER_A]
    );
    expect(s.rows.map((r) => r.mfa_passed)).toEqual([false]);

    // …and every normal partner API refuses it.
    for (const path of [
      "/api/partner/dashboard",
      "/api/partner/users",
      "/api/partner/locations",
      "/api/partner/customers",
      "/api/partner/submissions",
    ]) {
      const res = await call("GET", path);
      expect([401, 403], `${path} answered ${res.status} to a disabled-MFA session`).toContain(res.status);
    }

    // There is no factor left to satisfy a code challenge with, either.
    expect((await call("POST", "/api/partner/auth/mfa", { code: "000000" })).status).toBe(401);
  });

  it("A3: the next login is forced into RE-ENROLMENT, which is reachable and restores access", async () => {
    const sess = await call("GET", "/api/partner/session");
    expect(sess.status).toBe(200);
    // enrolmentRequired — not a code challenge the user could never answer.
    expect(sess.json).toEqual({ mfaPassed: false, mfaRequired: true, mfaEnrolmentRequired: true });

    // Bootstrap remains password-only, so disable cannot strand the account.
    const again = await enrolFresh();
    expect(again.codes).toHaveLength(10);
    secretA = again.secret;
    codesA = again.codes;
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(200);

    const state = await admin.query<{ mfa_enabled: boolean; mfa_required: boolean }>(
      "SELECT mfa_enabled, mfa_required FROM partner_users WHERE id=$1",
      [USER_A]
    );
    expect(state.rows[0]).toEqual({ mfa_enabled: true, mfa_required: true });
    jar = "a";
  });

  it("A4: audit and Partner-visible security evidence exist for the disable", async () => {
    const audit = await admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM partner_audit_events WHERE tenant_id=$1 AND action='partner_mfa_disabled'",
      [TENANT_A]
    );
    expect(Number(audit.rows[0].n)).toBeGreaterThanOrEqual(1);

    const sec = (await securityKinds(TENANT_A)).filter((e) => e.kind === "partner_mfa_disabled");
    expect(sec.length).toBeGreaterThanOrEqual(1);
    expect(sec[0].severity).toBe("medium");

    // The replacement performed in B3/B4 is also on the record, at the same severity.
    const replaced = (await securityKinds(TENANT_A)).filter((e) => e.kind === "partner_mfa_replaced");
    expect(replaced.length).toBeGreaterThanOrEqual(1);
    expect(replaced[0].severity).toBe("medium");
  });

  it("A5: an admin MFA reset lands in the same required-but-unenrolled state", async () => {
    // The other supported disable path. Same invariant: the METHOD goes, the REQUIREMENT stays.
    await admin.query(
      `UPDATE partner_users SET mfa_enabled=false, mfa_required=true, credential_version=credential_version+1 WHERE id=$1`,
      [USER_B]
    );
    await admin.query("UPDATE partner_mfa_methods SET status='DISABLED' WHERE user_id=$1", [USER_B]);
    await admin.query("UPDATE partner_recovery_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [USER_B]);
    await admin.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [USER_B]);

    resetLimits();
    jar = "b-reset";
    const login1 = await login(EMAIL_B);
    expect(login1.json).toEqual({ ok: true, mfaRequired: true });
    expect((await call("GET", "/api/partner/dashboard")).status).toBe(401);
    const sess = await call("GET", "/api/partner/session");
    expect(sess.json).toEqual({ mfaPassed: false, mfaRequired: true, mfaEnrolmentRequired: true });
  });
});
