/**
 * AG-3b — SUPER ADMIN STEP-UP, proven against real PostgreSQL and the real Express stack.
 *
 * THE GAP. AG-3 gave PARTNER sessions a step-up stamp, but the most destructive actions in the
 * system are not partner actions: approving or revoking a station, suspending a partner
 * organisation, resetting somebody's MFA, initiating a password reset, granting Grading Credits,
 * emergency stop. Those run as Super Admin on the ADMIN session, which
 * `partner_sessions.last_step_up_at` cannot reach. `requireSuperAdmin` + a typed confirmation +
 * a mandatory reason are real controls, but none of them is evidence that the person at the
 * keyboard is still the person who logged in.
 *
 * WHY A REAL SERVER AND A REAL DATABASE. The properties that matter are all integration
 * properties — a middleware ordering, a session persisted through connect-pg-simple, and a
 * freshness comparison evaluated by PostgreSQL. Every one of them would be trivially "proved" and
 * completely unverified against a mock.
 *
 * Mutation targets: ASU1 (no stamp refuses), ASU2 (fresh permits), ASU3 (expired refuses),
 * ASU4 (partner session cannot satisfy it), ASU5 (stamp is shared, not process-local).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import express, { type Express } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import type { Server } from "node:http";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let sessionPool: Pool;
let server: Server;
let base = "";
let stepUp: typeof import("../server/lib/admin-step-up");
let savedEnv: Record<string, string | undefined> = {};

/**
 * The real connect-pg-simple session table.
 *
 * Using the genuine store rather than a MemoryStore is the whole point of ASU5: a stamp kept in
 * process memory would pass every other case here and still be wrong, because the second Fly
 * Machine would never see it (invariant I19).
 */
const SESSION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "session" (
    sid varchar NOT NULL COLLATE "default" PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

/**
 * A minimal app that mounts the REAL middleware over the REAL session store.
 *
 * `/sign-in` fakes only the LOGIN (this suite is not testing the password/PIN flow, which the admin
 * auth suites already cover). Everything after that — the stamp, its persistence, its expiry and
 * the guard — is production code.
 */
function buildApp(): Express {
  const PgStore = connectPgSimple(session);
  const app = express();
  app.use(express.json());
  app.use(
    session({
      store: new PgStore({ pool: sessionPool, createTableIfMissing: false }),
      secret: "test-only-secret",
      name: "mv.sid",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: false, maxAge: 60 * 60 * 1000 },
    })
  );

  app.post("/sign-in", (req, res) => {
    (req.session as unknown as { isAdmin: boolean; adminEmail: string }).isAdmin = true;
    (req.session as unknown as { isAdmin: boolean; adminEmail: string }).adminEmail = "admin@mintvault.test";
    req.session.save(() => res.json({ ok: true }));
  });

  /** A PARTNER session — deliberately NOT an admin one. Used by ASU4. */
  app.post("/sign-in-partner", (req, res) => {
    (req.session as unknown as { partnerUserId: string }).partnerUserId = "partner-user-1";
    req.session.save(() => res.json({ ok: true }));
  });

  app.post("/step-up", async (req, res) => {
    await stepUp.recordAdminStepUp(req);
    res.json({ ok: true });
  });

  app.post("/destructive", stepUp.requireAdminStepUp(), (_req, res) => res.json({ done: true }));

  /** Read-only navigation must never demand a proof. */
  app.get("/read-only", (_req, res) => res.json({ ok: true }));

  return app;
}

async function call(path: string, cookie?: string): Promise<{ status: number; cookie: string; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: path === "/read-only" ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  });
  return {
    status: res.status,
    cookie: res.headers.get("set-cookie")?.split(";")[0] ?? cookie ?? "",
    body: await res.json().catch(() => ({})),
  };
}

