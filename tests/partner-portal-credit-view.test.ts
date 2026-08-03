import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_G6B,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";

let cluster: DisposablePostgres17;
let admin: Client;
let views: typeof import("../server/partner/portal-view-service");
let wallet: typeof import("../server/partner/partner-wallet-service");
let reservations: typeof import("../server/partner/partner-credit-reservation-service");
let tenantA: string;
let tenantB: string;
let locationA: string;
let userA: string;
let sessionA: string;

async function seedLegacyTables() {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function createTenant(name: string) {
  const tenant = await admin.query<{ id: string }>(
    "INSERT INTO partner_organisations (legal_name,status) VALUES ($1,'ACTIVE') RETURNING id",
    [name]
  );
  const tenantId = tenant.rows[0].id;
  const location = await admin.query<{ id: string }>(
    "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
    [tenantId, `${name} shop`]
  );
  const user = await admin.query<{ id: string }>(
    `INSERT INTO partner_users
       (tenant_id,partner_id,email,password_hash,status,mfa_required,first_name,last_name)
     VALUES ($1,$1,$2,'synthetic','ACTIVE',false,'Test','Owner') RETURNING id`,
    [tenantId, `${name.toLowerCase().replaceAll(" ", "-")}@example.test`]
  );
  return { tenantId, locationId: location.rows[0].id, userId: user.rows[0].id };
}

function principal() {
  return {
    sessionId: sessionA,
    tenantId: tenantA,
    userId: userA,
    locationId: locationA,
    mfaPassed: true,
    permissions: new Set(["partner.dashboard.view", "partner.credits.view"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: true,
  };
}

describe("Partner Portal credit projection on PostgreSQL 17.10", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-portal-credit-view");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedLegacyTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_G6B);
    await applyMigrationsRealistic(admin, cluster.url, ["0031_partner_user_management"]);
    await admin.query("CREATE ROLE portal_view_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO portal_view_test");
    const runtimeUrl = new URL(cluster.url);
    runtimeUrl.username = "portal_view_test";
    runtimeUrl.password = "synthetic";
    process.env.PARTNER_DATABASE_URL = runtimeUrl.toString();
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;

    const a = await createTenant("Tenant A");
    const b = await createTenant("Tenant B");
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    locationA = a.locationId;
    userA = a.userId;
    const role = await admin.query<{ id: string }>(
      "INSERT INTO partner_roles (code,label) VALUES ('PARTNER_OWNER','Owner') RETURNING id"
    );
    await admin.query("INSERT INTO partner_user_roles (tenant_id,user_id,role_id) VALUES ($1,$2,$3)", [
      tenantA,
      userA,
      role.rows[0].id,
    ]);
    await admin.query("INSERT INTO partner_profiles (tenant_id,trading_name) VALUES ($1,'Tenant A Cards')", [tenantA]);
    const session = await admin.query<{ id: string }>(
      `INSERT INTO partner_sessions
         (tenant_id,user_id,location_id,token_hash,credential_version,mfa_passed,ip,absolute_expires_at,last_seen_at)
       VALUES ($1,$2,$3,$4,1,true,'127.0.0.1',now()+interval '1 day',now()) RETURNING id`,
      [tenantA, userA, locationA, "a".repeat(64)]
    );
    sessionA = session.rows[0].id;
    wallet = await import("../server/partner/partner-wallet-service");
    reservations = await import("../server/partner/partner-credit-reservation-service");
    views = await import("../server/partner/portal-view-service");
    const actor = { actorUserId: null, actorEmail: "admin@example.test" };
    await wallet.ensureWallet(actor, tenantA);
    await wallet.appendFoundationCredit(actor, {
      tenantId: tenantA,
      amount: 10,
      entryType: "admin_adjustment",
      source: "admin",
      reason: "Staging demo credits for owner review — no monetary value",
      idempotencyKey: "tenant-a-demo-10",
      actorType: "admin",
    });
    await wallet.ensureWallet(actor, tenantB);
    await wallet.appendFoundationCredit(actor, {
      tenantId: tenantB,
      amount: 99,
      entryType: "admin_adjustment",
      source: "admin",
      reason: "Tenant B private credits",
      idempotencyKey: "tenant-b-private-99",
      actorType: "admin",
    });
  }, 90_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    delete process.env.PARTNER_DATABASE_URL;
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("returns real tenant-scoped balances, ordered ledger entries and shop context", async () => {
    const context = await views.getPartnerPortalContext(principal());
    expect(context).toMatchObject({ tradingName: "Tenant A Cards", role: "Owner", locationName: "Tenant A shop" });
    const result = await views.getPartnerCreditView(principal());
    expect(result.summary).toMatchObject({ availableCredits: 10, reservedCredits: 0, consumedLifetime: 0 });
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ quantity: 10, runningBalance: 10, source: "admin" });
    expect(JSON.stringify(result)).not.toContain("Tenant B private credits");
    expect(JSON.stringify(result)).not.toContain("99");
  });

  it("shows reserve and release without double-reserving or cross-tenant leakage", async () => {
    const actor = { actorUserId: userA, actorEmail: "owner@tenant-a.test" };
    const input = {
      tenantId: tenantA,
      locationId: locationA,
      cardReference: "SYNTHETIC-CARD-1",
      submissionReference: "SYNTHETIC-SUBMISSION-1",
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: "portal-view-reserve-1",
      source: "portal" as const,
      reason: "Synthetic portal lifecycle proof",
      actorType: "partner_user" as const,
    };
    const first = await reservations.reserveCredit(actor, input);
    const replay = await reservations.reserveCredit(actor, input);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect((await views.getPartnerCreditView(principal())).summary).toMatchObject({
      availableCredits: 9,
      reservedCredits: 1,
    });
    await reservations.releaseReservedCredit(actor, {
      tenantId: tenantA,
      reservationId: first.reservation.id,
      idempotencyKey: "portal-view-release-1",
      source: "portal",
      reason: "Synthetic pre-settlement cancellation",
      actorType: "partner_user",
    });
    expect((await views.getPartnerCreditView(principal())).summary).toMatchObject({
      availableCredits: 10,
      reservedCredits: 0,
    });

    const settlement = await reservations.reserveCredit(actor, {
      ...input,
      cardReference: "SYNTHETIC-CARD-2",
      submissionReference: "SYNTHETIC-SUBMISSION-2",
      idempotencyKey: "portal-view-reserve-2",
    });
    await reservations.consumeReservedCredit(actor, {
      tenantId: tenantA,
      reservationId: settlement.reservation.id,
      idempotencyKey: "portal-view-consume-2",
      source: "system",
      reason: "Synthetic grading settlement",
      actorType: "system",
    });
    const consumed = await views.getPartnerCreditView(principal());
    expect(consumed.summary).toMatchObject({
      availableCredits: 9,
      reservedCredits: 0,
      consumedLifetime: 1,
    });
    expect(consumed.ledger[0]).toMatchObject({ quantity: -1, runningBalance: 9 });
  });

  it("lists and revokes only the signed-in user's own sessions", async () => {
    expect(await views.listOwnPartnerSessions(principal())).toEqual([
      expect.objectContaining({ id: sessionA, current: true, ip: "127.0.0.1" }),
    ]);
    expect(await views.revokeOwnPartnerSession(principal(), "00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(await views.revokeOwnPartnerSession(principal(), sessionA)).toBe(true);
  });
});
