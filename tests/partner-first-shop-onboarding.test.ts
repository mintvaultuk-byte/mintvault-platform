/**
 * First-shop onboarding needs real PostgreSQL proof: it is one transaction across organisation,
 * location, contact, Owner invitation, role and wallet. A source test cannot prove that a retry
 * does not produce a second shop or that Supplies reads the exact address/contact it created.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const delivery = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));
vi.mock("../server/partner/delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/partner/delivery")>();
  return {
    ...actual,
    invitationDeliveryConfigured: () => true,
    deliverInvitationToken: vi.fn(async (payload: Record<string, unknown>) => {
      delivery.sent.push(payload);
    }),
  };
});

let cluster: DisposablePostgres17;
let admin: Client;
let service: typeof import("../server/partner/partner-management-service");
let partnerRoutes: typeof import("../server/partner/routes");

const actor = (idempotencyKey: string) => ({
  actorUserId: "11111111-1111-4111-8111-111111111111",
  actorEmail: "superadmin@example.test",
  requestId: `first-shop-${idempotencyKey}`,
  idempotencyKey,
});

async function seedCoreTables(): Promise<void> {
  for (const statement of [
    "CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)",
    "CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)",
    "CREATE TABLE submission_items (id serial primary key, submission_id integer not null)",
    "CREATE TABLE audit_log (id serial primary key, entity_type text not null, entity_id text not null, action text not null, admin_user text, details jsonb, created_at timestamptz not null default now())",
  ]) {
    await admin.query(statement);
  }
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

describe("first-shop guided onboarding (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-first-shop-onboarding");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    process.env.PARTNER_CREDIT_DATABASE_URL = cluster.url;
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedCoreTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_FIRST_SHOP);
    service = await import("../server/partner/partner-management-service");
    partnerRoutes = await import("../server/partner/routes");
  }, 180_000);

  afterAll(async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("creates exactly one canonical Partner/Main location/operations contact/Owner/wallet on replay", async () => {
    const key = "first-shop-proof-idempotency-0001";
    const input = {
      legalName: "First Shop Proof Ltd",
      locationName: "Main location",
      deliveryAddress: { line1: "1 Proof Street", line2: "Unit 4", city: "London", postcode: "SW1A 1AA", country: "United Kingdom" },
      operationsContact: { fullName: "Proof Operations", email: "operations@first-shop-proof.test" },
      owner: { firstName: "Proof", lastName: "Owner", email: "owner@first-shop-proof.test" },
    };
    const first = await service.createFirstShopOnboarding(actor(key), input, "guided first-shop proof");
    const partnerId = (first.result as { partnerId: string }).partnerId;
    const replay = await service.createFirstShopOnboarding(actor(key), input, "guided first-shop proof");
    expect(replay).toMatchObject({ alreadyCompleted: true, result: { partnerId } });
    expect(delivery.sent).toHaveLength(1);

    const org = await admin.query("SELECT legal_name, status FROM partner_organisations WHERE id=$1", [partnerId]);
    const locations = await admin.query(
      "SELECT name, status, address_line1, address_line2, address_city, address_postcode, address_country FROM partner_locations WHERE tenant_id=$1",
      [partnerId]
    );
    const contacts = await admin.query(
      "SELECT full_name, email, contact_type, is_primary, active FROM partner_contacts WHERE tenant_id=$1",
      [partnerId]
    );
    const owners = await admin.query(
      `SELECT u.email, u.status, r.code FROM partner_users u
         JOIN partner_user_roles ur ON ur.user_id=u.id
         JOIN partner_roles r ON r.id=ur.role_id
        WHERE u.tenant_id=$1`,
      [partnerId]
    );
    const wallets = await admin.query("SELECT count(*)::int AS n FROM partner_wallets WHERE tenant_id=$1", [partnerId]);
    const audits = await admin.query(
      "SELECT count(*)::int AS n FROM partner_management_audit WHERE tenant_id=$1 AND action_type='partner_first_shop_onboarded' AND result='succeeded'",
      [partnerId]
    );
    expect(org.rows).toEqual([{ legal_name: "First Shop Proof Ltd", status: "PENDING" }]);
    expect(locations.rows).toEqual([
      expect.objectContaining({
        name: "Main location",
        status: "ACTIVE",
        address_line1: "1 Proof Street",
        address_line2: "Unit 4",
        address_city: "London",
        address_postcode: "SW1A 1AA",
        address_country: "United Kingdom",
      }),
    ]);
    expect(contacts.rows).toEqual([
      expect.objectContaining({ full_name: "Proof Operations", email: "operations@first-shop-proof.test", contact_type: "operations", is_primary: true, active: true }),
    ]);
    expect(owners.rows).toEqual([expect.objectContaining({ email: "owner@first-shop-proof.test", status: "INVITED", code: "PARTNER_OWNER" })]);
    expect(wallets.rows[0].n).toBe(1);
    expect(audits.rows[0].n).toBe(1);
  });

  it("serialises two different request keys for the same shop name and never creates a duplicate Partner", async () => {
    const input = {
      legalName: "First Shop Concurrent Name Ltd",
      locationName: "Main location",
      deliveryAddress: { line1: "8 Lock Street", city: "London", postcode: "SE1 9ZZ", country: "GB" },
      operationsContact: { fullName: "Concurrent Operations", email: "operations@first-shop-concurrent.test" },
      owner: { firstName: "Concurrent", lastName: "Owner", email: "owner@first-shop-concurrent.test" },
    };
    const results = await Promise.allSettled([
      service.createFirstShopOnboarding(actor("first-shop-concurrency-a-0006"), input, "concurrency proof"),
      service.createFirstShopOnboarding(actor("first-shop-concurrency-b-0007"), input, "concurrency proof"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: { code: "VALIDATION_ERROR" },
    });
    const count = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_organisations WHERE lower(legal_name)=lower($1)",
      [input.legalName]
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("makes the structured Main-location address and active primary operations contact the shared readiness authority", async () => {
    const created = await service.createFirstShopOnboarding(
      actor("first-shop-readiness-authority-0002"),
      {
        legalName: "Readiness Authority Ltd",
        locationName: "Main location",
        deliveryAddress: { line1: "2 Authority Road", city: "London", postcode: "EC1A 1BB", country: "GB" },
        operationsContact: { fullName: "Readiness Operations", email: "operations@readiness-authority.test" },
        owner: { firstName: "Readiness", lastName: "Owner", email: "owner@readiness-authority.test" },
      },
      "readiness authority proof"
    );
    const partnerId = (created.result as { partnerId: string }).partnerId;
    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [partnerId]);
    for (const [flag, enabled] of [["partner_portal_enabled", true], ["partner_login_enabled", true], ["partner_emergency_stop", false]] as const) {
      await admin.query(
        "INSERT INTO partner_feature_flags (flag, enabled, tenant_id, location_id) VALUES ($1,$2,NULL,NULL) ON CONFLICT DO NOTHING",
        [flag, enabled]
      );
    }
    const ready = await service.getPartnerOnboardingReadiness(partnerId);
    expect(ready.operational.dimensions.delivery.status).toBe("PASS");
    expect(ready.operational.dimensions.operationsContact.status).toBe("PASS");
    expect(ready.operational.dimensions.delivery.actions).toEqual([]);

    await admin.query("UPDATE partner_contacts SET active=false WHERE tenant_id=$1", [partnerId]);
    const inactive = await service.getPartnerOnboardingReadiness(partnerId);
    expect(inactive.operational.dimensions.operationsContact.code).toBe("OPERATIONS_CONTACT_REQUIRED");

    await admin.query("UPDATE partner_contacts SET active=true, email='not-an-email' WHERE tenant_id=$1", [partnerId]);
    const invalidEmail = await service.getPartnerOnboardingReadiness(partnerId);
    expect(invalidEmail.operational.dimensions.operationsContact.code).toBe("OPERATIONS_CONTACT_REQUIRED");
  });

  it("does not treat another tenant's contact or a foreign location as this shop's completion", async () => {
    const a = await service.createFirstShopOnboarding(
      actor("first-shop-tenant-a-0003"),
      {
        legalName: "First Shop Tenant A Ltd", locationName: "Main location",
        deliveryAddress: { line1: "3 A Road", city: "London", postcode: "N1 9ZZ", country: "GB" },
        operationsContact: { fullName: "A Operations", email: "operations@first-shop-a.test" },
        owner: { firstName: "A", lastName: "Owner", email: "owner@first-shop-a.test" },
      }, "tenant isolation A"
    );
    const b = await service.createFirstShopOnboarding(
      actor("first-shop-tenant-b-0004"),
      {
        legalName: "First Shop Tenant B Ltd", locationName: "Main location",
        deliveryAddress: { line1: "4 B Road", city: "London", postcode: "E1 6AN", country: "GB" },
        operationsContact: { fullName: "B Operations", email: "operations@first-shop-b.test" },
        owner: { firstName: "B", lastName: "Owner", email: "owner@first-shop-b.test" },
      }, "tenant isolation B"
    );
    const aId = (a.result as { partnerId: string }).partnerId;
    const bId = (b.result as { partnerId: string }).partnerId;
    const bLocation = (await admin.query<{ id: string }>("SELECT id FROM partner_locations WHERE tenant_id=$1", [bId])).rows[0].id;
    await expect(
      service.updateFirstShopDeliveryAddress(
        actor("first-shop-cross-tenant-location-0005"), aId, bLocation,
        { line1: "9 Wrong Road", city: "London", postcode: "W1A 1AA", country: "GB" }, "must fail"
      )
    ).rejects.toMatchObject({ code: "PARTNER_NOT_FOUND" });
    await admin.query("UPDATE partner_contacts SET active=false WHERE tenant_id=$1", [aId]);
    const aReadiness = await service.getPartnerOnboardingReadiness(aId);
    expect(aReadiness.operational.dimensions.operationsContact.code).toBe("OPERATIONS_CONTACT_REQUIRED");
  });

  it("edits the same Main-location record that readiness selects, never the alphabetically first shop floor", async () => {
    const created = await service.createFirstShopOnboarding(
      actor("first-shop-main-location-authority-0005"),
      {
        legalName: "First Shop Main Location Authority Ltd",
        locationName: "Main location",
        deliveryAddress: { line1: "5 Main Authority Road", city: "London", postcode: "E1 8QS", country: "GB" },
        operationsContact: { fullName: "Main Location Operations", email: "operations@first-shop-main-location.test" },
        owner: { firstName: "Main", lastName: "Owner", email: "owner@first-shop-main-location.test" },
      },
      "Main location authority proof"
    );
    const partnerId = (created.result as { partnerId: string }).partnerId;
    await admin.query(
      `INSERT INTO partner_locations (tenant_id, partner_id, name, status, address)
       VALUES ($1,$1,'A secondary shop floor','ACTIVE','999 Secondary Street, London')`,
      [partnerId]
    );

    const snapshot = await service.getFirstShopOnboarding(partnerId);
    expect(snapshot.mainLocation?.name).toBe("Main location");
    const secondary = await admin.query<{ id: string }>(
      "SELECT id FROM partner_locations WHERE tenant_id=$1 AND name='A secondary shop floor'",
      [partnerId]
    );
    expect(snapshot.mainLocation?.id).not.toBe(secondary.rows[0].id);
  });

  it("derives Partner Owner onboarding authority from the authenticated tenant session, not request data", async () => {
    const created = await service.createFirstShopOnboarding(
      actor("first-shop-owner-route-authority-0008"),
      {
        legalName: "First Shop Owner Route Authority Ltd",
        locationName: "Main location",
        deliveryAddress: { line1: "8 Owner Route", city: "London", postcode: "SE1 7AA", country: "GB" },
        operationsContact: { fullName: "Route Operations", email: "operations@first-shop-owner-route.test" },
        owner: { firstName: "Route", lastName: "Owner", email: "owner@first-shop-owner-route.test" },
      },
      "Partner Owner route authority proof"
    );
    const partnerId = (created.result as { partnerId: string }).partnerId;
    const owner = await admin.query<{ id: string }>(
      "SELECT id FROM partner_users WHERE tenant_id=$1 AND email='owner@first-shop-owner-route.test'",
      [partnerId]
    );
    await admin.query("UPDATE partner_users SET status='ACTIVE' WHERE id=$1", [owner.rows[0].id]);
    const ownerRequest = {
      method: "PATCH",
      headers: { "x-request-id": "first-shop-owner-route-proof" },
      body: { idempotencyKey: "partner-owner-route-proof-0008" },
      partner: { tenantId: partnerId, locationId: null, userId: owner.rows[0].id, sessionId: "synthetic-session" },
    } as import("express").Request;
    await expect(partnerRoutes.currentPartnerOwnerActor(ownerRequest)).resolves.toMatchObject({
      actorUserId: owner.rows[0].id,
      actorEmail: "owner@first-shop-owner-route.test",
    });

    const manager = await admin.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id, partner_id, email, status)
       VALUES ($1,$1,'manager@first-shop-owner-route.test','ACTIVE') RETURNING id`,
      [partnerId]
    );
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id, user_id, role_id)
       SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_MANAGER'`,
      [partnerId, manager.rows[0].id]
    );
    const managerRequest = {
      ...ownerRequest,
      partner: { ...ownerRequest.partner!, userId: manager.rows[0].id },
    } as import("express").Request;
    await expect(partnerRoutes.currentPartnerOwnerActor(managerRequest)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