describe("AG-3b Super Admin step-up (real Express + real session store)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-admin-step-up");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await admin.query(SESSION_TABLE_SQL);

    savedEnv = { MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    stepUp = await import("../server/lib/admin-step-up");

    sessionPool = new Pool({ connectionString: cluster.url });
    const app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await sessionPool?.end().catch(() => {});
    const db = await import("../server/db");
    await db.pool?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ---- ASU1 ---------------------------------------------------------------------------------
  it("ASU1: an admin session that has NEVER stepped up is refused", async () => {
    /*
     * This is the state of EVERY admin session that existed before AG-3b shipped. If a missing
     * stamp read as fresh, the deployment itself would have authorised every open console.
     */
    const signedIn = await call("/sign-in");
    const attempt = await call("/destructive", signedIn.cookie);
    expect(attempt.status).toBe(403);
    expect((attempt.body as { code?: string }).code).toBe("admin_step_up_required");
  });

  it("ASU1b: no session at all is 401, not a step-up prompt", async () => {
    // Someone with no admin session must be told to authenticate, not invited to re-confirm.
    const attempt = await call("/destructive");
    expect(attempt.status).toBe(401);
  });

  // ---- ASU2 ---------------------------------------------------------------------------------
  it("ASU2: a fresh proof permits the destructive action", async () => {
    const signedIn = await call("/sign-in");
    const stepped = await call("/step-up", signedIn.cookie);
    expect(stepped.status).toBe(200);

    const attempt = await call("/destructive", signedIn.cookie);
    expect(attempt.status).toBe(200);
    expect((attempt.body as { done?: boolean }).done).toBe(true);
  });

  // ---- ASU3 ---------------------------------------------------------------------------------
  it("ASU3: the proof EXPIRES — an old stamp is refused", async () => {
    const signedIn = await call("/sign-in");
    await call("/step-up", signedIn.cookie);
    expect((await call("/destructive", signedIn.cookie)).status).toBe(200);

    /*
     * Age the stamp IN THE SESSION STORE, which is exactly where it lives. Rewriting the persisted
     * row rather than an in-memory object is what makes this a test of the real mechanism.
     */
    const sid = decodeURIComponent(signedIn.cookie.split("=")[1]).replace(/^s:/, "").split(".")[0];
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    const updated = await admin.query(
      `UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{adminStepUpAt}', to_jsonb($2::text))::json
        WHERE sid = $1 RETURNING sid`,
      [sid, stale]
    );
    expect(updated.rowCount, "the session row must be findable — otherwise this proves nothing").toBe(1);

    const attempt = await call("/destructive", signedIn.cookie);
    expect(attempt.status).toBe(403);
    expect((attempt.body as { code?: string }).code).toBe("admin_step_up_required");
  });

  it("ASU3b: a stamp in the FUTURE is refused rather than treated as eternally fresh", async () => {
    const signedIn = await call("/sign-in");
    await call("/step-up", signedIn.cookie);
    const sid = decodeURIComponent(signedIn.cookie.split("=")[1]).replace(/^s:/, "").split(".")[0];
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await admin.query(
      `UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{adminStepUpAt}', to_jsonb($2::text))::json WHERE sid = $1`,
      [sid, future]
    );
    // A future stamp is a tampered or clock-skewed one; accepting it would make the window unbounded.
    expect((await call("/destructive", signedIn.cookie)).status).toBe(403);
  });

  it("ASU3c: a corrupt stamp fails closed rather than throwing the route open", async () => {
    const signedIn = await call("/sign-in");
    await call("/step-up", signedIn.cookie);
    const sid = decodeURIComponent(signedIn.cookie.split("=")[1]).replace(/^s:/, "").split(".")[0];
    await admin.query(
      `UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{adminStepUpAt}', to_jsonb('not-a-date'::text))::json WHERE sid = $1`,
      [sid]
    );
    expect((await call("/destructive", signedIn.cookie)).status).toBe(403);
  });

  // ---- ASU4 ---------------------------------------------------------------------------------
  it("ASU4: a PARTNER session cannot satisfy Super Admin step-up", async () => {
    /*
     * The two step-up mechanisms are deliberately separate. A partner who has proved themselves to
     * buy credits must not thereby be able to revoke a station — and the guard keys on `isAdmin`,
     * which a partner session never carries, so it 401s rather than 403s.
     */
    const partner = await call("/sign-in-partner");
    const attempt = await call("/destructive", partner.cookie);
    expect(attempt.status).toBe(401);
  });

  it("ASU4b: a partner step-up stamp on a partner session grants no admin authority", async () => {
    const partner = await call("/sign-in-partner");
    const sid = decodeURIComponent(partner.cookie.split("=")[1]).replace(/^s:/, "").split(".")[0];
    // Even if the partner column's value were somehow copied into the admin key, isAdmin is absent.
    await admin.query(
      `UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{adminStepUpAt}', to_jsonb(now()::text))::json WHERE sid = $1`,
      [sid]
    );
    expect((await call("/destructive", partner.cookie)).status).toBe(401);
  });

  // ---- ASU5: shared, not process-local ------------------------------------------------------
  it("ASU5: the stamp is persisted to the SHARED session store, so a second machine sees it", async () => {
    /*
     * INVARIANT I19. A stamp held in module memory would satisfy every case above and still be
     * wrong: a request landing on the other Fly Machine, or arriving after a rolling deploy, would
     * find no proof. Reading it straight out of the `session` table with an independent connection
     * is how "shared" is actually demonstrated.
     */
    const signedIn = await call("/sign-in");
    await call("/step-up", signedIn.cookie);
    const sid = decodeURIComponent(signedIn.cookie.split("=")[1]).replace(/^s:/, "").split(".")[0];

    const { rows } = await admin.query<{ stamp: string | null }>(
      `SELECT sess::jsonb ->> 'adminStepUpAt' AS stamp FROM "session" WHERE sid = $1`,
      [sid]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stamp, "the stamp is not in the shared store — it must not be process-local").toBeTruthy();
    expect(Number.isNaN(new Date(rows[0].stamp as string).getTime())).toBe(false);
  });

  it("ASU5b: read-only navigation never demands a proof", async () => {
    // Step-up on reads would train an administrator to type their password reflexively, which
    // destroys the signal it exists to create.
    const signedIn = await call("/sign-in");
    expect((await call("/read-only", signedIn.cookie)).status).toBe(200);
  });
});

