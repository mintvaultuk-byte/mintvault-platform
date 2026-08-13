/**
 * AG-3 — STEP-UP AUTHENTICATION, proven against real PostgreSQL.
 *
 * THE PROBLEM. The only re-authentication anywhere in the partner system was verifyPassword(),
 * wired exclusively into the four MFA credential routes. Everything else rode a plain session:
 * buying Grading Credits, changing a colleague's role, inviting or removing staff, revoking
 * sessions. A browser left open at the counter was enough to spend the shop's money.
 *
 * THE TWO PROPERTIES THAT MATTER, AND WHY BOTH NEED A DATABASE:
 *
 *   1. The proof EXPIRES. A boolean cannot; the whole point is that authority granted at 09:00 is
 *      gone by the afternoon. The window is evaluated by PostgreSQL (`now() - interval`), so this
 *      can only be tested against a real clock and a real row.
 *   2. It FAILS CLOSED. A session that has never stepped up — which is every session that existed
 *      before the column — must read as un-proved. Backfilling to now() would have silently handed
 *      every open session a free pass at deploy time.
 *
 * WHAT IS DELIBERATELY NOT PROTECTED. Scanning. NEW and FIX capture are the high-frequency path and
 * a shift must stay fast; asking for a password between cards would be worked around by never
 * logging out, which is strictly worse than the risk. Those paths already carry an approved
 * station's signature AND an MFA-passed operator on every request. The last case in this file pins
 * that so a later "consistency" edit cannot quietly slow the shop floor down.
 *
 * Mutation targets: SU1 (fresh proof passes), SU2 (expired proof fails), SU3 (never-stepped-up
 * fails closed), SU4 (revoked session fails), SU5 (capture path stays free of step-up).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let stepUp: typeof import("../server/partner/step-up");
let savedEnv: Record<string, string | undefined> = {};

let tenantId = "";
let userId = "";

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/** A session row, created directly so the test owns its timestamps. */
async function makeSession(label: string, stepUpAt: string | null): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO partner_sessions
       (tenant_id, user_id, token_hash, credential_version, mfa_passed, absolute_expires_at, last_step_up_at)
     VALUES ($1,$2,$3,1,true, now() + interval '12 hours', $4::timestamptz)
     RETURNING id`,
    [tenantId, userId, `hash-${label}`, stepUpAt]
  );
  return rows[0].id;
}

describe("AG-3 step-up authentication (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-step-up-auth");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      "0086_partner_session_step_up",
    ]);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    stepUp = await import("../server/partner/step-up");

    tenantId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ('ref-su','SU Ltd','ACTIVE') RETURNING id`
      )
    ).rows[0].id;
    userId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
         VALUES ('usr-su',$1,$1,'su@shop.test','ACTIVE') RETURNING id`,
        [tenantId]
      )
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("SU1: a proof given moments ago is accepted", async () => {
    const sessionId = await makeSession("fresh", null);
    await stepUp.recordStepUp(sessionId);
    expect(await stepUp.hasRecentStepUp(sessionId)).toBe(true);
  });

  it("SU2: the proof EXPIRES — this is the whole point of a timestamp over a flag", async () => {
    // 16 minutes ago, against a 15-minute window.
    const sessionId = await makeSession("stale", null);
    const stale = await admin.query<{ id: string }>(
      `UPDATE partner_sessions SET last_step_up_at = now() - interval '16 minutes' WHERE id=$1 RETURNING id`,
      [sessionId]
    );
    expect(stale.rowCount).toBe(1);
    expect(await stepUp.hasRecentStepUp(sessionId)).toBe(false);
  });

  it("SU2b: a proof just inside the window is still accepted", async () => {
    const sessionId = await makeSession("edge", null);
    await admin.query(`UPDATE partner_sessions SET last_step_up_at = now() - interval '14 minutes' WHERE id=$1`, [
      sessionId,
    ]);
    expect(await stepUp.hasRecentStepUp(sessionId)).toBe(true);
  });

  it("SU3: a session that has NEVER stepped up fails closed", async () => {
    /*
     * Every session that existed before migration 0086 is in exactly this state. If NULL read as
     * "recent", the deployment itself would have handed every open browser a free pass.
     */
    const sessionId = await makeSession("never", null);
    const row = await admin.query<{ last_step_up_at: string | null }>(
      `SELECT last_step_up_at FROM partner_sessions WHERE id=$1`,
      [sessionId]
    );
    expect(row.rows[0].last_step_up_at).toBeNull();
    expect(await stepUp.hasRecentStepUp(sessionId)).toBe(false);
  });

  it("SU4: a REVOKED session cannot hold a valid proof", async () => {
    const sessionId = await makeSession("revoked", null);
    await stepUp.recordStepUp(sessionId);
    expect(await stepUp.hasRecentStepUp(sessionId)).toBe(true);

    await admin.query(`UPDATE partner_sessions SET revoked_at = now() WHERE id=$1`, [sessionId]);
    expect(await stepUp.hasRecentStepUp(sessionId)).toBe(false);
  });

  it("SU4b: recordStepUp refuses to stamp a revoked session", async () => {
    const sessionId = await makeSession("revoked2", null);
    await admin.query(`UPDATE partner_sessions SET revoked_at = now() WHERE id=$1`, [sessionId]);
    await stepUp.recordStepUp(sessionId);
    const row = await admin.query<{ last_step_up_at: string | null }>(
      `SELECT last_step_up_at FROM partner_sessions WHERE id=$1`,
      [sessionId]
    );
    expect(row.rows[0].last_step_up_at).toBeNull();
  });

  it("SU4c: an unknown session id fails closed rather than erroring open", async () => {
    const unknown = (await admin.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    expect(await stepUp.hasRecentStepUp(unknown)).toBe(false);
  });

  it("the window is evaluated by PostgreSQL, so a skewed app clock cannot widen it", async () => {
    const source = readFileSync("server/partner/step-up.ts", "utf8");
    expect(source).toContain("now() - ($2 || ' minutes')::interval");
    // No Date arithmetic deciding freshness in application code.
    expect(source).not.toMatch(/Date\.now\(\)\s*-\s*.*windowMinutes/);
  });
});

describe("AG-3 integration surfaces", () => {
  const routes = readFileSync("server/partner/routes.ts", "utf8");
  const stationRoutes = readFileSync("server/partner/station-routes.ts", "utf8");
  const stepUpSrc = readFileSync("server/partner/step-up.ts", "utf8");
  const mfaService = readFileSync("server/partner/mfa-service.ts", "utf8");
  const migration = readFileSync("migrations/0086_partner_session_step_up.sql", "utf8");

  /**
   * Every high-risk partner action that must demand a recent proof.
   *
   * Anchored on the ROUTE REGISTRATION, not on the path string alone: `"/users"` appears first as
   * the GET listing, which must NOT be step-up guarded (reading the staff list is not high risk),
   * so matching the bare string would have asserted against the wrong route and passed for the
   * wrong reason.
   */
  const PROTECTED = [
    'r.post(\n    "/credits/checkout"',
    'r.post(\n    "/users",',
    'r.post(\n    "/users/:id/role"',
    'r.post(\n    "/users/:id/status"',
    'r.post(\n    "/users/:id/revoke-sessions"',
  ];

  it("every high-risk partner action demands a recent proof", () => {
    for (const anchor of PROTECTED) {
      const idx = routes.indexOf(anchor);
      expect(idx, `${anchor} not found`).toBeGreaterThan(-1);
      const segment = routes.slice(idx, routes.indexOf("async (req, res)", idx));
      expect(segment, `${anchor} is not step-up guarded`).toContain("requireRecentAuth()");
    }
  });

  it("READING the staff list is NOT step-up guarded — only mutations are", () => {
    const idx = routes.indexOf('r.get("/users"');
    expect(idx).toBeGreaterThan(-1);
    const segment = routes.slice(idx, routes.indexOf("async (req, res)", idx));
    expect(segment).not.toContain("requireRecentAuth");
  });

  it("SU5: the CAPTURE path is deliberately free of step-up so a shift stays fast", () => {
    /*
     * The locked requirement: do not require MFA before every scan/card. These routes already carry
     * two independent proofs per request — an approved station's Ed25519 signature and an
     * MFA-passed operator session — and adding a password prompt between cards would be worked
     * around by never signing out, which is worse than the risk it closes.
     */
    for (const path of ['"/card-jobs"', '"/stations/fix-queue"', '"/card-jobs/:cardJobId/fix-authorise"']) {
      const idx = stationRoutes.indexOf(path);
      expect(idx, `${path} not found`).toBeGreaterThan(-1);
      const segment = stationRoutes.slice(idx, stationRoutes.indexOf("async (req, res)", idx));
      expect(segment, `${path} must NOT require step-up`).not.toContain("requireRecentAuth");
    }
  });

  it("step-up is placed AFTER the capability guard, never before it", () => {
    // A user who may NEVER buy credits should be told that, not asked for a password first.
    const checkout = routes.slice(routes.indexOf('r.post(\n    "/credits/checkout"'));
    const segment = checkout.slice(0, checkout.indexOf("async (req, res)"));
    expect(segment.indexOf('requirePartnerCapability("partner.credits.purchase")')).toBeLessThan(
      segment.indexOf("requireRecentAuth()")
    );
  });

  it("the proof demands password AND the current second factor when one is enrolled", () => {
    expect(mfaService).toContain("export async function verifyStepUp");
    const fn = mfaService.slice(mfaService.indexOf("export async function verifyStepUp"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("verifyPassword");
    expect(body).toContain("second_factor_required");
    expect(body).toContain("verifySecondFactor");
  });

  it("only the step-up route can stamp a session", () => {
    // If anything else could write the column, the mechanism would be decorative.
    expect(routes).toContain("recordStepUp(principal.sessionId)");
    for (const src of [readFileSync("server/partner/card-job-authority.ts", "utf8"), stationRoutes]) {
      expect(src).not.toContain("recordStepUp");
      expect(src).not.toContain("last_step_up_at");
    }
  });

  it("step-up answers 403, not 401 — the session is valid, it just needs re-confirming", () => {
    expect(stepUpSrc).toContain("STEP_UP_REQUIRED_CODE");
    expect(stepUpSrc).toContain("res.status(403)");
    expect(stepUpSrc).not.toMatch(/res\.status\(401\)[\s\S]{0,200}step_up_required/);
  });

  it("the migration refuses to backfill the stamp", () => {
    expect(migration).toContain("must not backfill last_step_up_at");
    expect(migration).toContain("must be nullable so an un-stepped-up session fails closed");
  });
});
