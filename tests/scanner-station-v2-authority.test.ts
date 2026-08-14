import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  applyMigrationsRealistic,
  PARTNER_SCHEMA_MIGRATIONS,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";

let cluster: DisposablePostgres17;
let admin: Client;
let savedEnv: Record<string, string | undefined> = {};

const migrations = [
  ...PARTNER_SCHEMA_MIGRATIONS,
  "0075_partner_station_single_active_capture",
  "0091_scanner_station_v2_authority",
] as const;

async function seedCore(): Promise<void> {
  await admin.query(`
    CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique);
    CREATE TABLE submissions (
      id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
      tracking_number text not null unique, deleted_at timestamptz,
      status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
    );
    CREATE TABLE submission_items (id serial primary key, submission_id integer not null);
    CREATE TABLE cards (id serial primary key, submission_id integer not null);
    CREATE TABLE audit_log (
      id serial primary key, entity_type text not null, entity_id text not null, action text not null,
      admin_user text, details jsonb, created_at timestamptz not null default now()
    );
    CREATE TABLE certificates (
      id serial primary key, certificate_number text not null unique,
      card_id integer, submission_item_id integer, status text not null default 'active',
      label_type text not null default 'Standard', grade_type text not null default 'numeric',
      source text, scan_status text, raw_uploaded boolean not null default false, created_by text,
      issued_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz, origin_type text, origin_partner_id uuid,
      origin_partner_public_ref text, origin_partner_legal_name text, origin_partner_trading_name text,
      origin_location_id uuid, origin_location_public_ref text, origin_location_name text,
      origin_location_address text, origin_captured_at timestamptz, origin_snapshot_version integer
    );
    CREATE TABLE cert_counter (
      id integer primary key,last_issued bigint not null default 0,updated_at timestamptz not null default now()
    );
    INSERT INTO cert_counter (id,last_issued) VALUES (1,0);
  `);
  for (const table of ["users", "submissions", "submission_items", "cards", "audit_log", "certificates", "cert_counter"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`).catch(() => {});
  }
}

beforeAll(async () => {
  savedEnv = Object.fromEntries([
    "MINTVAULT_DATABASE_URL",
    "PARTNER_ADMIN_DATABASE_URL",
    "PARTNER_DATABASE_URL",
    "PARTNER_CONNECTOR_DATABASE_URL",
  ].map((key) => [key, process.env[key]]));
  cluster = await startPostgres17("scanner-station-v2-authority");
  admin = new Client({ connectionString: cluster.url });
  await admin.connect();
  await provisionRealisticRoles(admin);
  await seedCore();
  await applyMigrationsRealistic(admin, cluster.url, migrations);
  for (const key of Object.keys(savedEnv)) process.env[key] = cluster.url;
}, 120_000);

afterAll(async () => {
  const [{ closePartnerPools }, { pool }] = await Promise.all([
    import("../server/partner/db"),
    import("../server/db"),
  ]);
  await Promise.all([closePartnerPools(), pool.end()]);
  await admin?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Scanner station v2 authority", () => {
  it("applies the additive authority schema with exact uniqueness contracts", async () => {
    const tables = await admin.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables WHERE table_schema='public'
       AND table_name IN ('scanner_station_semantic_operations','partner_station_enrolment_operations',
                          'partner_station_profile_revisions','scanner_capture_rescan_operations',
                          'partner_scanner_refresh_sessions')
       ORDER BY table_name`);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "partner_scanner_refresh_sessions",
      "partner_station_enrolment_operations",
      "partner_station_profile_revisions",
      "scanner_capture_rescan_operations",
      "scanner_station_semantic_operations",
    ]);
    const columns = await admin.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns WHERE table_name='scanner_capture_sessions'
       AND column_name IN ('capture_authorisation_id','semantic_operation_id','card_job_id',
                           'profile_revision_id','original_operator_id','authorisation_expires_at')
       ORDER BY column_name`);
    expect(columns.rows).toHaveLength(6);
    const sessionColumns = await admin.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns WHERE table_name='partner_sessions'
       AND column_name IN ('session_kind','station_id','scanner_refresh_id') ORDER BY column_name`);
    expect(sessionColumns.rows.map((row) => row.column_name)).toEqual([
      "scanner_refresh_id",
      "session_kind",
      "station_id",
    ]);
  });

  it("binds Scanner refresh to one station, enforces 15m access and leaves background idle untouched", async () => {
    const tenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status)
       VALUES ('scanner-session-org','Scanner Session Org','ACTIVE') RETURNING id`
    )).rows[0].id;
    const locationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('scanner-session-loc',$1,$1,'Session Shop','7 Test Street','ACTIVE') RETURNING id`, [tenantId]
    )).rows[0].id;
    const userId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id,partner_id,email,status,password_set_at)
       VALUES ($1,$1,'scanner-session@example.test','ACTIVE',now()) RETURNING id`, [tenantId]
    )).rows[0].id;
    await admin.query(
      `INSERT INTO partner_user_locations (tenant_id,user_id,location_id) VALUES ($1,$2,$3)`,
      [tenantId, userId, locationId]
    );
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id,user_id,role_id)
       SELECT $1,$2,id FROM partner_roles WHERE code='SCANNER_OPERATOR'`,
      [tenantId, userId]
    );
    const makeStation = async (code: string) => {
      const keys = crypto.generateKeyPairSync("ed25519");
      const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
      const { stationPublicKeyFingerprint } = await import("../server/partner/station-identity");
      return (await admin.query<{ id: string }>(
        `INSERT INTO partner_stations
           (station_code,tenant_id,location_id,status,public_key_pem,public_key_fingerprint,app_version)
         VALUES ($1,$2,$3,'ACTIVE',$4,$5,'1.0.0') RETURNING id`,
        [code, tenantId, locationId, publicKeyPem, stationPublicKeyFingerprint(publicKeyPem)]
      )).rows[0].id;
    };
    const stationCode = "MV-STN-SSSSSSSSSSSSSSSS";
    const stationId = await makeStation(stationCode);
    const otherStationId = await makeStation("MV-STN-TTTTTTTTTTTTTTTT");
    const accessToken = crypto.randomBytes(32).toString("base64url");
    const sessionId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_sessions
         (tenant_id,user_id,location_id,token_hash,credential_version,mfa_passed,absolute_expires_at,session_kind)
       VALUES ($1,$2,$3,$4,1,true,now()+interval '15 minutes','SCANNER') RETURNING id`,
      [tenantId, userId, locationId, crypto.createHash("sha256").update(accessToken).digest("hex")]
    )).rows[0].id;
    const service = await import("../server/partner/scanner-session-service");
    const station = {
      id: stationId,
      code: stationCode,
      tenantId,
      locationId,
      appVersion: "1.0.0",
      scannerProfileVersion: null,
      calibrationStatus: "UNPROVISIONED" as const,
      currentCalibrationId: null,
      currentProfileRevisionId: null,
      protocol: 1 as const,
      semanticOperationId: null,
    };
    const bound = await service.bindScannerRefreshSession(station, {
      sessionId,
      tenantId,
      userId,
      locationId,
      mfaPassed: true,
      permissions: new Set(["partner.cards.scan"]),
      viewOnly: false,
      sensitiveDisabled: false,
      orgWide: false,
      sessionKind: "SCANNER",
      stationId: null,
    });
    expect(bound).toMatchObject({ stationCode });
    expect(bound.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    await expect(service.refreshScannerAccessSession({ ...station, id: otherStationId }, bound.refreshToken))
      .rejects.toMatchObject({ code: "forbidden" });
    const refreshed = await service.refreshScannerAccessSession(station, bound.refreshToken);
    const refreshedRow = (await admin.query<{
      station_id: string;
      session_kind: string;
      lifetime_seconds: number;
      last_seen_at: string;
    }>(
      `SELECT station_id,session_kind,
              extract(epoch FROM (absolute_expires_at-created_at))::int AS lifetime_seconds,last_seen_at
         FROM partner_sessions WHERE token_hash=$1`,
      [crypto.createHash("sha256").update(refreshed.accessToken).digest("hex")]
    )).rows[0];
    expect(refreshedRow).toMatchObject({ station_id: stationId, session_kind: "SCANNER", lifetime_seconds: 900 });
    const sessions = await import("../server/partner/session");
    await sessions.resolvePartnerSession(refreshed.accessToken, { touchActivity: false });
    const afterBackground = (await admin.query<{ last_seen_at: string }>(
      `SELECT last_seen_at FROM partner_sessions WHERE token_hash=$1`,
      [crypto.createHash("sha256").update(refreshed.accessToken).digest("hex")]
    )).rows[0].last_seen_at;
    expect(new Date(afterBackground).toISOString()).toBe(new Date(refreshedRow.last_seen_at).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sessions.resolvePartnerSession(refreshed.accessToken);
    const afterActivity = (await admin.query<{ touched: boolean }>(
      `SELECT last_seen_at > $2::timestamptz AS touched FROM partner_sessions WHERE token_hash=$1`,
      [crypto.createHash("sha256").update(refreshed.accessToken).digest("hex"), afterBackground]
    )).rows[0].touched;
    expect(afterActivity).toBe(true);
    await service.revokeScannerSession(station, bound.refreshToken);
    await expect(sessions.resolvePartnerSession(refreshed.accessToken)).resolves.toBeNull();
  }, 60_000);

  it("accepts one global v2 sequence and durably replays one exact semantic result", async () => {
    const tenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status) VALUES ('v2-org','V2 Org','ACTIVE') RETURNING id`
    )).rows[0].id;
    const locationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('v2-loc',$1,$1,'V2 Shop','1 Test Street','ACTIVE') RETURNING id`, [tenantId]
    )).rows[0].id;
    const actorUserId = crypto.randomUUID();
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const { stationPublicKeyFingerprint, canonicalStationRequestV2 } = await import("../server/partner/station-identity");
    const stationCode = "MV-STN-VVVVVVVVVVVVVVVV";
    const stationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_stations
         (station_code,tenant_id,location_id,status,public_key_pem,public_key_fingerprint,app_version)
       VALUES ($1,$2,$3,'ACTIVE',$4,$5,'1.0.0') RETURNING id`,
      [stationCode, tenantId, locationId, publicKeyPem, stationPublicKeyFingerprint(publicKeyPem)]
    )).rows[0].id;
    void stationId;
    const semanticOperationId = crypto.randomUUID();
    const body = Buffer.from('{"scope":"exact"}');
    const envelope = {
      stationCode,
      credentialEpoch: 1n,
      requestEpoch: 1n,
      sequence: 1n,
      method: "POST",
      path: "/api/partner/card-jobs/example/fix-authorise",
      timestamp: Date.now(),
      contentSha256: crypto.createHash("sha256").update(body).digest("hex"),
      semanticOperationId,
    };
    const headers = {
      "x-mintvault-station-protocol": "2",
      "x-mintvault-station-id": stationCode,
      "x-mintvault-station-credential-epoch": "1",
      "x-mintvault-station-request-epoch": "1",
      "x-mintvault-station-sequence": "1",
      "x-mintvault-station-timestamp": String(envelope.timestamp),
      "x-mintvault-content-sha256": envelope.contentSha256,
      "x-mintvault-semantic-operation-id": semanticOperationId,
      "x-mintvault-station-signature": crypto.sign(
        null,
        Buffer.from(canonicalStationRequestV2(envelope)),
        keys.privateKey
      ).toString("base64url"),
    };
    const { authenticateStationRequest } = await import("../server/partner/station-service");
    const principal = await authenticateStationRequest(headers, envelope.method, envelope.path, body);
    expect(principal).toMatchObject({ protocol: 2, semanticOperationId, tenantId, locationId });
    await expect(authenticateStationRequest(headers, envelope.method, envelope.path, body)).rejects.toMatchObject({
      code: "station_replay",
    });

    const authority = await import("../server/partner/scanner-station-authority");
    expect(await authority.beginStationSemanticOperation({
      station: principal,
      actorUserId,
      operationType: "FIX_AUTHORISE",
      endpoint: envelope.path,
      payload: { sides: ["front"] },
    })).toBeNull();
    await authority.completeStationSemanticOperation({ station: principal, status: 200, body: { fix: "bound" } });
    await expect(authority.beginStationSemanticOperation({
      station: principal,
      actorUserId,
      operationType: "FIX_AUTHORISE",
      endpoint: envelope.path,
      payload: { sides: ["front"] },
    })).resolves.toMatchObject({ status: 200, body: { fix: "bound" }, replayed: true });
    await expect(authority.beginStationSemanticOperation({
      station: principal,
      actorUserId,
      operationType: "FIX_AUTHORISE",
      endpoint: envelope.path,
      payload: { sides: ["back"] },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const otherTenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status)
       VALUES ('v2-cross-tenant','V2 Cross Tenant','ACTIVE') RETURNING id`
    )).rows[0].id;
    const otherLocationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('v2-cross-location',$1,$1,'Cross Shop','9 Test Street','ACTIVE') RETURNING id`,
      [otherTenantId]
    )).rows[0].id;
    const otherKeys = crypto.generateKeyPairSync("ed25519");
    const otherPublicKeyPem = otherKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const otherStationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_stations
         (station_code,tenant_id,location_id,status,public_key_pem,public_key_fingerprint,app_version)
       VALUES ('MV-STN-XXXXXXXXXXXXXXXX',$1,$2,'ACTIVE',$3,$4,'1.0.0') RETURNING id`,
      [otherTenantId, otherLocationId, otherPublicKeyPem, stationPublicKeyFingerprint(otherPublicKeyPem)]
    )).rows[0].id;
    await expect(authority.beginStationSemanticOperation({
      station: {
        ...principal,
        id: otherStationId,
        code: "MV-STN-XXXXXXXXXXXXXXXX",
        tenantId: otherTenantId,
        locationId: otherLocationId,
      },
      actorUserId,
      operationType: "FIX_AUTHORISE",
      endpoint: envelope.path,
      payload: { sides: ["front"] },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const resyncPrincipal = {
      sessionId: crypto.randomUUID(), tenantId, userId: actorUserId, locationId,
      mfaPassed: true, permissions: new Set(["partner.cards.scan"]), viewOnly: false,
      sensitiveDisabled: false, orgWide: false,
    };
    const resync = await import("../server/partner/station-resync-service");
    const challenge = await resync.issueStationResyncChallenge(resyncPrincipal, stationCode);
    const { canonicalStationResyncChallenge } = await import("../server/partner/station-identity");
    const resyncSignature = crypto.sign(null, Buffer.from(canonicalStationResyncChallenge({
      stationCode,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
    })), keys.privateKey).toString("base64url");
    await expect(resync.completeStationResync(resyncPrincipal, {
      stationCode,
      challengeId: challenge.challengeId,
      signature: resyncSignature,
    })).resolves.toEqual({ stationCode, credentialEpoch: 1, requestEpoch: 2, requestSequence: 0 });
    await expect(resync.completeStationResync(resyncPrincipal, {
      stationCode,
      challengeId: challenge.challengeId,
      signature: resyncSignature,
    })).rejects.toMatchObject({ code: "forbidden" });

    const after = { ...envelope, requestEpoch: 2n, sequence: 1n, semanticOperationId: crypto.randomUUID(), timestamp: Date.now() };
    const afterHeaders = {
      ...headers,
      "x-mintvault-station-request-epoch": "2",
      "x-mintvault-station-sequence": "1",
      "x-mintvault-station-timestamp": String(after.timestamp),
      "x-mintvault-semantic-operation-id": after.semanticOperationId,
      "x-mintvault-station-signature": crypto.sign(
        null,
        Buffer.from(canonicalStationRequestV2(after)),
        keys.privateKey
      ).toString("base64url"),
    };
    await expect(authenticateStationRequest(afterHeaders, after.method, after.path, body)).resolves.toMatchObject({
      protocol: 2,
      semanticOperationId: after.semanticOperationId,
    });
  }, 60_000);

  it("arms an exact FRONT authority and cancels it with one durable credit release", async () => {
    const tenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status) VALUES ('cancel-org','Cancel Org','ACTIVE') RETURNING id`
    )).rows[0].id;
    await admin.query(`INSERT INTO partner_profiles (tenant_id,trading_name) VALUES ($1,'Cancel Cards')`, [tenantId]);
    const locationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('cancel-loc',$1,$1,'Cancel Shop','2 Test Street','ACTIVE') RETURNING id`, [tenantId]
    )).rows[0].id;
    const actorUserId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref,tenant_id,partner_id,email,status)
       VALUES ('cancel-user',$1,$1,'cancel@shop.test','ACTIVE') RETURNING id`, [tenantId]
    )).rows[0].id;
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const { stationPublicKeyFingerprint } = await import("../server/partner/station-identity");
    const stationCode = "MV-STN-CCCCCCCCCCCCCCCC";
    const stationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_stations
         (station_code,tenant_id,location_id,status,public_key_pem,public_key_fingerprint,app_version,
          scanner_profile_version,calibration_status)
       VALUES ($1,$2,$3,'ACTIVE',$4,$5,'1.0.0','mintvault-canon-lide-400-v3','VALID') RETURNING id`,
      [stationCode, tenantId, locationId, publicKeyPem, stationPublicKeyFingerprint(publicKeyPem)]
    )).rows[0].id;
    const profileRevisionId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO partner_station_profile_revisions
         (id,station_id,tenant_id,location_id,semantic_operation_id,candidate_digest_sha256,
          profile_digest_sha256,profile,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8)`,
      [profileRevisionId, stationId, tenantId, locationId, crypto.randomUUID(), "a".repeat(64), "b".repeat(64), actorUserId]
    );
    await admin.query(`UPDATE partner_stations SET current_profile_revision_id=$2 WHERE id=$1`, [stationId, profileRevisionId]);

    const wallet = await import("../server/partner/partner-wallet-service");
    const actor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };
    await wallet.ensureWallet(actor, tenantId);
    await wallet.appendFoundationCredit(actor, {
      tenantId,
      amount: 1,
      entryType: "purchase",
      source: "admin",
      reason: "Scanner cancellation proof",
      idempotencyKey: `scanner-cancel-credit:${tenantId}`,
      actorType: "admin",
    });
    const cardJobs = await import("../server/partner/card-job-authority");
    const newOperationId = crypto.randomUUID();
    const started = await cardJobs.startNewCardJobAtStation({
      tenantId,
      locationId,
      stationId,
      clientOpId: newOperationId,
      actorUserId,
      actorEmail: "cancel@shop.test",
      cardName: "Cancellation proof",
    });
    const crossTenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status)
       VALUES ('cancel-cross-org','Cancel Cross Org','ACTIVE') RETURNING id`
    )).rows[0].id;
    const crossLocationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('cancel-cross-loc',$1,$1,'Cross Cancel Shop','10 Test Street','ACTIVE') RETURNING id`,
      [crossTenantId]
    )).rows[0].id;
    await expect(cardJobs.startNewCardJobAtStation({
      tenantId: crossTenantId,
      locationId: crossLocationId,
      stationId: crypto.randomUUID(),
      clientOpId: newOperationId,
      actorUserId: crypto.randomUUID(),
      actorEmail: "cross@shop.test",
      cardName: "Cross-tenant reuse",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const captures = await import("../server/scanner-capture-service");
    const armed = await captures.ensureNextCardJobCaptureSession({
      cardJobId: started.cardJobId,
      stationId,
      actorId: actorUserId,
    });
    expect(armed).toMatchObject({
      cardJobId: started.cardJobId,
      side: "front",
      tenantId,
      locationId,
      stationId,
      originalOperatorId: actorUserId,
      originalOperatorRole: "SCANNER_OPERATOR",
      capturePurpose: "AUTHORITATIVE_CARD_CAPTURE",
      revision: 1,
      cancelEligible: true,
    });
    expect(armed?.captureAuthorisationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(armed?.semanticOperationId).toMatch(/^[0-9a-f-]{36}$/);
    const claimed = await captures.claimNextScannerCapture(stationCode, stationCode, stationId);
    expect(claimed?.state).toBe("claimed");
    const rescanOperationId = crypto.randomUUID();
    const rescanned = await captures.issueScannerRescanAuthorisation({
      sessionId: claimed!.id,
      deviceId: stationCode,
      stationId,
      priorCaptureAuthorisationId: claimed!.captureAuthorisationId,
      requestOperationId: rescanOperationId,
    });
    expect(rescanned).toMatchObject({
      id: claimed!.id,
      cardJobId: claimed!.cardJobId,
      side: claimed!.side,
      stationId,
      tenantId,
      locationId,
      originalOperatorId: actorUserId,
      originalOperatorRole: claimed!.originalOperatorRole,
      profileRevisionId,
      capturePurpose: claimed!.capturePurpose,
      revision: 2,
    });
    expect(rescanned.captureAuthorisationId).not.toBe(claimed!.captureAuthorisationId);
    expect(rescanned.semanticOperationId).not.toBe(claimed!.semanticOperationId);
    await expect(captures.issueScannerRescanAuthorisation({
      sessionId: claimed!.id,
      deviceId: stationCode,
      stationId,
      priorCaptureAuthorisationId: claimed!.captureAuthorisationId,
      requestOperationId: rescanOperationId,
    })).resolves.toMatchObject({
      captureAuthorisationId: rescanned.captureAuthorisationId,
      semanticOperationId: rescanned.semanticOperationId,
      revision: 2,
    });
    await expect(captures.issueScannerRescanAuthorisation({
      sessionId: claimed!.id,
      deviceId: stationCode,
      stationId,
      priorCaptureAuthorisationId: claimed!.captureAuthorisationId,
      requestOperationId: crypto.randomUUID(),
    })).rejects.toThrow(/exact current claimed authorisation/);

    const cancelOperationId = crypto.randomUUID();
    const station = {
      id: stationId,
      code: stationCode,
      tenantId,
      locationId,
      appVersion: "1.0.0",
      scannerProfileVersion: "mintvault-canon-lide-400-v3",
      calibrationStatus: "VALID" as const,
      currentCalibrationId: null,
      currentProfileRevisionId: profileRevisionId,
      protocol: 2 as const,
      semanticOperationId: cancelOperationId,
    };
    const cancellation = await import("../server/partner/card-job-cancellation");
    const input = {
      station,
      actorUserId,
      cardJobId: started.cardJobId,
      clientOpId: cancelOperationId,
      captureSessionId: claimed!.id,
      captureAuthorisationId: rescanned.captureAuthorisationId!,
    };
    await expect(cancellation.cancelCardJobBeforeEvidence(input)).resolves.toMatchObject({
      status: "CANCELLED",
      reservationReleased: true,
      acceptedEvidenceCount: 0,
      creditSpent: false,
    });
    await expect(cancellation.cancelCardJobBeforeEvidence(input)).resolves.toMatchObject({
      status: "CANCELLED",
      reservationReleased: true,
    });
    const result = await admin.query<{
      job_status: string;
      reservation_status: string;
      release_events: string;
      capture_state: string;
    }>(
      `SELECT job.status AS job_status,r.status AS reservation_status,capture.state AS capture_state,
              (SELECT count(*)::text FROM partner_credit_reservation_events e
                WHERE e.reservation_id=r.id AND e.event_type='released') AS release_events
         FROM partner_card_jobs job
         JOIN partner_credit_reservations r ON r.id=job.reservation_id
         JOIN scanner_capture_sessions capture ON capture.card_job_id=job.id
        WHERE job.id=$1`,
      [started.cardJobId]
    );
    expect(result.rows[0]).toEqual({
      job_status: "CANCELLED",
      reservation_status: "released",
      release_events: "1",
      capture_state: "cancelled",
    });
  }, 60_000);

  it("accepts one exact immutable Scanner profile revision and rejects candidate drift", async () => {
    const tenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status)
       VALUES ('profile-v2-org','Profile V2 Org','ACTIVE') RETURNING id`
    )).rows[0].id;
    const locationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('profile-v2-loc',$1,$1,'Profile Shop','6 Test Street','ACTIVE') RETURNING id`, [tenantId]
    )).rows[0].id;
    const actorUserId = crypto.randomUUID();
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const { stationPublicKeyFingerprint } = await import("../server/partner/station-identity");
    const stationCode = "MV-STN-PPPPPPPPPPPPPPPP";
    const stationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_stations
         (station_code,tenant_id,location_id,status,public_key_pem,public_key_fingerprint,app_version)
       VALUES ($1,$2,$3,'ACTIVE',$4,$5,'1.0.0') RETURNING id`,
      [stationCode, tenantId, locationId, publicKeyPem, stationPublicKeyFingerprint(publicKeyPem)]
    )).rows[0].id;
    const semanticOperationId = crypto.randomUUID();
    const station = {
      id: stationId,
      code: stationCode,
      tenantId,
      locationId,
      appVersion: "1.0.0",
      scannerProfileVersion: null,
      calibrationStatus: "UNPROVISIONED" as const,
      currentCalibrationId: null,
      currentProfileRevisionId: null,
      protocol: 2 as const,
      semanticOperationId,
    };
    const authority = await import("../server/partner/scanner-station-authority");
    const profile = {
      stationCode,
      semanticOperationId,
      scannerHardware: { manufacturer: "Canon", model: "CanoScan LiDE 400", deviceId: "ica:profile-proof" },
      globalProfileVersion: "mintvault-canon-lide-400-v3",
      calibrationVersion: "mintvault-lide400-jig-v1",
      acquisitionRegion: { x: 22, y: 39, width: 100, height: 130 },
      workingRegion: { x: 40, y: 60, width: 63, height: 88 },
      placementToleranceMm: { left: 14, right: 14, top: 14, bottom: 14 },
      requestedDpi: 1200,
      colourMode: "RGB",
      bitDepth: 8,
      outputFormat: "TIFF",
      presentationRotationDegrees: 180,
      appVersion: "1.0.0",
      captureHelperVersion: "1.0.1",
      identityHelperVersion: "1.0.1",
      capabilityProof: {
        sha256: "c".repeat(64),
        sizeBytes: 87_000_000,
        format: "TIFF",
        requestedDpi: 1200,
        driverResolutionDpi: 1200,
        colourMode: "RGB",
        bitDepth: 8,
        widthPx: 4724,
        heightPx: 6142,
        acquisitionRegion: { x: 22, y: 39, width: 100, height: 130 },
        captureHelperVersion: "1.0.1",
        frameAssessment: {
          accepted: true,
          cardBoundsMm: { x: 40, y: 60, width: 63, height: 88 },
          evidenceMarginMm: { left: 18, right: 19, top: 21, bottom: 21 },
        },
      },
      deviceCreatedAt: new Date().toISOString(),
      deviceTimestampAuthority: "NON_AUTHORITATIVE",
    };
    const candidateDigestSha256 = authority.scannerRequestFingerprint(profile);
    const payload = {
      schemaVersion: 1,
      semanticOperationId,
      clientOpId: semanticOperationId,
      candidateDigestSha256,
      profile,
    };
    expect(await authority.beginStationSemanticOperation({
      station,
      actorUserId,
      operationType: "PROFILE_ACCEPT",
      endpoint: "/api/partner/stations/calibrations",
      payload,
    })).toBeNull();
    const accepted = await authority.acceptStationProfileRevision({ station, actorUserId, payload });
    expect(accepted).toMatchObject({
      semanticOperationId,
      candidateDigestSha256,
      calibrationStatus: "VALID",
    });
    expect(accepted.profileRevisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.profileDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(authority.acceptStationProfileRevision({ station, actorUserId, payload }))
      .resolves.toMatchObject({ profileRevisionId: accepted.profileRevisionId });
    await expect(authority.acceptStationProfileRevision({
      station,
      actorUserId,
      payload: { ...payload, candidateDigestSha256: "d".repeat(64) },
    })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    const current = await admin.query<{ current_profile_revision_id: string }>(
      `SELECT current_profile_revision_id FROM partner_stations WHERE id=$1`, [stationId]
    );
    expect(current.rows[0].current_profile_revision_id).toBe(accepted.profileRevisionId);
  }, 60_000);

  it("replaces and transfers stations without inheriting custody or historical profile authority", async () => {
    const tenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status)
       VALUES ('fleet-v2-org','Fleet V2 Org','ACTIVE') RETURNING id`
    )).rows[0].id;
    const oldLocationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('fleet-v2-old',$1,$1,'Old Shop','3 Test Street','ACTIVE') RETURNING id`, [tenantId]
    )).rows[0].id;
    const newLocationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('fleet-v2-new',$1,$1,'New Shop','4 Test Street','ACTIVE') RETURNING id`, [tenantId]
    )).rows[0].id;
    const otherTenantId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref,legal_name,status)
       VALUES ('fleet-v2-other','Fleet Other Org','ACTIVE') RETURNING id`
    )).rows[0].id;
    const otherLocationId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name,address,status)
       VALUES ('fleet-v2-other-loc',$1,$1,'Other Shop','5 Test Street','ACTIVE') RETURNING id`, [otherTenantId]
    )).rows[0].id;
    const actorUserId = (await admin.query<{ id: string }>(
      `INSERT INTO partner_users (id,public_ref,tenant_id,partner_id,email,status)
       VALUES (gen_random_uuid(),'fleet-v2-operator',$1,$1,'fleet-v2@shop.test','ACTIVE') RETURNING id`,
      [tenantId]
    )).rows[0].id;
    await admin.query(`INSERT INTO partner_profiles (tenant_id,trading_name) VALUES ($1,'Fleet V2 Cards')`, [tenantId]);
    const { stationPublicKeyFingerprint } = await import("../server/partner/station-identity");
    const station = async (code: string, status: "ACTIVE" | "PENDING") => {
      const keys = crypto.generateKeyPairSync("ed25519");
      const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
      return (await admin.query<{ id: string }>(
        `INSERT INTO partner_stations
           (station_code,tenant_id,location_id,status,public_key_pem,public_key_fingerprint,app_version,
            pending_upload_count,capture_state,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,'1.0.0',0,'IDLE',now()) RETURNING id`,
        [code, tenantId, oldLocationId, status, publicKeyPem, stationPublicKeyFingerprint(publicKeyPem)]
      )).rows[0].id;
    };
    const priorCode = "MV-STN-RRRRRRRRRRRRRRRR";
    const replacementCode = "MV-STN-NNNNNNNNNNNNNNNN";
    const priorId = await station(priorCode, "ACTIVE");
    const replacementId = await station(replacementCode, "PENDING");
    const priorProfileRevisionId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO partner_station_profile_revisions
         (id,station_id,tenant_id,location_id,semantic_operation_id,candidate_digest_sha256,
          profile_digest_sha256,profile,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8)`,
      [
        priorProfileRevisionId,
        priorId,
        tenantId,
        oldLocationId,
        crypto.randomUUID(),
        "1".repeat(64),
        "2".repeat(64),
        actorUserId,
      ]
    );
    await admin.query(
      `UPDATE partner_stations
          SET scanner_profile_version='mintvault-canon-lide-400-v3',calibration_status='VALID',
              current_profile_revision_id=$2
        WHERE id=$1`,
      [priorId, priorProfileRevisionId]
    );
    const wallet = await import("../server/partner/partner-wallet-service");
    const walletActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };
    await wallet.ensureWallet(walletActor, tenantId);
    await wallet.appendFoundationCredit(walletActor, {
      tenantId,
      amount: 1,
      entryType: "purchase",
      source: "admin",
      reason: "Replacement recovery proof",
      idempotencyKey: `scanner-replacement-credit:${tenantId}`,
      actorType: "admin",
    });
    const cardJobs = await import("../server/partner/card-job-authority");
    const card = await cardJobs.startNewCardJobAtStation({
      tenantId,
      locationId: oldLocationId,
      stationId: priorId,
      clientOpId: crypto.randomUUID(),
      actorUserId,
      actorEmail: "fleet-v2@shop.test",
      cardName: "Replacement recovery",
    });
    const captures = await import("../server/scanner-capture-service");
    const front = await captures.ensureNextCardJobCaptureSession({
      cardJobId: card.cardJobId,
      stationId: priorId,
      actorId: actorUserId,
    });
    expect(front).toMatchObject({ cardJobId: card.cardJobId, side: "front", stationId: priorId });
    await admin.query(
      `INSERT INTO certificate_image_evidence
         (certificate_id,side,evidence_class,object_key,sha256,byte_length,pixel_width,pixel_height,
          bit_depth,dpi,format,capture_metadata)
       VALUES ($1,'front','NEW_IMMUTABLE_MASTER',$2,$3,1024,1200,1600,8,1200,'TIFF','{}'::jsonb)`,
      [card.certificateId, `evidence/replacement/${card.certificateId}/front.tif`, "3".repeat(64)]
    );
    await admin.query(
      `UPDATE scanner_capture_sessions SET state='captured',captured_at=now() WHERE id=$1`,
      [front!.id]
    );
    const beforeReplacement = (await admin.query<{ ledger_rows: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM partner_credit_ledger WHERE tenant_id=$1) AS ledger_rows,
              (SELECT count(*)::int FROM partner_card_jobs WHERE tenant_id=$1) AS jobs`,
      [tenantId]
    )).rows[0];
    const fleet = await import("../server/partner/station-service");
    await fleet.activateReplacementStation({
      stationCode: replacementCode,
      replacesStationCode: priorCode,
      actorUserId,
      reason: "Owner-authorised lost Mac replacement",
    });
    await expect(fleet.activateReplacementStation({
      stationCode: replacementCode,
      replacesStationCode: priorCode,
      actorUserId,
      reason: "Owner-authorised lost Mac replacement",
    })).resolves.toBeUndefined();
    const replaced = await admin.query<{ id: string; status: string; replaces_station_id: string | null }>(
      `SELECT id,status,replaces_station_id FROM partner_stations WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[priorId, replacementId]]
    );
    expect(replaced.rows.find((row) => row.id === priorId)).toMatchObject({ status: "REVOKED" });
    expect(replaced.rows.find((row) => row.id === replacementId)).toMatchObject({
      status: "ACTIVE",
      replaces_station_id: priorId,
    });

    await expect(captures.ensureNextCardJobCaptureSession({
      cardJobId: card.cardJobId,
      stationId: replacementId,
      actorId: actorUserId,
    })).rejects.toThrow(/cannot be armed/);
    const replacementProfileRevisionId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO partner_station_profile_revisions
         (id,station_id,tenant_id,location_id,semantic_operation_id,candidate_digest_sha256,
          profile_digest_sha256,profile,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8)`,
      [
        replacementProfileRevisionId,
        replacementId,
        tenantId,
        oldLocationId,
        crypto.randomUUID(),
        "4".repeat(64),
        "5".repeat(64),
        actorUserId,
      ]
    );
    await admin.query(
      `UPDATE partner_stations
          SET scanner_profile_version='mintvault-canon-lide-400-v3',calibration_status='VALID',
              current_profile_revision_id=$2
        WHERE id=$1`,
      [replacementId, replacementProfileRevisionId]
    );
    const recoveredBack = await captures.ensureNextCardJobCaptureSession({
      cardJobId: card.cardJobId,
      stationId: replacementId,
      actorId: actorUserId,
    });
    expect(recoveredBack).toMatchObject({
      cardJobId: card.cardJobId,
      certificateId: card.certificateId,
      side: "back",
      stationId: replacementId,
      tenantId,
      locationId: oldLocationId,
    });
    const afterReplacement = (await admin.query<{ ledger_rows: number; jobs: number; front_rows: number }>(
      `SELECT (SELECT count(*)::int FROM partner_credit_ledger WHERE tenant_id=$1) AS ledger_rows,
              (SELECT count(*)::int FROM partner_card_jobs WHERE tenant_id=$1) AS jobs,
              (SELECT count(*)::int FROM certificate_image_evidence
                WHERE certificate_id=$2 AND side='front' AND is_current) AS front_rows`,
      [tenantId, card.certificateId]
    )).rows[0];
    expect(afterReplacement).toEqual({ ...beforeReplacement, front_rows: 1 });

    const issuedAt = new Date(Date.now() - 10_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const targetVersion = "1.1.0";
    const prefix = `MintVault-Scanner-${targetVersion}-arm64`;
    const policy = {
      schemaVersion: 1,
      authority: "MINTVAULT_STATION_POLICY",
      policyId: "scanner-policy-test-1.1.0",
      operation: "UPDATE",
      targetVersion,
      minimumSupportedVersion: targetVersion,
      teamIdentifier: "TEAMID1234",
      sourceCommit: "a".repeat(40),
      issuedAt,
      expiresAt,
      reason: "Owner-approved Scanner update",
      artifacts: {
        zip: { filename: `${prefix}.zip`, size: 101, sha256: "b".repeat(64), sha512: `${"A".repeat(86)}==` },
        dmg: { filename: `${prefix}.dmg`, size: 102, sha256: "c".repeat(64) },
        latest: { filename: "latest-mac.yml", size: 103, sha256: "d".repeat(64) },
      },
    };
    await fleet.setStationUpdatePolicy({
      stationCode: replacementCode,
      policy,
      actorUserId,
      reason: "Owner-approved Scanner update",
    });
    await expect(fleet.setStationUpdatePolicy({
      stationCode: replacementCode,
      policy: { ...policy, policyId: "scanner-policy-wrong-direction", operation: "ROLLBACK" },
      actorUserId,
      reason: "Wrong direction must fail",
    })).rejects.toMatchObject({ code: "validation" });
    const storedPolicy = (await admin.query<{ scanner_update_policy: unknown; minimum_supported_version: string }>(
      `SELECT scanner_update_policy,minimum_supported_version FROM partner_stations WHERE id=$1`, [replacementId]
    )).rows[0];
    expect(storedPolicy).toMatchObject({ scanner_update_policy: policy, minimum_supported_version: targetVersion });

    await admin.query(`UPDATE scanner_capture_sessions SET state='cancelled' WHERE id=$1`, [recoveredBack!.id]);
    await admin.query(`UPDATE partner_stations SET status='SUSPENDED',last_seen_at=now() WHERE id=$1`, [replacementId]);
    await expect(fleet.transferStationLocation({
      stationCode: replacementCode,
      targetLocationId: otherLocationId,
      actorUserId,
      reason: "Cross-tenant move must fail",
    })).rejects.toMatchObject({ code: "validation" });
    await fleet.transferStationLocation({
      stationCode: replacementCode,
      targetLocationId: newLocationId,
      actorUserId,
      reason: "Owner-approved same-tenant shop transfer",
    });
    const transferred = (await admin.query<{
      status: string;
      location_id: string;
      calibration_status: string;
      current_profile_revision_id: string | null;
    }>(
      `SELECT status,location_id,calibration_status,current_profile_revision_id
         FROM partner_stations WHERE id=$1`, [replacementId]
    )).rows[0];
    expect(transferred).toEqual({
      status: "ACTIVE",
      location_id: newLocationId,
      calibration_status: "UNPROVISIONED",
      current_profile_revision_id: null,
    });
    const events = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM partner_station_events WHERE station_id=ANY($1::uuid[])`,
      [[priorId, replacementId]]
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      "station_replaced",
      "station_replacement_activated",
      "station_location_transferred_from",
      "station_location_transferred_to",
      "station_update_policy_issued",
    ]));
  }, 60_000);
});
