import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrationsRealistic, PARTNER_MIGRATIONS } from "./helpers/partner-realistic-db";
import type { PartnerPrincipal } from "../server/partner/session";

describe("0102 public Partner privacy/publication authority (real PostgreSQL 17)", () => {
  let cluster: DisposablePostgres17;
  let admin: Client;
  let service: typeof import("../server/partner/public-presence-service");
  let publication: typeof import("../server/partner/public-publication-service");

  const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const LOC_STORE = "11111111-1111-4111-8111-111111111111";
  const LOC_SERVICE = "22222222-2222-4222-8222-222222222222";
  const LOC_B = "33333333-3333-4333-8333-333333333333";
  const OWNER_A = "44444444-4444-4444-8444-444444444444";
  const OWNER_ROLE = "55555555-5555-4555-8555-555555555555";
  const SESSION_A = "66666666-6666-4666-8666-666666666666";

  const principal: PartnerPrincipal = {
    sessionId: SESSION_A,
    tenantId: ORG_A,
    userId: OWNER_A,
    locationId: LOC_STORE,
    mfaPassed: true,
    permissions: new Set(["partner.location.view"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: true,
  };

  beforeAll(async () => {
    cluster = await startPostgres17("public-partner-presence");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await applyMigrationsRealistic(admin, cluster.url, [...PARTNER_MIGRATIONS, "0102_partner_public_presence"]);
    await admin.query(`
      CREATE TABLE certificates (
        id serial PRIMARY KEY, origin_type text, origin_partner_id uuid, origin_location_id uuid,
        status text, deleted_at timestamptz, grade numeric, grade_approved_at timestamptz
      );
      INSERT INTO partner_organisations (id,legal_name,status) VALUES
        ('${ORG_A}','Private Legal A Ltd','ACTIVE'),('${ORG_B}','Private Legal B Ltd','ACTIVE');
      INSERT INTO partner_locations (id,public_ref,tenant_id,partner_id,name,address,status) VALUES
        ('${LOC_STORE}','storefront-ref-a','${ORG_A}','${ORG_A}','Operational Store','10 Owner Home Road','ACTIVE'),
        ('${LOC_SERVICE}','service-area-ref-a','${ORG_A}','${ORG_A}','Home Workshop','99 Private Cottage','ACTIVE'),
        ('${LOC_B}','private-ref-b','${ORG_B}','${ORG_B}','Other Home','1 Secret Lane','ACTIVE');
      INSERT INTO partner_users (id,tenant_id,partner_id,email,status,credential_version) VALUES
        ('${OWNER_A}','${ORG_A}','${ORG_A}','owner@example.test','ACTIVE',1);
      INSERT INTO partner_sessions (id,tenant_id,user_id,location_id,token_hash,credential_version,mfa_passed,absolute_expires_at)
        VALUES ('${SESSION_A}','${ORG_A}','${OWNER_A}','${LOC_STORE}','test-token',1,true,now()+interval '1 hour');
      INSERT INTO partner_roles (id,code,label) VALUES ('${OWNER_ROLE}','PARTNER_OWNER','Partner Owner')
        ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label;
      INSERT INTO partner_user_roles (tenant_id,user_id,role_id)
        SELECT '${ORG_A}','${OWNER_A}',id FROM partner_roles WHERE code='PARTNER_OWNER';
      INSERT INTO partner_feature_flags (tenant_id,location_id,flag,enabled)
        VALUES (NULL,NULL,'public_partner_directory_enabled',true);
    `);
    service = await import("../server/partner/public-presence-service");
    publication = await import("../server/partner/public-publication-service");
  }, 120_000);

  afterAll(async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("keeps operational addresses and contacts private until Partner consent plus exact-version Super Admin approval", async () => {
    expect(await service.listPublicPartnerLocations()).toEqual([]);

    await publication.savePartnerPublicDraft(principal, LOC_STORE, {
      expectedProfileVersion: 0,
      expectedLocationVersion: 0,
      publicDisplayName: "A Cards",
      privacyState: "PUBLIC_STOREFRONT",
      publicLocationName: "Canterbury Shop",
      publicStreetAddress: "1 Public High Street, Canterbury CT1 1AA",
      publicServiceArea: "",
      publicWebsite: "https://cards.example.test",
      publicPhone: "+44 1227 123456",
      publicEmail: "public@example.test",
      mapsEnabled: true,
      attested: true,
    });
    expect(await service.listPublicPartnerLocations()).toEqual([]);
    const storefrontReview = await publication.getPartnerPublicProfileStatus(principal);
    const storefrontVersion = storefrontReview.locations.find((row) => row.id === LOC_STORE)!.version;
    await publication.setAdminPublicPublication({
      tenantId: ORG_A,
      locationId: LOC_STORE,
      enabled: true,
      expectedProfileVersion: storefrontReview.profile!.version,
      expectedLocationVersion: storefrontVersion,
      reason: "Owner consent and exact output reviewed",
      adminEmail: "super@example.test",
    });
    const visible = await service.listPublicPartnerLocations();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toEqual(expect.objectContaining({
      publicRef: "storefront-ref-a",
      displayName: "A Cards",
      locationName: "Canterbury Shop",
      privacyState: "PUBLIC_STOREFRONT",
      address: "1 Public High Street, Canterbury CT1 1AA",
      serviceArea: null,
      websiteUrl: "https://cards.example.test/",
      phone: "+44 1227 123456",
      email: "public@example.test",
      cardsGraded: 0,
    }));
    const serialized = JSON.stringify(visible[0]);
    expect(serialized).not.toContain("Private Legal");
    expect(serialized).not.toContain("10 Owner Home Road");
    expect(serialized).not.toContain(ORG_A);
    expect(serialized).not.toContain(LOC_STORE);
  });

  it("publishes a service area without street address or Maps and never enumerates an unconsented tenant", async () => {
    const beforeServiceArea = await publication.getPartnerPublicProfileStatus(principal);
    await publication.savePartnerPublicDraft(principal, LOC_SERVICE, {
      expectedProfileVersion: beforeServiceArea.profile!.version,
      expectedLocationVersion: 0,
      publicDisplayName: "A Cards",
      privacyState: "SERVICE_AREA_PRIVATE_ADDRESS",
      publicLocationName: "Kent Collection Service",
      publicStreetAddress: "99 Private Cottage",
      publicServiceArea: "Kent and East Sussex",
      publicWebsite: "",
      publicPhone: "",
      publicEmail: "service@example.test",
      mapsEnabled: true,
      attested: true,
    });
    const serviceAreaReview = await publication.getPartnerPublicProfileStatus(principal);
    await publication.setAdminPublicPublication({
      tenantId: ORG_A,
      locationId: LOC_SERVICE,
      enabled: true,
      expectedProfileVersion: serviceAreaReview.profile!.version,
      expectedLocationVersion: serviceAreaReview.locations.find((row) => row.id === LOC_SERVICE)!.version,
      reason: "Service-area privacy output reviewed",
      adminEmail: "super@example.test",
    });
    const result = await service.getPublicPartnerLocation("service-area-ref-a");
    expect(result).toEqual(expect.objectContaining({
      privacyState: "SERVICE_AREA_PRIVATE_ADDRESS",
      address: null,
      serviceArea: "Kent and East Sussex",
      mapsUrl: null,
    }));
    expect(JSON.stringify(result)).not.toContain("99 Private Cottage");
    expect(await service.getPublicPartnerLocation("private-ref-b")).toBeNull();
  });

  it("binds card totals to both Partner and Location authority and preserves a real zero", async () => {
    await admin.query(
      `INSERT INTO certificates (origin_type,origin_partner_id,origin_location_id,status,deleted_at,grade,grade_approved_at) VALUES
       ('PARTNER',$1,$2,'active',NULL,9,now()),
       ('PARTNER',$3,$2,'active',NULL,9,now()),
       ('PARTNER',$1,$2,'active',NULL,9,NULL),
       ('HQ',NULL,NULL,'active',NULL,9,now())`,
      [ORG_A, LOC_STORE, ORG_B]
    );
    expect((await service.getPublicPartnerLocation("storefront-ref-a"))?.cardsGraded).toBe(1);
    expect((await service.getPublicPartnerLocation("service-area-ref-a"))?.cardsGraded).toBe(0);
  });

  it("invalidates approval immediately when an Owner edits the exact public output", async () => {
    await publication.savePartnerPublicDraft(principal, LOC_STORE, {
      expectedProfileVersion: 1,
      expectedLocationVersion: 1,
      publicDisplayName: "A Cards",
      privacyState: "PUBLIC_STOREFRONT",
      publicLocationName: "Canterbury Shop",
      publicStreetAddress: "2 New Public Street, Canterbury CT1 2BB",
      publicWebsite: "https://cards.example.test",
      publicPhone: "+44 1227 123456",
      publicEmail: "public@example.test",
      mapsEnabled: true,
      attested: true,
    });
    expect(await service.getPublicPartnerLocation("storefront-ref-a")).toBeNull();
    const status = await publication.getPartnerPublicProfileStatus(principal);
    const row = status.locations.find((location) => location.id === LOC_STORE)!;
    expect(row.publication.readyForApproval).toBe(true);
    expect(row.publication.live).toBe(false);
    expect(row.preview?.address).toBe("2 New Public Street, Canterbury CT1 2BB");
    expect(row.preview && JSON.stringify(row.preview)).not.toContain("10 Owner Home Road");

    const staleLocationReview = status;
    await publication.savePartnerPublicDraft(principal, LOC_STORE, {
      expectedProfileVersion: staleLocationReview.profile!.version,
      expectedLocationVersion: staleLocationReview.locations.find((location) => location.id === LOC_STORE)!.version,
      publicDisplayName: "A Cards",
      privacyState: "PUBLIC_STOREFRONT",
      publicLocationName: "Canterbury Shop",
      publicStreetAddress: "3 Newer Public Street, Canterbury CT1 3CC",
      publicWebsite: "https://cards.example.test",
      publicPhone: "+44 1227 123456",
      publicEmail: "public@example.test",
      mapsEnabled: true,
      attested: true,
    });
    await expect(publication.setAdminPublicPublication({
      tenantId: ORG_A,
      locationId: LOC_STORE,
      enabled: true,
      expectedProfileVersion: staleLocationReview.profile!.version,
      expectedLocationVersion: staleLocationReview.locations.find((location) => location.id === LOC_STORE)!.version,
      reason: "Must reject stale location review",
      adminEmail: "super@example.test",
    })).rejects.toMatchObject({ code: "STALE_PREVIEW", status: 409 });
    expect(await service.getPublicPartnerLocation("storefront-ref-a")).toBeNull();

    const staleProfileReview = await publication.getPartnerPublicProfileStatus(principal);
    await publication.savePartnerPublicDraft(principal, LOC_SERVICE, {
      expectedProfileVersion: staleProfileReview.profile!.version,
      expectedLocationVersion: staleProfileReview.locations.find((location) => location.id === LOC_SERVICE)!.version,
      publicDisplayName: "A Cards Renamed",
      privacyState: "SERVICE_AREA_PRIVATE_ADDRESS",
      publicLocationName: "Kent Collection Service",
      publicStreetAddress: "99 Private Cottage",
      publicServiceArea: "Kent and East Sussex",
      publicWebsite: "",
      publicPhone: "",
      publicEmail: "service@example.test",
      mapsEnabled: false,
      attested: true,
    });
    await expect(publication.savePartnerPublicDraft(principal, LOC_STORE, {
      expectedProfileVersion: staleProfileReview.profile!.version,
      expectedLocationVersion: staleProfileReview.locations.find((location) => location.id === LOC_STORE)!.version,
      publicDisplayName: "A Cards",
      privacyState: "PUBLIC_STOREFRONT",
      publicLocationName: "Canterbury Shop",
      publicStreetAddress: "3 Newer Public Street, Canterbury CT1 3CC",
      publicWebsite: "https://cards.example.test",
      publicPhone: "+44 1227 123456",
      publicEmail: "public@example.test",
      mapsEnabled: true,
      attested: true,
    })).rejects.toMatchObject({ code: "STALE_DRAFT", status: 409 });
    await expect(publication.setAdminPublicPublication({
      tenantId: ORG_A,
      locationId: LOC_STORE,
      enabled: true,
      expectedProfileVersion: staleProfileReview.profile!.version,
      expectedLocationVersion: staleProfileReview.locations.find((location) => location.id === LOC_STORE)!.version,
      reason: "Must reject stale shared-name review",
      adminEmail: "super@example.test",
    })).rejects.toMatchObject({ code: "STALE_PREVIEW", status: 409 });
    expect(await service.getPublicPartnerLocation("storefront-ref-a")).toBeNull();
  });

  it("rolls the public schema back without touching operational Partner data", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const rollback = readFileSync(join(process.cwd(), "migrations/rollback-0102-partner-public-presence.sql"), "utf8");
    // Google tables reference the shared composite constraints but not the two
    // public tables, so only the public authority is removed here.
    await admin.query(rollback);
    const relations = await admin.query(`SELECT to_regclass('public.partner_public_profiles') AS profile,
                                                to_regclass('public.partner_location_publications') AS location`);
    expect(relations.rows[0]).toEqual({ profile: null, location: null });
    expect(Number((await admin.query("SELECT count(*) FROM partner_locations")).rows[0].count)).toBe(3);
  });
});
