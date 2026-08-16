/**
 * P8 — THE OPERATIONAL DASHBOARD READ, proven against real PostgreSQL.
 *
 * WHAT IS ACTUALLY AT RISK HERE. The counts themselves are arithmetic; if a tile is wrong a shop
 * sees the wrong number and complains. The isolation is different in kind: this console shows a
 * paying shop its own money, its own Macs and its own customers' cards, and a leak here is a leak
 * between two businesses that may be competitors on the same high street.
 *
 * So most of this file is negative. Partner A must not see Partner B's counts, stations, locations
 * or FIX items — not filtered out in the browser, but never returned at all. And a location-scoped
 * user must not see the other shop floor of their OWN partner, which is the subtler case AG-1 made
 * reachable and which no amount of tenant scoping catches.
 *
 * A MOCK WOULD PROVE NOTHING: every guarantee under test is a SQL predicate evaluated inside a
 * tenant transaction, plus RLS underneath it.
 *
 * Mutation targets: OPS1 (counts bucketed correctly), OPS2 (cross-tenant returns nothing),
 * OPS3 (location scoping), OPS4 (fleet includes non-ACTIVE stations), OPS5 (readiness is shared).
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
import type { PartnerPrincipal } from "../server/partner/session";

let cluster: DisposablePostgres17;
let admin: Client;
let ops: typeof import("../server/partner/dashboard-operations-service");
let savedEnv: Record<string, string | undefined> = {};

interface Tenant {
  tenantId: string;
  locationA: string;
  locationB: string;
  userId: string;
}

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
  await admin.query(`CREATE TABLE certificates (
    id serial primary key, certificate_number text not null unique,
    card_id integer, submission_item_id integer, deleted_at timestamptz
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

let seq = 0;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function stationCode(): string {
  seq += 1;
  let n = seq;
  let suffix = "";
  do {
    suffix = BASE32[n % 32] + suffix;
    n = Math.floor(n / 32);
  } while (n > 0);
  return `MV-STN-OPS${suffix.padStart(7, "A")}`;
}

async function makeTenant(label: string): Promise<Tenant> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}`, `${label} Ltd`]
    )
  ).rows[0].id;
  const mk = async (ref: string, name: string): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, status)
         VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
        [ref, tenantId, name]
      )
    ).rows[0].id;
  const locationA = await mk(`loc-${label}-a`, "Rochester");
  const locationB = await mk(`loc-${label}-b`, "Bluewater");
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}`, tenantId, `${label}@shop.test`]
    )
  ).rows[0].id;
  return { tenantId, locationA, locationB, userId };
}

/** A Card Job in a chosen lifecycle state. Inserted directly so each bucket can be aimed at. */
async function makeJob(t: Tenant, locationId: string, status: string, tag: string): Promise<void> {
  const submissionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id, location_id, created_by, card_count, status)
       VALUES ($1,$2,$3,1,'draft') RETURNING id`,
      [t.tenantId, locationId, t.userId]
    )
  ).rows[0].id;
  const cardId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, quantity)
       VALUES ($1,$2,1,$3,1) RETURNING id`,
      [t.tenantId, submissionId, `Card ${tag}`]
    )
  ).rows[0].id;
  /*
   * chk_partner_card_jobs_terminal_times (0080) requires completed_at for COMPLETED and
   * cancelled_at for CANCELLED, and forbids either on any other status. Setting them here keeps the
   * fixture inside the real constraint rather than weakening it.
   */
  await admin.query(
    `INSERT INTO partner_card_jobs
       (tenant_id, submission_id, card_id, ordinal, card_reference, location_id, created_by, status,
        completed_at, cancelled_at)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,
             CASE WHEN $7 = 'COMPLETED' THEN now() END,
             CASE WHEN $7 = 'CANCELLED' THEN now() END)`,
    [t.tenantId, submissionId, cardId, `partner-submission-card:${cardId}:1`, locationId, t.userId, status]
  );
}

async function makeStation(
  t: Tenant,
  locationId: string,
  status: string,
  seenMinutesAgo: number | null
): Promise<void> {
  await admin.query(
    `INSERT INTO partner_stations
       (station_code, tenant_id, location_id, status, public_key_pem, public_key_fingerprint,
        last_seen_at, app_version, calibration_status)
     VALUES ($1,$2,$3,$4,'pem',$5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() - ($6 || ' minutes')::interval END,
             '1.2.3','VALID')`,
    [
      stationCode(),
      t.tenantId,
      locationId,
      status,
      `${seq}-${status}-${t.tenantId}`.padEnd(64, "0").slice(0, 64),
      seenMinutesAgo,
    ]
  );
}

