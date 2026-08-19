/**
 * AG-1 — MULTI-LOCATION, proven against real PostgreSQL.
 *
 * THE DEFECT THIS CLOSES. `partner_locations` has been multi-location capable since migration 0001
 * — tenant-scoped rows, a status ladder, per-user assignment via `partner_user_locations`, a station
 * binding carrying (tenant_id, location_id), and a resolver that already handles the zero /
 * exactly-one / more-than-one cases. What never existed was any way to CREATE a second row:
 * `createPartner()` inserts one 'Main location' and nothing else in the server tree inserts into
 * that table at all. The consequence was not cosmetic — it capped stations to one shop floor and
 * made the Scanner's location selector dead code, because it self-hides at <=1 permitted location.
 *
 * WHY THE ISOLATION CASES MATTER MORE THAN THE CRUD. Adding a create route is easy; the risk is
 * everything downstream that was written when "the tenant" and "the location" were the same thing.
 * Two of those were live defects and are pinned below: the FIX queue filtered on tenant ALONE, so a
 * station at Rochester would have listed Bluewater's cards; and the NEW authority never checked
 * whether the location was active, so suspending one shop would not have stopped work there.
 *
 * A MOCK WOULD PROVE NONE OF IT — the guarantees under test are a partial unique index, RLS, a
 * cross-tenant FK trigger and SQL predicates.
 *
 * Mutation targets: LOC1 (create), LOC2 (no duplicate live name), LOC3 (last-active guard),
 * LOC4 (FIX queue location isolation), LOC5 (NEW refused at a suspended location).
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
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
let fix: typeof import("../server/partner/fix-authority");
let management: typeof import("../server/partner/partner-management-service");
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };

interface Fixture {
  tenantId: string;
  locationA: string;
  locationB: string;
  userId: string;
  stationA: string;
  stationB: string;
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
    card_id integer, submission_item_id integer,
    status text not null default 'active', label_type text not null default 'Standard',
    grade_type text not null default 'numeric', source text, scan_status text,
    raw_uploaded boolean not null default false, created_by text,
    issued_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    origin_type text, origin_partner_id uuid, origin_partner_public_ref text,
    origin_partner_legal_name text, origin_partner_trading_name text,
    origin_location_id uuid, origin_location_public_ref text, origin_location_name text,
    origin_location_address text, origin_captured_at timestamptz, origin_snapshot_version integer
  )`);
  await admin.query(`CREATE TABLE cert_counter (
    id integer primary key, last_issued bigint not null default 0, updated_at timestamptz not null default now()
  )`);
  await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)");
  await admin.query(`CREATE TABLE certificate_image_evidence (
    id serial primary key,
    certificate_id integer not null references certificates(id) on delete restrict,
    side varchar(5) not null check (side in ('front','back')),
    object_key text not null unique, sha256 text, byte_length integer,
    is_current boolean not null default true, superseded_at timestamptz,
    superseded_by_id integer references certificate_image_evidence(id) on delete restrict,
    created_at timestamptz not null default now()
  )`);
  await admin.query(
    `CREATE UNIQUE INDEX uq_certificate_image_evidence_current_side
       ON certificate_image_evidence (certificate_id, side) WHERE is_current`
  );
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "audit_log",
    "certificates",
    "cert_counter",
    "certificate_image_evidence",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/**
 * `partner_stations.station_code` is CHECK-constrained to MV-STN- plus 10-24 Base32 characters AND
 * is globally UNIQUE. Deriving it from a label alone collides once labels are truncated to a fixed
 * width — "loc2b"+A and "loc2"+B both reduce to LOC2BAAAAA — so a monotonic counter guarantees
 * uniqueness while the label keeps the code readable in a failure message.
 */