describe("AG-3b integration surfaces", () => {
  const src = readFileSync("server/lib/admin-step-up.ts", "utf8");
  const stationAdmin = readFileSync("server/partner/station-admin-routes.ts", "utf8");
  const management = readFileSync("server/partner/partner-management-routes.ts", "utf8");
  const dashboard = readFileSync("server/partner/dashboard-routes.ts", "utf8");
  const adminRoutes = readFileSync("server/partner/admin-routes.ts", "utf8");
  const authRoutes = readFileSync("server/routes/auth.ts", "utf8");

  it("every destructive Super Admin action demands a fresh proof", () => {
    const guarded: Array<[string, string]> = [
      [stationAdmin, "/stations/:stationCode/${status.toLowerCase()}"], // approve / suspend / revoke
      [stationAdmin, '"/stations/:stationCode/reject"'],
      [management, '"/partners/:partnerId/users/:userId/role"'],
      [management, '"/partners/:partnerId/users/:userId/status"'],
      [management, '"/partners/:partnerId/users/:userId/password-reset"'],
      [management, '"/partners/:partnerId/users/:userId/reset-mfa"'],
      [management, '"/partners/:partnerId/users/:userId/revoke-sessions"'],
      [management, '"/partners/:partnerId/status"'],
      [dashboard, '"/partners/:partnerId/credits/adjust"'],
      [adminRoutes, '"/:partnerId/emergency-stop"'],
    ];
    for (const [source, path] of guarded) {
      const idx = source.indexOf(path);
      expect(idx, `${path} not found`).toBeGreaterThan(-1);
      const handler = source.indexOf("async (req", idx);
      expect(source.slice(idx, handler), `${path} is not step-up guarded`).toContain("requireAdminStepUp()");
    }
  });

  it("no SECOND admin auth architecture — it reuses the existing session and credentials", () => {
    // The stamp lives on the express session (persisted by connect-pg-simple), not in a new table
    // or a new token, and the verify route reuses the same password + PIN helpers login uses.
    expect(src).toContain("req.session");
    expect(src).not.toMatch(/CREATE TABLE|jsonwebtoken|new Map\(/);
    expect(authRoutes).toContain('app.post("/api/admin/step-up"');
    expect(authRoutes).toContain("verifyAdminPassword(password, adminUser)");
    expect(authRoutes).toContain("verifyPin(pin,");
    // And it is itself Super-Admin gated: a plain admin cannot mint a Super Admin proof.
    const route = authRoutes.slice(authRoutes.indexOf('app.post("/api/admin/step-up"'));
    expect(route.slice(0, 200)).toContain("requireSuperAdmin");
  });

  it("the stamp is NOT process-local — invariant I19", () => {
    // No module-level mutable map holding authority.
    expect(src).not.toMatch(/^const .*= new (Map|Set)\(/m);
    expect(src).toContain("connect-pg-simple");
  });

  it("freshness is decided by PostgreSQL, not by the app clock", () => {
    expect(src).toContain("now() - ($2 || ' minutes')::interval");
    expect(src).toContain("SELECT now() AS now");
  });

  it("the admin window is tighter than the partner window", () => {
    const partnerSrc = readFileSync("server/partner/step-up.ts", "utf8");
    const adminWindow = Number(/ADMIN_STEP_UP_WINDOW_MINUTES = (\d+)/.exec(src)?.[1]);
    const partnerWindow = Number(/STEP_UP_WINDOW_MINUTES = (\d+)/.exec(partnerSrc)?.[1]);
    expect(adminWindow).toBeGreaterThan(0);
    expect(adminWindow).toBeLessThan(partnerWindow);
  });

  it("a step-up attempt is recorded distinctly in the PIN attempt log", () => {
    // "logged in" and "authorised a station revocation" are different events.
    expect(authRoutes).toContain('logPinEvent(adminEmail, true, "admin_step_up", ipH)');
    expect(readFileSync("server/pin.ts", "utf8")).toContain('| "admin_step_up"');
  });

  it("the guarded actions still write their existing audit rows", () => {
    // Step-up is an ADDITIONAL control. It must not have displaced the audit trail.
    expect(management).toContain("mutationResponse");
    expect(adminRoutes).toContain("adminAudit");
    expect(dashboard).toContain("credits/adjust");
  });
});