/** A principal built the way the session middleware builds one. */
function principalFor(t: Tenant, opts: { orgWide: boolean; locationId?: string | null }): PartnerPrincipal {
  return {
    sessionId: "00000000-0000-0000-0000-0000000000ff",
    tenantId: t.tenantId,
    userId: t.userId,
    locationId: opts.locationId ?? null,
    mfaPassed: true,
    permissions: new Set(["partner.dashboard.view", "partner.cards.view"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: opts.orgWide,
  };
}

describe("P8 partner dashboard operations (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-dashboard-operations");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      "0045_partner_stations",
      "0084_partner_location_management",
    ]);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    ops = await import("../server/partner/dashboard-operations-service");
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

  // ---- OPS1 ---------------------------------------------------------------------------------
  it("OPS1: every lifecycle status lands in exactly one operator-facing bucket", async () => {
    const t = await makeTenant("ops1");
    for (const [status, tag] of [
      ["CREDIT_RESERVED", "a"],
      ["NEEDS_SCAN", "b"],
      ["CAPTURING", "c"],
      ["FIX_REQUIRED", "d"],
      ["READY_TO_GRADE", "e"],
      ["GRADING", "f"],
      ["SUBMITTED", "g"],
      ["QA_REVIEW", "h"],
      ["APPROVED", "i"],
      ["COMPLETED", "j"],
    ] as const) {
      await makeJob(t, t.locationA, status, tag);
    }

    const view = await ops.getPartnerOperations(principalFor(t, { orgWide: true }));
    expect(view.counts.reservedInProgress).toBe(1); // CREDIT_RESERVED
    expect(view.counts.needsScan).toBe(2); // NEEDS_SCAN + CAPTURING
    expect(view.counts.fixRequired).toBe(1);
    expect(view.counts.readyToGrade).toBe(1);
    expect(view.counts.inReview).toBe(3); // GRADING + SUBMITTED + QA_REVIEW
    expect(view.counts.completed).toBe(2); // APPROVED + COMPLETED
  });

  it("OPS1b: a CANCELLED card job is counted nowhere", async () => {
    const t = await makeTenant("ops1b");
    await makeJob(t, t.locationA, "NEEDS_SCAN", "live");
    await makeJob(t, t.locationA, "CANCELLED", "dead");

    const view = await ops.getPartnerOperations(principalFor(t, { orgWide: true }));
    const total =
      view.counts.reservedInProgress +
      view.counts.needsScan +
      view.counts.fixRequired +
      view.counts.readyToGrade +
      view.counts.inReview +
      view.counts.completed;
    expect(total).toBe(1);
  });

  // ---- OPS2: the isolation that matters -----------------------------------------------------
  it("OPS2: Partner A sees NOTHING of Partner B — counts, stations or locations", async () => {
    const a = await makeTenant("ops2a");
    const b = await makeTenant("ops2b");
    for (let i = 0; i < 4; i += 1) await makeJob(b, b.locationA, "NEEDS_SCAN", `b${i}`);
    await makeStation(b, b.locationA, "ACTIVE", 1);
    await makeJob(a, a.locationA, "NEEDS_SCAN", "a0");
    await makeStation(a, a.locationA, "ACTIVE", 1);

    const view = await ops.getPartnerOperations(principalFor(a, { orgWide: true }));
    expect(view.counts.needsScan).toBe(1); // A's single card, not B's four
    expect(view.stations).toHaveLength(1);
    // B's locations must not appear at all — not merely be filtered later.
    const locationIds = view.locations.map((l) => l.id);
    expect(locationIds).toContain(a.locationA);
    expect(locationIds).not.toContain(b.locationA);
    expect(locationIds).not.toContain(b.locationB);
  });

  // ---- OPS3: location scoping ---------------------------------------------------------------
  it("OPS3: a location-scoped user sees only their own shop floor, not the partner's other one", async () => {
    /*
     * The subtler leak AG-1 made reachable: same tenant, different branch. Tenant scoping alone
     * does not catch it, and a browser-side filter would be a display convention rather than a
     * boundary.
     */
    const t = await makeTenant("ops3");
    await makeJob(t, t.locationA, "NEEDS_SCAN", "rochester");
    await makeJob(t, t.locationB, "NEEDS_SCAN", "bluewater1");
    await makeJob(t, t.locationB, "NEEDS_SCAN", "bluewater2");
    await makeStation(t, t.locationA, "ACTIVE", 1);
    await makeStation(t, t.locationB, "ACTIVE", 1);

    const scoped = await ops.getPartnerOperations(principalFor(t, { orgWide: false, locationId: t.locationA }));
    expect(scoped.locationScoped).toBe(true);
    expect(scoped.counts.needsScan).toBe(1);
    expect(scoped.stations).toHaveLength(1);
    expect(scoped.locations.map((l) => l.id)).toEqual([t.locationA]);

    // The owner of the same shop sees the whole estate — confining them would be a different bug.
    const orgWide = await ops.getPartnerOperations(principalFor(t, { orgWide: true, locationId: t.locationA }));
    expect(orgWide.locationScoped).toBe(false);
    expect(orgWide.counts.needsScan).toBe(3);
    expect(orgWide.stations).toHaveLength(2);
    expect(orgWide.locations).toHaveLength(2);
  });

  // ---- OPS4: the fleet view differs from the arming picker on purpose ------------------------
  it("OPS4: the fleet shows PENDING, SUSPENDED and REVOKED stations, not just ACTIVE ones", async () => {
    /*
     * listPartnerCaptureStations returns ACTIVE only, because offering a revoked Mac in an arming
     * picker would be a bug. A fleet view has the opposite requirement: the shop needs to see the
     * Mac that stopped working, and its status is the answer.
     */
    const t = await makeTenant("ops4");
    await makeStation(t, t.locationA, "ACTIVE", 1);
    await makeStation(t, t.locationA, "PENDING", null);
    await makeStation(t, t.locationA, "SUSPENDED", 30);
    await makeStation(t, t.locationA, "REVOKED", 120);

    const view = await ops.getPartnerOperations(principalFor(t, { orgWide: true }));
    expect(view.stations).toHaveLength(4);
    expect(new Set(view.stations.map((s) => s.status))).toEqual(new Set(["ACTIVE", "PENDING", "SUSPENDED", "REVOKED"]));
  });

  it("OPS4b: readiness is the SERVER's verdict — stale, uncalibrated or non-ACTIVE is not ready", async () => {
    const t = await makeTenant("ops4b");
    await makeStation(t, t.locationA, "ACTIVE", 1); // fresh + calibrated
    await makeStation(t, t.locationA, "ACTIVE", 60); // stale heartbeat
    await makeStation(t, t.locationA, "SUSPENDED", 1); // fresh but not active
    await admin.query(
      `UPDATE partner_stations SET calibration_status='INVALID'
                        WHERE tenant_id=$1 AND status='ACTIVE' AND last_seen_at < now() - interval '30 minutes'`,
      [t.tenantId]
    );

    const view = await ops.getPartnerOperations(principalFor(t, { orgWide: true }));
    expect(view.stations.filter((s) => s.ready)).toHaveLength(1);
  });

  it("OPS4c: a station that has NEVER been seen is not ready, and does not read as recent", async () => {
    const t = await makeTenant("ops4c");
    await makeStation(t, t.locationA, "ACTIVE", null);
    const view = await ops.getPartnerOperations(principalFor(t, { orgWide: true }));
    expect(view.stations[0].lastSeenAt).toBeNull();
    expect(view.stations[0].ready).toBe(false);
  });

  it("OPS5: locations carry a station count, and a REVOKED station is not counted", async () => {
    const t = await makeTenant("ops5");
    await makeStation(t, t.locationA, "ACTIVE", 1);
    await makeStation(t, t.locationA, "SUSPENDED", 1);
    await makeStation(t, t.locationA, "REVOKED", 1);

    const view = await ops.getPartnerOperations(principalFor(t, { orgWide: true }));
    const rochester = view.locations.find((l) => l.id === t.locationA);
    // A revoked station is gone as far as capacity planning is concerned.
    expect(rochester?.stationCount).toBe(2);
  });

  it("OPS6: an empty partner reports zeroes, not an error and not nulls", async () => {
    const t = await makeTenant("ops6");
    const view = await ops.getPartnerOperations(principalFor(t, { orgWide: true }));
    expect(view.counts).toEqual({
      reservedInProgress: 0,
      needsScan: 0,
      fixRequired: 0,
      readyToGrade: 0,
      inReview: 0,
      completed: 0,
    });
    expect(view.stations).toEqual([]);
    expect(view.locations).toHaveLength(2);
  });
});

