import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrationsRealistic, PARTNER_MIGRATIONS } from "./helpers/partner-realistic-db";
import { decryptGoogleSecret, oauthVerifierAad } from "../server/partner/google-presence-crypto";
import type { PartnerPrincipal } from "../server/partner/session";

describe("0101 Partner Google presence (real PostgreSQL 17)", () => {
  let cluster: DisposablePostgres17;
  let admin: Client;
  let runtime: Client;
  const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const LOC_A = "11111111-1111-4111-8111-111111111111";
  const LOC_A2 = "22222222-2222-4222-8222-222222222222";
  const LOC_B = "33333333-3333-4333-8333-333333333333";
  const USER_A = "44444444-4444-4444-8444-444444444444";
  const USER_B = "55555555-5555-4555-8555-555555555555";
  const USER_VIEWER = "88888888-8888-4888-8888-888888888888";
  const SESSION_A = "66666666-6666-4666-8666-666666666666";
  const OWNER_ROLE = "77777777-7777-4777-8777-777777777777";

  beforeAll(async () => {
    cluster = await startPostgres17("partner-google-presence");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await applyMigrationsRealistic(admin, cluster.url, [...PARTNER_MIGRATIONS, "0101_partner_google_presence"]);
    await admin.query(`
      INSERT INTO partner_organisations (id,legal_name,status) VALUES
        ('${ORG_A}','A','ACTIVE'),('${ORG_B}','B','ACTIVE');
      INSERT INTO partner_locations (id,tenant_id,partner_id,name,status) VALUES
        ('${LOC_A}','${ORG_A}','${ORG_A}','A1','ACTIVE'),
        ('${LOC_A2}','${ORG_A}','${ORG_A}','A2','ACTIVE'),
        ('${LOC_B}','${ORG_B}','${ORG_B}','B1','ACTIVE');
      INSERT INTO partner_users (id,tenant_id,partner_id,email,status,credential_version) VALUES
        ('${USER_A}','${ORG_A}','${ORG_A}','a@example.test','ACTIVE',1),
        ('${USER_B}','${ORG_B}','${ORG_B}','b@example.test','ACTIVE',1),
        ('${USER_VIEWER}','${ORG_A}','${ORG_A}','viewer@example.test','ACTIVE',1);
      INSERT INTO partner_user_locations (tenant_id,user_id,location_id)
        VALUES ('${ORG_A}','${USER_VIEWER}','${LOC_A}');
      INSERT INTO partner_sessions
        (id,tenant_id,user_id,token_hash,credential_version,mfa_passed,absolute_expires_at)
      VALUES ('${SESSION_A}','${ORG_A}','${USER_A}','session-a',1,true,now()+interval '1 hour');
      INSERT INTO partner_roles (id,code,label) VALUES ('${OWNER_ROLE}','PARTNER_OWNER','Partner Owner');
      INSERT INTO partner_user_roles (tenant_id,user_id,role_id) VALUES ('${ORG_A}','${USER_A}','${OWNER_ROLE}');
      INSERT INTO partner_feature_flags (tenant_id,location_id,flag,enabled)
        VALUES (NULL,NULL,'google_partner_presence_enabled',true);
    `);
    await admin.query(`DO $$ BEGIN
      CREATE ROLE google_presence_runtime LOGIN PASSWORD 'synthetic' NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query("GRANT partner_runtime TO google_presence_runtime");
    const runtimeUrl = new URL(cluster.url);
    runtimeUrl.username = "google_presence_runtime";
    runtimeUrl.password = "synthetic";
    process.env.PARTNER_DATABASE_URL = runtimeUrl.toString();
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.GOOGLE_BUSINESS_CLIENT_ID = "synthetic-client.apps.googleusercontent.com";
    process.env.GOOGLE_BUSINESS_CLIENT_SECRET = "synthetic-secret";
    process.env.GOOGLE_BUSINESS_OAUTH_REDIRECT_URI = "https://mintvaultuk.com/api/partner/google-business/callback";
    process.env.GOOGLE_BUSINESS_OAUTH_ENC_KEY = Buffer.alloc(32, 9).toString("base64");
    runtime = new Client({ connectionString: runtimeUrl.toString() });
    await runtime.connect();
  }, 120_000);

  afterAll(async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await runtime?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("starts OAuth only for the tenant owner and stores a bound encrypted verifier, never raw state", async () => {
    const service = await import("../server/partner/google-presence-service");
    const capability = await service.getGooglePresenceCapability();
    expect(capability.available).toBe(true);
    if (!capability.available) throw new Error("test configuration unavailable");
    const principal: PartnerPrincipal = {
      sessionId: SESSION_A,
      tenantId: ORG_A,
      userId: USER_A,
      locationId: LOC_A,
      mfaPassed: true,
      permissions: new Set(["partner.location.view"]),
      viewOnly: false,
      sensitiveDisabled: false,
      orgWide: true,
    };
    const started = await service.beginGoogleBusinessConnection(principal, LOC_A, capability.config);
    const authorization = new URL(started.authorizationUrl);
    const rawState = authorization.searchParams.get("state");
    expect(rawState).toBeTruthy();
    const stored = await admin.query<{
      state_hash: string;
      code_verifier_ciphertext: string;
      tenant_id: string;
      location_id: string;
      actor_user_id: string;
      session_id: string;
    }>("SELECT * FROM partner_google_oauth_states WHERE tenant_id=$1", [ORG_A]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].state_hash).not.toBe(rawState);
    expect(stored.rows[0].code_verifier_ciphertext).not.toContain("code_verifier");
    expect(decryptGoogleSecret(
      stored.rows[0].code_verifier_ciphertext,
      capability.config,
      oauthVerifierAad({ tenantId: ORG_A, locationId: LOC_A, userId: USER_A, sessionId: SESSION_A })
    ).length).toBeGreaterThan(40);

    let providerCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      providerCalls += 1;
      const value = String(url);
      if (value === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh-secret", expires_in: 3600 }), { status: 200 });
      }
      if (value.startsWith("https://mybusinessaccountmanagement.googleapis.com/v1/accounts")) {
        return new Response(JSON.stringify({ accounts: [{ name: "accounts/123" }] }), { status: 200 });
      }
      if (value.startsWith("https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations")) {
        return new Response(JSON.stringify({ locations: [{
          name: "locations/456", title: "A Cards", storefrontAddress: { addressLines: ["1 High Street"], locality: "Canterbury" },
          metadata: { placeId: "ChIJ-service", mapsUri: "https://maps.google.com/?cid=456" },
        }] }), { status: 200 });
      }
      throw new Error(`unexpected Google URL ${value}`);
    }) as typeof fetch;
    expect(await service.completeGoogleBusinessOAuth({
      principal, state: rawState!, code: "synthetic-code", config: capability.config, fetchImpl,
    })).toEqual({ locationId: LOC_A, candidateCount: 1 });
    expect(providerCalls).toBe(3);
    await expect(service.completeGoogleBusinessOAuth({
      principal, state: rawState!, code: "synthetic-code", config: capability.config, fetchImpl,
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_replayed" }));
    expect(providerCalls, "a replay is rejected before any provider call").toBe(3);

    const status = await service.getGooglePresenceStatus(principal);
    expect(status.owner).toBe(true);
    expect(status.locations.find((row) => row.locationId === LOC_A)?.state).toBe("CONNECTING");
    const handle = status.locations.find((row) => row.locationId === LOC_A)?.candidates[0]?.handle;
    expect(handle).toBeTruthy();
    const nonOwner = await service.getGooglePresenceStatus({
      ...principal,
      userId: USER_VIEWER,
      orgWide: false,
    });
    expect(nonOwner.owner).toBe(false);
    expect(nonOwner.locations.find((row) => row.locationId === LOC_A)).toEqual(expect.objectContaining({
      state: "CONNECTING",
      candidates: [],
    }));
    await service.confirmGoogleBusinessCandidate({ principal, locationId: LOC_A, candidateHandle: handle! });
    const connected = await service.getGooglePresenceStatus(principal);
    expect(connected.locations.find((row) => row.locationId === LOC_A)).toEqual(expect.objectContaining({
      state: "CONNECTED", businessName: "A Cards", placeId: "ChIJ-service",
    }));
    const credential = await admin.query<{ refresh_token_ciphertext: string }>("SELECT refresh_token_ciphertext FROM partner_google_credentials");
    expect(credential.rows).toHaveLength(1);
    expect(credential.rows[0].refresh_token_ciphertext).not.toContain("refresh-secret");
    expect((await admin.query("SELECT 1 FROM partner_google_profile_cache")).rowCount).toBe(1);

    // Keep later constraint cases independent while retaining the consumed state
    // as replay evidence. Cascades remove only the synthetic connection material.
    await admin.query("DELETE FROM partner_google_connections WHERE tenant_id=$1", [ORG_A]);

    await expect(service.beginGoogleBusinessConnection({ ...principal, tenantId: ORG_B, userId: USER_B }, LOC_B, capability.config))
      .rejects.toEqual(expect.objectContaining({ code: "forbidden", status: 403 }));

    await admin.query(
      `INSERT INTO partner_emergency_controls (tenant_id,location_id,scope,frozen,reason,set_by)
       VALUES ($1,$2,'sensitive',true,'synthetic freeze','test')`,
      [ORG_A, LOC_A2]
    );
    await expect(service.beginGoogleBusinessConnection(principal, LOC_A2, capability.config))
      .rejects.toEqual(expect.objectContaining({ code: "operation_frozen", status: 423 }));
    await admin.query("DELETE FROM partner_emergency_controls WHERE tenant_id=$1", [ORG_A]);
  });

  it("creates separate forced-RLS state, connection, credential, candidate and cache tables", async () => {
    const { rows } = await admin.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname,relforcerowsecurity FROM pg_class
        WHERE relname=ANY($1::text[]) ORDER BY relname`,
      [[
        "partner_google_oauth_states", "partner_google_connections", "partner_google_credentials",
        "partner_google_location_candidates", "partner_google_profile_cache",
      ]]
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.relforcerowsecurity)).toBe(true);
  });

  it("rejects a cross-tenant location binding and duplicate/replayed OAuth state", async () => {
    await expect(admin.query(
      `INSERT INTO partner_google_oauth_states
        (tenant_id,location_id,actor_user_id,session_id,state_hash,code_verifier_ciphertext,expires_at)
       VALUES ($1,$2,$3,$4,$5,'cipher',now()+interval '10 minutes')`,
      [ORG_A, LOC_B, USER_A, SESSION_A, "a".repeat(64)]
    )).rejects.toEqual(expect.objectContaining({ code: "23503" }));
    await admin.query(
      `INSERT INTO partner_google_oauth_states
        (tenant_id,location_id,actor_user_id,session_id,state_hash,code_verifier_ciphertext,expires_at)
       VALUES ($1,$2,$3,$4,$5,'cipher',now()+interval '10 minutes')`,
      [ORG_A, LOC_A, USER_A, SESSION_A, "b".repeat(64)]
    );
    await expect(admin.query(
      `INSERT INTO partner_google_oauth_states
        (tenant_id,location_id,actor_user_id,session_id,state_hash,code_verifier_ciphertext,expires_at)
       VALUES ($1,$2,$3,$4,$5,'cipher',now()+interval '10 minutes')`,
      [ORG_A, LOC_A, USER_A, SESSION_A, "b".repeat(64)]
    )).rejects.toEqual(expect.objectContaining({ code: "23505" }));
    await expect(admin.query(
      `INSERT INTO partner_google_oauth_states
        (tenant_id,location_id,actor_user_id,session_id,state_hash,code_verifier_ciphertext,expires_at)
       VALUES ($1,$2,$3,$4,$5,'cipher',now()+interval '10 minutes')`,
      [ORG_B, LOC_B, USER_B, SESSION_A, "c".repeat(64)]
    )).rejects.toEqual(expect.objectContaining({ code: "23503" }));
  });

  it("enforces one current MintVault location and one current Google resource or Place ID", async () => {
    const insert = (locationId: string, googleLocation: string, placeId: string) => admin.query(
      `INSERT INTO partner_google_connections
        (tenant_id,location_id,google_location_name,google_place_id,connection_status,connected_by)
       VALUES ($1,$2,$3,$4,'CONNECTED',$5)`,
      [ORG_A, locationId, googleLocation, placeId, USER_A]
    );
    await insert(LOC_A, "locations/one", "ChIJ-one");
    await expect(insert(LOC_A, "locations/two", "ChIJ-two"))
      .rejects.toEqual(expect.objectContaining({ code: "23505" }));
    await expect(insert(LOC_A2, "locations/one", "ChIJ-three"))
      .rejects.toEqual(expect.objectContaining({ code: "23505" }));
    await expect(insert(LOC_A2, "locations/three", "ChIJ-one"))
      .rejects.toEqual(expect.objectContaining({ code: "23505" }));
    await admin.query(
      `INSERT INTO partner_google_connections
        (tenant_id,location_id,connection_status,connected_by)
       VALUES ($1,$2,'PENDING_SELECTION',$3)`,
      [ORG_A, LOC_A2, USER_A]
    );
    await expect(admin.query(
      `INSERT INTO partner_google_connections
        (tenant_id,location_id,connection_status,connected_by)
       VALUES ($1,$2,'PENDING_SELECTION',$3)`,
      [ORG_A, LOC_A2, USER_A]
    )).rejects.toEqual(expect.objectContaining({ code: "23505" }));
  });

  it("keeps tenant B rows invisible to a tenant A runtime transaction", async () => {
    await admin.query(
      `INSERT INTO partner_google_connections
        (tenant_id,location_id,google_location_name,connection_status,connected_by)
       VALUES ($1,$2,'locations/b','PENDING_SELECTION',$3)`,
      [ORG_B, LOC_B, USER_B]
    );
    await runtime.query("BEGIN");
    await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [ORG_A]);
    const visible = await runtime.query("SELECT tenant_id FROM partner_google_connections");
    await runtime.query("ROLLBACK");
    expect(visible.rows.every((row) => row.tenant_id === ORG_A)).toBe(true);
    expect(visible.rows.some((row) => row.tenant_id === ORG_B)).toBe(false);
  });

  it("rolls 0101 back cleanly in the disposable database", async () => {
    const rollback = readFileSync(join(process.cwd(), "migrations/rollback-0101-partner-google-presence.sql"), "utf8");
    await admin.query(rollback);
    const relations = await admin.query<{ relation: string | null }>(`
      SELECT to_regclass('public.' || name)::text AS relation
        FROM unnest(ARRAY[
          'partner_google_oauth_states', 'partner_google_connections', 'partner_google_credentials',
          'partner_google_location_candidates', 'partner_google_profile_cache'
        ]) AS name
    `);
    expect(relations.rows.every((row) => row.relation === null)).toBe(true);
    const constraints = await admin.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
       WHERE conname IN ('uq_partner_locations_tenant_id_id','uq_partner_users_tenant_id_id','uq_partner_sessions_tenant_user_id_id')
    `);
    expect(constraints.rows).toEqual([]);
  });
});
