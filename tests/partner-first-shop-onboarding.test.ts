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

  it("rejects a globally-taken Owner email with an actionable reason and leaves no partial shop behind", async () => {
    // The reservation survives revocation: uq_partner_users_email_lower has no status predicate, so a
    // REVOKED user at another Partner still holds its email. This is the exact live staging shape that
    // blocked Shop #1 (mintvaultuk@gmail.com, REVOKED at another tenant) and returned a message the
    // Super Admin could not act on.
    const holder = await service.createFirstShopOnboarding(
      actor("first-shop-email-holder-0009"),
      {
        legalName: "Email Holder Ltd",
        locationName: "Main location",
        deliveryAddress: { line1: "9 Holder Road", city: "London", postcode: "N7 8AA", country: "GB" },
        operationsContact: { fullName: "Holder Operations", email: "operations@email-holder.test" },
        owner: { firstName: "Holder", lastName: "Owner", email: "taken.owner@email-holder.test" },
      },
      "duplicate owner email proof — holder"
    );
    const holderId = (holder.result as { partnerId: string }).partnerId;
    await admin.query("UPDATE partner_users SET status='REVOKED' WHERE tenant_id=$1", [holderId]);

    const before = await admin.query<{ orgs: string; users: string; locs: string; contacts: string; invites: string; wallets: string }>(
      `SELECT (SELECT count(*) FROM partner_organisations) orgs, (SELECT count(*) FROM partner_users) users,
              (SELECT count(*) FROM partner_locations) locs, (SELECT count(*) FROM partner_contacts) contacts,
              (SELECT count(*) FROM partner_invitations) invites, (SELECT count(*) FROM partner_wallets) wallets`
    );
    const deliveredBefore = delivery.sent.length;

    await expect(
      service.createFirstShopOnboarding(
        actor("first-shop-duplicate-owner-0010"),
        {
          legalName: "Duplicate Owner Email Ltd",
          locationName: "Main location",
          deliveryAddress: { line1: "10 Duplicate Road", city: "London", postcode: "N7 9AA", country: "GB" },
          operationsContact: { fullName: "Duplicate Operations", email: "operations@duplicate-owner.test" },
          owner: { firstName: "Duplicate", lastName: "Owner", email: "TAKEN.OWNER@email-holder.test" },
        },
        "duplicate owner email proof — clash"
      )
    ).rejects.toMatchObject({
      code: "DUPLICATE_PARTNER_USER",
      message: expect.stringContaining("Email Holder Ltd"),
    });

    // The rejection must name the state, not the opaque partner-facing wording.
    await service
      .createFirstShopOnboarding(
        actor("first-shop-duplicate-owner-0011"),
        {
          legalName: "Duplicate Owner Email Two Ltd",
          locationName: "Main location",
          deliveryAddress: { line1: "11 Duplicate Road", city: "London", postcode: "N7 9AB", country: "GB" },
          operationsContact: { fullName: "Duplicate Operations", email: "operations@duplicate-owner-2.test" },
          owner: { firstName: "Duplicate", lastName: "Owner", email: "taken.owner@email-holder.test" },
        },
        "duplicate owner email proof — wording"
      )
      .then(
        () => {
          throw new Error("expected the duplicate Owner email to be rejected");
        },
        (err: { message: string }) => {
          expect(err.message).toContain("REVOKED");
          expect(err.message).not.toBe("That team member cannot be invited.");
        }
      );

    const after = await admin.query<typeof before.rows[0]>(
      `SELECT (SELECT count(*) FROM partner_organisations) orgs, (SELECT count(*) FROM partner_users) users,
              (SELECT count(*) FROM partner_locations) locs, (SELECT count(*) FROM partner_contacts) contacts,
              (SELECT count(*) FROM partner_invitations) invites, (SELECT count(*) FROM partner_wallets) wallets`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const ghost = await admin.query<{ n: string }>(
      "SELECT count(*) n FROM partner_organisations WHERE legal_name LIKE 'Duplicate Owner Email%'"
    );
    expect(Number(ghost.rows[0].n)).toBe(0);
    const ghostAudit = await admin.query<{ n: string }>(
      "SELECT count(*) n FROM partner_management_audit WHERE idempotency_key IN ($1,$2)",
      ["first-shop-duplicate-owner-0010", "first-shop-duplicate-owner-0011"]
    );
    expect(Number(ghostAudit.rows[0].n)).toBe(0);
    expect(delivery.sent).toHaveLength(deliveredBefore);
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

  /*
   * THE SIMPLIFIED CREATE FORM. One form now asks for the shop, the Owner and the delivery address
   * and nothing else, so these prove the SERVER supplies what the form stopped asking for — and
   * that it supplies exactly one of each, in the same transaction.
   */
  it("names the Main location itself when the form does not ask for one", async () => {
    const key = "first-shop-default-location-0101";
    const result = await service.createFirstShopOnboarding(
      actor(key),
      {
        legalName: "Default Location Ltd",
        deliveryAddress: { line1: "2 Default Way", city: "Leeds", postcode: "LS1 1AA", country: "United Kingdom" },
        owner: { firstName: "Dee", lastName: "Fault", email: "owner@default-location.test" },
      } as never,
      "guided first-shop default location"
    );
    const partnerId = (result.result as { partnerId: string }).partnerId;
    const locations = await admin.query<{ name: string; status: string }>(
      "SELECT name, status FROM partner_locations WHERE tenant_id=$1",
      [partnerId]
    );
    expect(locations.rows).toHaveLength(1);
    expect(locations.rows[0]).toMatchObject({ name: "Main location", status: "ACTIVE" });
  });

  it("makes the Owner the operations contact, once, when no other contact is given", async () => {
    const key = "first-shop-default-contact-0102";
    const result = await service.createFirstShopOnboarding(
      actor(key),
      {
        legalName: "Default Contact Ltd",
        deliveryAddress: { line1: "3 Contact Road", city: "Bristol", postcode: "BS1 1AA", country: "United Kingdom" },
        owner: { firstName: "Olive", lastName: "Owner", email: "olive@default-contact.test" },
      } as never,
      "guided first-shop default contact"
    );
    const partnerId = (result.result as { partnerId: string }).partnerId;
    const contacts = await admin.query<{ full_name: string; email: string; is_primary: boolean }>(
      "SELECT full_name, email, is_primary FROM partner_contacts WHERE tenant_id=$1 AND contact_type='operations'",
      [partnerId]
    );
    // Exactly ONE. The duplicate-contact failure this default removes was two rows differing by a typo.
    expect(contacts.rows).toHaveLength(1);
    expect(contacts.rows[0]).toMatchObject({
      full_name: "Olive Owner",
      email: "olive@default-contact.test",
      is_primary: true,
    });
  });

  it("still honours a deliberately different operations contact", async () => {
    const key = "first-shop-explicit-contact-0103";
    const result = await service.createFirstShopOnboarding(
      actor(key),
      {
        legalName: "Explicit Contact Ltd",
        deliveryAddress: { line1: "4 Explicit Lane", city: "Cardiff", postcode: "CF10 1AA", country: "United Kingdom" },
        operationsContact: { fullName: "Ops Person", email: "ops@explicit-contact.test" },
        owner: { firstName: "Ollie", lastName: "Owner", email: "owner@explicit-contact.test" },
      } as never,
      "guided first-shop explicit contact"
    );
    const partnerId = (result.result as { partnerId: string }).partnerId;
    const contacts = await admin.query<{ full_name: string; email: string }>(
      "SELECT full_name, email FROM partner_contacts WHERE tenant_id=$1 AND contact_type='operations'",
      [partnerId]
    );
    expect(contacts.rows).toHaveLength(1);
    expect(contacts.rows[0]).toMatchObject({ full_name: "Ops Person", email: "ops@explicit-contact.test" });
  });

  it("gives the Owner canonical Main-location access WITHOUT a separate assignment step", async () => {
    const key = "first-shop-owner-location-0104";
    const result = await service.createFirstShopOnboarding(
      actor(key),
      {
        legalName: "Owner Location Ltd",
        deliveryAddress: { line1: "5 Owner Street", city: "Bath", postcode: "BA1 1AA", country: "United Kingdom" },
        owner: { firstName: "Ola", lastName: "Owner", email: "ola@owner-location.test" },
      } as never,
      "guided first-shop owner location"
    );
    const partnerId = (result.result as { partnerId: string }).partnerId;

    /*
     * This is the CANONICAL eligibility rule, not a re-derivation: an org-wide role is eligible at
     * every ACTIVE location, and everyone else needs an explicit partner_user_locations row. The
     * Owner holds PARTNER_OWNER from creation, so they can already operate the Scanner at Main
     * location and there is nothing for Super Admin to click. Asserted here so nobody later "fixes"
     * it by writing a redundant assignment row — a second assignment path is exactly what the
     * canonical rule exists to avoid.
     */
    const eligible = await admin.query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM partner_locations l
         LEFT JOIN partner_user_locations ul
           ON ul.tenant_id=l.tenant_id AND ul.location_id=l.id AND ul.user_id=u.id
         WHERE l.tenant_id=u.tenant_id AND l.status='ACTIVE'
           AND (ul.user_id IS NOT NULL OR EXISTS (
             SELECT 1 FROM partner_user_roles ur
             JOIN partner_roles r ON r.id=ur.role_id
             WHERE ur.tenant_id=u.tenant_id AND ur.user_id=u.id
               AND r.code IN ('PARTNER_OWNER','PARTNER_MANAGER','PARTNER_FINANCE_VIEWER')
           ))
       ) AS eligible
       FROM partner_users u WHERE u.tenant_id=$1`,
      [partnerId]
    );
    expect(eligible.rows[0]?.eligible).toBe(true);
  });


  /*
   * OWNER EMAIL ELIGIBILITY. The create path always refused a clashing address correctly; what it
   * could not do was say so before the operator filled in a whole form. These prove the pre-flight
   * check gives the SAME answer the create transaction gives, per status.
   */
  it("reports a free Owner email as available", async () => {
    const result = await service.checkOwnerEmailEligibility("nobody-has-this@free-email.test");
    expect(result).toMatchObject({ available: true, conflict: null });
  });

  it("reports an ACTIVE user's email as unavailable and not releasable", async () => {
    const key = "first-shop-eligibility-active-0201";
    const created = await service.createFirstShopOnboarding(
      actor(key),
      {
        legalName: "Eligibility Active Ltd",
        deliveryAddress: { line1: "6 Active Way", city: "York", postcode: "YO1 1AA", country: "United Kingdom" },
        owner: { firstName: "Ava", lastName: "Active", email: "ava@eligibility-active.test" },
      } as never,
      "eligibility active"
    );
    const partnerId = (created.result as { partnerId: string }).partnerId;
    await admin.query("UPDATE partner_users SET status='ACTIVE' WHERE tenant_id=$1", [partnerId]);

    const result = await service.checkOwnerEmailEligibility("ava@eligibility-active.test");
    expect(result.available).toBe(false);
    expect(result.conflict).toMatchObject({
      partnerName: "Eligibility Active Ltd",
      userStatus: "ACTIVE",
      releasable: false,
      nextAction: "Use a different Owner email.",
    });
  });

  it("reports an INVITED user's email as unavailable but RELEASABLE, because a real authority exists", async () => {
    const key = "first-shop-eligibility-invited-0202";
    await service.createFirstShopOnboarding(
      actor(key),
      {
        legalName: "Eligibility Invited Ltd",
        deliveryAddress: { line1: "7 Invited Row", city: "Hull", postcode: "HU1 1AA", country: "United Kingdom" },
        owner: { firstName: "Ivy", lastName: "Invited", email: "ivy@eligibility-invited.test" },
      } as never,
      "eligibility invited"
    );
    const result = await service.checkOwnerEmailEligibility("ivy@eligibility-invited.test");
    expect(result.available).toBe(false);
    // A freshly created Owner is INVITED, and amendPendingInvitation can still move that invitation.
    expect(result.conflict).toMatchObject({ userStatus: "INVITED", releasable: true });
    expect(result.conflict?.nextAction).toContain("pending invitation");
    // The live invitation is reported, so Super Admin can see one exists.
    expect(result.conflict?.invitationStatus).not.toBeNull();
  });

  it("reports a REVOKED user's email as permanently held — the case that looked like a dead button", async () => {
    const key = "first-shop-eligibility-revoked-0203";
    const created = await service.createFirstShopOnboarding(
      actor(key),
      {
        legalName: "Pokemon Kings Proof",
        deliveryAddress: { line1: "8 Revoked Street", city: "Derby", postcode: "DE1 1AA", country: "United Kingdom" },
        owner: { firstName: "Rex", lastName: "Revoked", email: "rex@eligibility-revoked.test" },
      } as never,
      "eligibility revoked"
    );
    const partnerId = (created.result as { partnerId: string }).partnerId;
    await admin.query("UPDATE partner_users SET status='REVOKED' WHERE tenant_id=$1", [partnerId]);

    const result = await service.checkOwnerEmailEligibility("rex@eligibility-revoked.test");
    expect(result.available).toBe(false);
    expect(result.conflict).toMatchObject({
      partnerName: "Pokemon Kings Proof",
      userStatus: "REVOKED",
      // Terminal by design: no canonical authority releases it.
      releasable: false,
      nextAction: "Use a different Owner email.",
    });
    expect(result.conflict?.reason).toContain("revoked user keeps its email");
  });

  it("the pre-flight answer and the create refusal agree — no ghost records from the blocked attempt", async () => {
    const eligibility = await service.checkOwnerEmailEligibility("rex@eligibility-revoked.test");
    expect(eligibility.available).toBe(false);

    const before = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM partner_organisations");
    await expect(
      service.createFirstShopOnboarding(
        actor("first-shop-eligibility-clash-0204"),
        {
          legalName: "Should Never Exist Ltd",
          deliveryAddress: { line1: "9 Ghost Lane", city: "Leeds", postcode: "LS2 2AA", country: "United Kingdom" },
          owner: { firstName: "Rex", lastName: "Revoked", email: "rex@eligibility-revoked.test" },
        } as never,
        "clash proof"
      )
    ).rejects.toThrow(/already belongs to an existing Partner user/);

    // ATOMICITY: the refusal happens inside the transaction, so nothing at all was written.
    const after = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM partner_organisations");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const ghost = await admin.query("SELECT 1 FROM partner_organisations WHERE legal_name='Should Never Exist Ltd'");
    expect(ghost.rows).toHaveLength(0);
  });

  it("refuses an invalid address rather than reporting it available", async () => {
    await expect(service.checkOwnerEmailEligibility("not-an-email")).rejects.toThrow(/valid email/i);
  });

});