describe("P8 integration surfaces", () => {
  const dashboard = readFileSync("client/src/pages/partner/dashboard.tsx", "utf8");
  const routes = readFileSync("server/partner/routes.ts", "utf8");
  const service = readFileSync("server/partner/dashboard-operations-service.ts", "utf8");
  const app = readFileSync("client/src/App.tsx", "utf8");

  it("extends the EXISTING dashboard — there is no Dashboard V2", () => {
    // One partner dashboard page, registered once.
    expect(app).toContain('path="/partner/dashboard"');
    expect(app).not.toMatch(/dashboard-v2|DashboardV2|partner\/dashboard2/i);
    // The new sections live in the same file as the pre-existing ones.
    expect(dashboard).toContain('id="credit-summary-title"'); // pre-existing
    expect(dashboard).toContain('id="operations-title"'); // P8
  });

  it("renders every required operational figure", () => {
    /*
     * The testids are built as `text-ops-${id}`, so the rendered strings do not appear literally in
     * source. Assert the template AND each id — matching the rendered form here would silently pass
     * only if someone hard-coded them, which is the opposite of what this file wants.
     */
    expect(dashboard).toContain("text-ops-${id}");
    for (const [label, id] of [
      ["Reserved / in progress", '"reserved"'],
      ["Needs scan", '"needs-scan"'],
      ["FIX required", '"fix-required"'],
      ["Ready to grade", '"ready-to-grade"'],
      ["In review", '"in-review"'],
      ["Completed", '"completed"'],
    ]) {
      expect(dashboard, `${label} tile missing`).toContain(label);
      expect(dashboard, `${id} tile id missing`).toContain(id);
    }
  });

  it("offers the four primary actions", () => {
    for (const id of ["action-scan-new-card", "action-buy-credits", "action-fix-queue", "action-ready-to-grade"]) {
      expect(dashboard, `${id} missing`).toContain(id);
    }
  });

  it("states plainly that a FIX changes neither the MV, the certificate nor the credit", () => {
    const flat = dashboard.replace(/\s+/g, " ");
    expect(flat).toContain("Fixing a card costs no Grading Credits");
    expect(flat).toMatch(/keeps its MV number, its certificate and the credit already paid for it/);
  });

  it("scopes SERVER-SIDE — no tenant or location filtering in the browser", () => {
    // The service applies the predicate in SQL, from the principal.
    expect(service).toContain("WHERE tenant_id = $1");
    expect(service).toContain("principal.orgWide ? null : principal.locationId");
    // And the page never filters a list by tenant or location itself.
    expect(dashboard).not.toMatch(/\.filter\([^)]*tenantId/);
    expect(dashboard).not.toMatch(/\.filter\([^)]*locationId/);
  });

  it("the route takes nothing from the request", () => {
    const idx = routes.indexOf('"/dashboard/operations"');
    expect(idx).toBeGreaterThan(-1);
    const handler = routes.slice(idx, routes.indexOf("});", idx));
    expect(handler).toContain("getPartnerOperations(req.partner!)");
    expect(handler).not.toMatch(/req\.(query|body|params)/);
  });

  it("readiness reuses the Super Admin computation rather than a second one", () => {
    // Two definitions of "is this shop set up" would drift, which is the failure the original was
    // written to end.
    expect(routes).toContain("getPartnerOnboardingReadiness(req.partner!.tenantId)");
    expect(dashboard).toContain("READINESS_COPY");
    for (const state of [
      "INVITED",
      "AWAITING_PASSWORD_SETUP",
      "AWAITING_MFA_SETUP",
      "STATION_SETUP_REQUIRED",
      "READY_TO_LOG_IN",
      "LOGIN_BLOCKED",
      "SUSPENDED",
      "REVOKED",
    ]) {
      expect(dashboard, `readiness state ${state} not surfaced`).toContain(state);
    }
  });

  it("no hard-coded 'Main location' assumption survives in the UI", () => {
    /*
     * Strips BLOCK comments as well as line comments. The explanatory comment above the Locations
     * section names "Main location" in order to say the assumption is gone, and a line-based filter
     * misses its continuation lines — so asserting against raw source would fail on the very prose
     * documenting the fix.
     */
    const code = dashboard
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toContain("Main location");
    expect(code).toContain("list-locations");
    // Locations come from the server as a list — never a single assumed one.
    expect(code).toContain("operations.data.locations.map");
  });

  it("wide content scrolls inside its own container rather than breaking the page", () => {
    // The station table is the one genuinely wide element; a shop console gets used on a laptop
    // and sometimes a tablet.
    expect(dashboard).toContain('data-testid="table-stations-wrap"');
    const wrap = dashboard.slice(dashboard.indexOf('data-testid="table-stations-wrap"') - 200);
    expect(wrap.slice(0, 260)).toContain("overflow-x-auto");
  });

  it("the browser never recomputes station readiness", () => {
    // The server decides; the console renders. Otherwise the two can disagree about whether a Mac
    // can work, and the operator believes the wrong one.
    expect(dashboard).toContain("station.ready");
    expect(dashboard).not.toMatch(/calibrationStatus === "VALID"/);
  });
});