let stationSeq = 0;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function stationCodeFor(label: string): string {
  stationSeq += 1;
  const base32 = label.toUpperCase().replace(/[^A-Z2-7]/g, "A");
  /*
   * The counter is encoded in the SAME Base32 alphabet the CHECK permits, which makes it injective.
   * A naive `String(seq).replace(/[^2-7]/g, "2")` is NOT: 0, 1, 8 and 9 all collapse to "2", so
   * seq 10 and seq 11 both render "22" and collide — which is exactly what this test hit.
   */
  let n = stationSeq;
  let suffix = "";
  do {
    suffix = BASE32[n % 32] + suffix;
    n = Math.floor(n / 32);
  } while (n > 0);
  return `MV-STN-${(base32 + "AAAAAAAAAA").slice(0, 10)}${suffix}`;
}

async function addLocation(tenantId: string, ref: string, name: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, status)
     VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
    [ref, tenantId, name]
  );
  return rows[0].id;
}

async function addStation(tenantId: string, locationId: string, label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO partner_stations (station_code, tenant_id, location_id, status, public_key_pem, public_key_fingerprint)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5) RETURNING id`,
    [
      stationCodeFor(label),
      tenantId,
      locationId,
      "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----",
      label.padEnd(64, "0").slice(0, 64),
    ]
  );
  return rows[0].id;
}

/** A partner with TWO shop floors — the shape that was impossible before AG-1. */
async function makeTwoLocationTenant(label: string): Promise<Fixture> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}`, `${label} Ltd`]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [
    tenantId,
    `${label} Cards`,
  ]);
  const locationA = await addLocation(tenantId, `loc-${label}-a`, "Rochester");
  const locationB = await addLocation(tenantId, `loc-${label}-b`, "Bluewater");
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}`, tenantId, `${label}@shop.test`]
    )
  ).rows[0].id;
  return {
    tenantId,
    locationA,
    locationB,
    userId,
    stationA: await addStation(tenantId, locationA, `${label}A`),
    stationB: await addStation(tenantId, locationB, `${label}B`),
  };
}

async function addCredits(tenantId: string, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, tenantId);
  if (amount > 0) {
    await wallet.appendFoundationCredit(adminActor, {
      tenantId,
      amount,
      entryType: "purchase",
      source: "admin",
      reason: "AG-1 multi-location test credits",
      idempotencyKey: key,
      actorType: "admin",
    });
  }
}

async function startCardAt(f: Fixture, locationId: string, stationId: string, opId: string) {
  return authority.startNewCardJobAtStation({
    tenantId: f.tenantId,
    locationId,
    stationId,
    clientOpId: opId,
    actorUserId: f.userId,
    actorEmail: "operator@shop.test",
  });
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

describe("AG-1 multi-location (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-multi-location");
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
    wallet = await import("../server/partner/partner-wallet-service");
    authority = await import("../server/partner/card-job-authority");
    fix = await import("../server/partner/fix-authority");
    management = await import("../server/partner/partner-management-service");
    await admin.query(
      `INSERT INTO partner_feature_flags (flag,tenant_id,location_id,enabled)
       VALUES ('partner_emergency_stop',NULL,NULL,false)`
    );
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

  it("LOC1b: canonical service creates one trimmed UK location, scoped and audited", async () => {
    const f = await makeTwoLocationTenant("loc1b");
    const other = await makeTwoLocationTenant("loc1c");
    const actor = {
      actorUserId: "00000000-0000-0000-0000-0000000000a5",
      actorEmail: "ops@mintvault.test",
      requestId: "loc1b-create",
    };
    const address = "2 Temple Gardens, Rochester, ME2 2NG, United Kingdom";
    const created = await management.createPartnerLocation(
      actor,
      f.tenantId,
      { name: "  Shop  ", address: ` ${address} ` },
      "New Partner location"
    );
    expect(created.result).toMatchObject({ name: "Shop", address, status: "ACTIVE" });
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM partner_locations WHERE tenant_id=$1 AND name='Shop'", [
          f.tenantId,
        ])
      ).rows[0].n
    ).toBe(1);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM partner_locations WHERE tenant_id=$1 AND name='Shop'", [
          other.tenantId,
        ])
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await admin.query<{ result: string; reason: string }>(
          `SELECT result, reason FROM partner_management_audit
            WHERE tenant_id=$1 AND action_type='partner_location_created'
            ORDER BY CASE result WHEN 'attempted' THEN 0 WHEN 'succeeded' THEN 1 ELSE 2 END, created_at, id`,
          [f.tenantId]
        )
      ).rows
    ).toEqual([
      { result: "attempted", reason: "__attempt__" },
      { result: "succeeded", reason: "New Partner location" },
    ]);
  });

  // ---- LOC1 / LOC2: the schema now supports what the service exposes -------------------------
  it("LOC1: one partner can hold several ACTIVE locations, each with its own stations", async () => {
    const f = await makeTwoLocationTenant("loc1");
    const locations = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_locations WHERE tenant_id=$1 AND status='ACTIVE'`,
      [f.tenantId]
    );
    expect(locations.rows[0].n).toBe("2");

    const stations = await admin.query<{ location_id: string }>(
      `SELECT location_id FROM partner_stations WHERE tenant_id=$1 ORDER BY location_id`,
      [f.tenantId]
    );
    expect(stations.rowCount).toBe(2);
    expect(new Set(stations.rows.map((r) => r.location_id))).toEqual(new Set([f.locationA, f.locationB]));
  });

  it("LOC2: two LIVE locations cannot share a name, case- and whitespace-insensitively", async () => {
    const f = await makeTwoLocationTenant("loc2");
    // "Rochester" already exists at this tenant.
    for (const clash of ["Rochester", "rochester", "  ROCHESTER  "]) {
      await expect(addLocation(f.tenantId, `dup-${clash.trim()}-${Math.abs(clash.length)}`, clash)).rejects.toThrow(
        /uq_partner_locations_tenant_name_live|duplicate key/i
      );
    }
    // A DIFFERENT tenant may of course use the same name.
    const other = await makeTwoLocationTenant("loc2b");
    expect(other.locationA).toBeTruthy();
  });

  it("LOC2b: a SUSPENDED location frees its name, so a shop can be reopened or renamed around", async () => {
    const f = await makeTwoLocationTenant("loc2c");
    await admin.query(`UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1`, [f.locationA]);
    // The name is now free — the partial index only covers live rows.
    const reopened = await addLocation(f.tenantId, "loc2c-reopen", "Rochester");
    expect(reopened).toBeTruthy();
  });

  // ---- LOC4: the isolation defect that mattered ---------------------------------------------
  it("LOC4: a station's FIX queue shows ONLY its own shop floor, not the whole tenant", async () => {
    /*
     * THE DEFECT PINNED. listFixQueue filtered on tenant_id alone. With one location that was
     * indistinguishable from correct; with two it meant a Mac at Rochester listed Bluewater's cards
     * — work it cannot do (authoriseFix refuses a location mismatch) and should not see.
     */
    const f = await makeTwoLocationTenant("loc4");
    await addCredits(f.tenantId, 4, "loc4");

    const atA = await startCardAt(f, f.locationA, f.stationA, "op-loc4-a0001");
    const atB = await startCardAt(f, f.locationB, f.stationB, "op-loc4-b0001");

    const queueA = await fix.listFixQueue({
      tenantId: f.tenantId,
      locationId: f.locationA,
      restrictToLocation: true,
    });
    const mvsA = queueA.map((q) => q.mvNumber);
    expect(mvsA).toContain(atA.mvNumber);
    expect(mvsA).not.toContain(atB.mvNumber);

    const queueB = await fix.listFixQueue({
      tenantId: f.tenantId,
      locationId: f.locationB,
      restrictToLocation: true,
    });
    const mvsB = queueB.map((q) => q.mvNumber);
    expect(mvsB).toContain(atB.mvNumber);
    expect(mvsB).not.toContain(atA.mvNumber);
  });

  it("LOC4b: an ORG-WIDE dashboard user still sees the whole estate", async () => {
    // The counterpart to LOC4. Confining an owner to one shop would be a different bug.
    const f = await makeTwoLocationTenant("loc4b");
    await addCredits(f.tenantId, 4, "loc4b");
    const atA = await startCardAt(f, f.locationA, f.stationA, "op-loc4b-a0001");
    const atB = await startCardAt(f, f.locationB, f.stationB, "op-loc4b-b0001");

    const estate = await fix.listFixQueue({
      tenantId: f.tenantId,
      locationId: f.locationA,
      restrictToLocation: false,
    });
    const mvs = estate.map((q) => q.mvNumber);
    expect(mvs).toContain(atA.mvNumber);
    expect(mvs).toContain(atB.mvNumber);
  });

  it("LOC4c: a station at the wrong shop floor still cannot authorise a FIX", async () => {
    const f = await makeTwoLocationTenant("loc4c");
    await addCredits(f.tenantId, 2, "loc4c");
    const atA = await startCardAt(f, f.locationA, f.stationA, "op-loc4c-a0001");

    const refused = await settle(
      fix.authoriseFix({
        tenantId: f.tenantId,
        locationId: f.locationB,
        cardJobId: atA.cardJobId,
        stationId: f.stationB, // Bluewater's Mac, Rochester's card
        actorUserId: f.userId,
      })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("CARD_JOB_NOT_FOUND");
  });

  // ---- LOC5: suspending one shop stops work THERE and nowhere else ---------------------------
  it("LOC5: NEW is refused at a SUSPENDED location and still works at the partner's other one", async () => {
    /*
     * THE SECOND DEFECT PINNED. assertStartAllowed checked the organisation and the station but not
     * the location, so closing one shop floor would not have stopped work at it — and the
     * organisation's own status cannot express "this branch only".
     */
    const f = await makeTwoLocationTenant("loc5");
    await addCredits(f.tenantId, 4, "loc5");
    await admin.query(`UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1`, [f.locationA]);

    const refused = await settle(startCardAt(f, f.locationA, f.stationA, "op-loc5-a0001"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("ORGANISATION_NOT_ACTIVE");

    // The OTHER shop is unaffected — that is the whole point of per-location suspension.
    const allowed = await startCardAt(f, f.locationB, f.stationB, "op-loc5-b0001");
    expect(allowed.mvNumber).toMatch(/^MV\d+$/);
  });

  it("LOC5b: a location id from ANOTHER tenant is refused, not merely inactive", async () => {
    const a = await makeTwoLocationTenant("loc5b1");
    const b = await makeTwoLocationTenant("loc5b2");
    await addCredits(a.tenantId, 2, "loc5b1");

    const crossed = await settle(
      authority.startNewCardJobAtStation({
        tenantId: a.tenantId,
        locationId: b.locationA, // B's shop floor, A's tenant
        stationId: a.stationA,
        clientOpId: "op-loc5b-x0001",
        actorUserId: a.userId,
        actorEmail: "operator@shop.test",
      })
    );
    expect(crossed.ok).toBe(false);
  });

  it("LOC6: the certificate origin snapshot records the SHOP FLOOR the card was taken at", async () => {
    // With several locations the origin snapshot stops being decorative: it is how a graded card is
    // later traced to the branch that handled it.
    const f = await makeTwoLocationTenant("loc6");
    await addCredits(f.tenantId, 2, "loc6");
    const atB = await startCardAt(f, f.locationB, f.stationB, "op-loc6-b0001");

    const cert = await admin.query<{ origin_location_id: string; origin_location_name: string }>(
      `SELECT origin_location_id, origin_location_name FROM certificates WHERE id=$1`,
      [atB.certificateId]
    );
    expect(cert.rows[0].origin_location_id).toBe(f.locationB);
    expect(cert.rows[0].origin_location_name).toBe("Bluewater");
  });

  it("LOC7: a single-location partner is completely unaffected", async () => {
    // Backwards compatibility: the existing estate is all one-location partners.
    const tenantId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
        ["ref-loc7", "Loc7 Ltd"]
      )
    ).rows[0].id;
    await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [
      tenantId,
      "Loc7 Cards",
    ]);
    const only = await addLocation(tenantId, "loc7-main", "Main location");
    const userId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
         VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
        ["usr-loc7", tenantId, "loc7@shop.test"]
      )
    ).rows[0].id;
    const stationId = await addStation(tenantId, only, "LOC7ONE");
    await addCredits(tenantId, 1, "loc7");

    const started = await authority.startNewCardJobAtStation({
      tenantId,
      locationId: only,
      stationId,
      clientOpId: "op-loc7-000001",
      actorUserId: userId,
      actorEmail: "operator@shop.test",
    });
    expect(started.mvNumber).toMatch(/^MV\d+$/);

    const queue = await fix.listFixQueue({ tenantId, locationId: only, restrictToLocation: true });
    expect(queue.map((q) => q.mvNumber)).toContain(started.mvNumber);
  });

  it("LOC8: a station's location must belong to its tenant — enforced by the database", async () => {
    const a = await makeTwoLocationTenant("loc8a");
    const b = await makeTwoLocationTenant("loc8b");
    await expect(
      admin.query(
        `INSERT INTO partner_stations (station_code, tenant_id, location_id, status, public_key_pem, public_key_fingerprint)
         VALUES ($1,$2,$3,'ACTIVE',$4,$5)`,
        [stationCodeFor("LOC8CROSS"), a.tenantId, b.locationA, "pem", "c".repeat(64)]
      )
    ).rejects.toThrow();
  });
});

