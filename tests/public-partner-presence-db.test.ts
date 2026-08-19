import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

describe("public Partner projection (real PostgreSQL)", () => {
  let cluster: DisposablePostgres17;
  let admin: Client;
  let service: typeof import("../server/partner/public-presence-service");

  const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const LOC_A = "11111111-1111-4111-8111-111111111111";
  const LOC_PRIVATE = "22222222-2222-4222-8222-222222222222";
  const LOC_SUSPENDED = "33333333-3333-4333-8333-333333333333";

  beforeAll(async () => {
    cluster = await startPostgres17("public-partner-presence");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await admin.query(`
      CREATE TABLE partner_organisations (
        id uuid PRIMARY KEY, public_ref text UNIQUE NOT NULL, legal_name text NOT NULL,
        status text NOT NULL, tenant_id uuid GENERATED ALWAYS AS (id) STORED
      );
      CREATE TABLE partner_locations (
        id uuid PRIMARY KEY, public_ref text UNIQUE NOT NULL, tenant_id uuid NOT NULL,
        partner_id uuid NOT NULL, name text NOT NULL, address text, status text NOT NULL
      );
      CREATE TABLE partner_profiles (
        tenant_id uuid PRIMARY KEY, trading_name text, website text, primary_phone text, onboarding_date date
      );
      CREATE TABLE partner_branding (
        tenant_id uuid PRIMARY KEY, display_name text, support_email text, support_website text,
        branding_status text NOT NULL
      );
      CREATE TABLE partner_feature_flags (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, location_id uuid,
        flag text NOT NULL, enabled boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE certificates (
        id serial PRIMARY KEY, origin_type text, origin_partner_id uuid, origin_location_id uuid,
        status text, deleted_at timestamptz, grade numeric, grade_approved_at timestamptz
      );
    `);
    await admin.query(
      `INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES
       ($1,'org-a-public','A Legal Ltd','ACTIVE'), ($2,'org-b-public','B Legal Ltd','ACTIVE')`,
      [ORG_A, ORG_B]
    );
    await admin.query(
      `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, address, status) VALUES
       ($1::uuid,$1::text,$4,$4,'Canterbury Shop','100% Cards, 1 High Street, Canterbury CT1 1AA','ACTIVE'),
       ($2::uuid,$2::text,$4,$4,'Private Shop','2 High Street, Dover CT16 1AA','ACTIVE'),
       ($3::uuid,$3::text,$5,$5,'Suspended Shop','3 High Street, York YO1 1AA','SUSPENDED')`,
      [LOC_A, LOC_PRIVATE, LOC_SUSPENDED, ORG_A, ORG_B]
    );
    await admin.query(
      `INSERT INTO partner_profiles (tenant_id, trading_name, website, primary_phone, onboarding_date)
       VALUES ($1,'A Trading','javascript:alert(1)','+44 1227 123456','2026-08-01')`,
      [ORG_A]
    );
    await admin.query(
      `INSERT INTO partner_branding (tenant_id, display_name, support_email, support_website, branding_status)
       VALUES ($1,'A Cards','public@example.test','https://cards.example.test','ready')`,
      [ORG_A]
    );
    service = await import("../server/partner/public-presence-service");
  }, 120_000);

  afterAll(async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("fails closed until both the global switch and exact location opt-in exist", async () => {
    expect(await service.listPublicPartnerLocations()).toEqual([]);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL,NULL,$1,true)",
      [service.PUBLIC_DIRECTORY_FLAG]
    );
    expect(await service.listPublicPartnerLocations()).toEqual([]);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES ($1,$2,$3,true)",
      [ORG_A, LOC_A, service.PUBLIC_LOCATION_FLAG]
    );
    // An ACTIVE location with an explicit flag but no approved public display
    // name must remain private; legal_name is not a public fallback.
    await admin.query("UPDATE partner_locations SET status='ACTIVE' WHERE id=$1", [LOC_SUSPENDED]);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES ($1,$2,$3,true)",
      [ORG_B, LOC_SUSPENDED, service.PUBLIC_LOCATION_FLAG]
    );
    const visible = await service.listPublicPartnerLocations();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toEqual({
      publicRef: LOC_A,
      displayName: "A Cards",
      locationName: "Canterbury Shop",
      address: "100% Cards, 1 High Street, Canterbury CT1 1AA",
      designation: "MintVault Partner",
      websiteUrl: "https://cards.example.test/",
      phone: "+44 1227 123456",
      email: "public@example.test",
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=100%25%20Cards%2C%201%20High%20Street%2C%20Canterbury%20CT1%201AA",
      cardsGraded: null,
      partnerSince: "2026-08-01",
    });
    expect(Object.keys(visible[0]).sort()).toEqual([
      "address", "cardsGraded", "designation", "displayName", "email", "locationName", "mapsUrl",
      "partnerSince", "phone", "publicRef", "websiteUrl",
    ].sort());
  });

  it("counts only approved active nondeleted immutable location-origin certificates", async () => {
    await admin.query(
      `INSERT INTO certificates (origin_type, origin_partner_id, origin_location_id, status, deleted_at, grade, grade_approved_at) VALUES
       ('PARTNER',$1,$2,'active',NULL,9,now()),
       ('PARTNER',$1,$2,'active',NULL,9,NULL),
       ('PARTNER',$1,$2,'active',now(),9,now()),
       ('PARTNER',$1,$2,'draft',NULL,9,now()),
       ('HQ',NULL,NULL,'active',NULL,9,now())`,
      [ORG_A, LOC_A]
    );
    expect((await service.getPublicPartnerLocation(LOC_A))?.cardsGraded).toBe(1);
  });

  it("uses an unexpired connected Google cache for exact Maps routing and rejects a hostile URI", async () => {
    await admin.query(`
      CREATE TABLE partner_google_connections (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, location_id uuid NOT NULL,
        connection_status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE partner_google_profile_cache (
        connection_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, location_id uuid NOT NULL,
        business_name text NOT NULL, google_place_id text, google_maps_uri text, expires_at timestamptz NOT NULL
      );
    `);
    await admin.query(`
      INSERT INTO partner_google_connections (id,tenant_id,location_id,connection_status)
        VALUES ('44444444-4444-4444-8444-444444444444',$1,$2,'CONNECTED')
    `, [ORG_A, LOC_A]);
    await admin.query(`
      INSERT INTO partner_google_profile_cache
        (connection_id,tenant_id,location_id,business_name,google_place_id,google_maps_uri,expires_at)
        VALUES ('44444444-4444-4444-8444-444444444444',$1,$2,'A Cards','ChIJ_12345',
                'https://maps.google.com/?cid=123',now()+interval '1 hour')
    `, [ORG_A, LOC_A]);
    expect((await service.getPublicPartnerLocation(LOC_A))?.mapsUrl).toBe("https://maps.google.com/?cid=123");
    await admin.query(
      "UPDATE partner_google_profile_cache SET google_maps_uri='https://google.com.evil.example/listing'"
    );
    expect((await service.getPublicPartnerLocation(LOC_A))?.mapsUrl).toBe(
      "https://www.google.com/maps/search/?api=1&query=A%20Cards&query_place_id=ChIJ_12345"
    );
  });

  it("treats search metacharacters literally and removes a disabled/suspended location immediately", async () => {
    expect(await service.listPublicPartnerLocations({ search: "%" })).toHaveLength(1);
    expect(await service.listPublicPartnerLocations({ search: "_" })).toHaveLength(0);
    await admin.query("UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1", [LOC_A]);
    expect(await service.getPublicPartnerLocation(LOC_A)).toBeNull();
    expect(await service.getPublicPartnerLocation("../admin")).toBeNull();
    await admin.query("UPDATE partner_locations SET status='ACTIVE' WHERE id=$1", [LOC_A]);
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled, updated_at) VALUES ($1,$2,$3,false,now()+interval '1 second')",
      [ORG_A, LOC_A, service.PUBLIC_LOCATION_FLAG]
    );
    expect(await service.getPublicPartnerLocation(LOC_A)).toBeNull();
  });

  it("keeps controlled concurrent directory/search/profile latency bounded", async () => {
    const inserted = await admin.query<{ public_ref: string }>(`
      INSERT INTO partner_locations (id,public_ref,tenant_id,partner_id,name,address,status)
      SELECT gen_random_uuid(), gen_random_uuid()::text, $1, $1,
             'Load Shop ' || g, g || ' Load Street, Load Town LT1 1AA', 'ACTIVE'
        FROM generate_series(1,100) g
      RETURNING public_ref
    `, [ORG_A]);
    await admin.query(`
      INSERT INTO partner_feature_flags (tenant_id,location_id,flag,enabled)
      SELECT tenant_id,id,$2,true FROM partner_locations WHERE tenant_id=$1 AND name LIKE 'Load Shop %'
    `, [ORG_A, service.PUBLIC_LOCATION_FLAG]);

    await service.listPublicPartnerLocations({ limit: 100 });
    const samples: number[] = [];
    const errors: unknown[] = [];
    const operations = Array.from({ length: 36 }, (_, index) => async () => {
      const start = performance.now();
      try {
        if (index % 3 === 0) await service.listPublicPartnerLocations({ limit: 100 });
        else if (index % 3 === 1) await service.listPublicPartnerLocations({ search: "Load Town 4", limit: 100 });
        else await service.getPublicPartnerLocation(inserted.rows[index % inserted.rows.length].public_ref);
      } catch (error) {
        errors.push(error);
      } finally {
        samples.push(performance.now() - start);
      }
    });
    for (let offset = 0; offset < operations.length; offset += 12) {
      await Promise.all(operations.slice(offset, offset + 12).map((operation) => operation()));
    }
    const ordered = [...samples].sort((a, b) => a - b);
    const percentile = (value: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * value) - 1)];
    const metrics = {
      requests: samples.length,
      errors: errors.length,
      p50Ms: Number(percentile(0.5).toFixed(2)),
      p95Ms: Number(percentile(0.95).toFixed(2)),
    };
    console.info("PUBLIC_PARTNER_PERF", JSON.stringify(metrics));
    expect(metrics).toEqual(expect.objectContaining({ requests: 36, errors: 0 }));
    expect(metrics.p95Ms).toBeLessThan(2_000);
  });
});