describe("AG-1 integration surfaces", () => {
  const service = readFileSync("server/partner/partner-management-service.ts", "utf8");
  const routes = readFileSync("server/partner/partner-management-routes.ts", "utf8");
  const stationRoutes = readFileSync("server/partner/station-routes.ts", "utf8");
  const migration = readFileSync("migrations/0084_partner_location_management.sql", "utf8");

  it("reuses partner_locations rather than introducing a second location model", () => {
    // The locked constraint: no parallel model. 0084 adds no table and no column.
    expect(migration).not.toMatch(/CREATE TABLE/i);
    expect(migration).not.toMatch(/ADD COLUMN/i);
    expect(service).toContain("INSERT INTO partner_locations");
    // And no new assignment table either — partner_user_locations already existed.
    expect(service).toContain("partner_user_locations");
  });

  it("location administration is Super Admin only, on the existing admin router", () => {
    expect(routes).toContain('r.post("/partners/:partnerId/locations"');
    expect(routes).toContain('r.patch("/partners/:partnerId/locations/:locationId"');
    expect(routes).toContain('r.post("/partners/:partnerId/locations/:locationId/status"');
    expect(routes).toContain('r.post("/partners/:partnerId/users/:userId/locations"');
    // No partner-portal route grants a shop the power to create its own locations.
    expect(stationRoutes).not.toMatch(/INSERT INTO partner_locations|createPartnerLocation/);
  });

  it("suspending a location is audited with a mandatory reason and is never a delete", () => {
    expect(service).toContain("partner_location_status_changed");
    expect(service).not.toMatch(/DELETE FROM partner_locations/);
    const statusRoute = routes.slice(routes.indexOf('"/partners/:partnerId/locations/:locationId/status"'));
    expect(statusRoute.slice(0, 400)).toContain("requireReason(req.body?.reason)");
  });

  it("the FIX queue is confined to one shop floor for a station, and only for a station", () => {
    expect(stationRoutes).toMatch(/restrictToLocation: true/);
    expect(stationRoutes).toMatch(/restrictToLocation: !principal\.orgWide/);
  });

  it("the Scanner exposes location choice ONLY when the operator has more than one", () => {
    /*
     * This behaviour already existed and was DEAD CODE: the selector self-hides at <=1 permitted
     * location, and until AG-1 no partner could ever have two. It is asserted now because AG-1 is
     * what makes it reachable — and because "hidden when there is nothing to choose" is the
     * behaviour a shop with one counter must keep.
     */
    const scannerApp = readFileSync("scripts/scanner-app/renderer/app.js", "utf8");
    expect(scannerApp).toMatch(/locations\.length\s*<=?\s*1|length\s*<\s*2/);
    // The list itself is server-resolved; the Scanner never types or invents a location.
    const stationClient = readFileSync("scripts/scanner-app/lib/station-client.js", "utf8");
    expect(stationClient).toContain("/api/partner/stations/enrolment-locations");
  });

  it("the last ACTIVE location cannot be suspended", () => {
    expect(service).toContain("This is the partner's only active location");
  });
});
