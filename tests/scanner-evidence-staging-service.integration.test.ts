import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

const TEST_URL = process.env.SCANNER_STAGING_TEST_DATABASE_URL || "";

function assertDisposableUrl(url: string): void {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["5432", process.env.MINTVAULT_TEST_PG16_PORT || "55432"].includes(parsed.port) ||
    !/^\/mintvault_dgn_[a-z0-9_]+$/i.test(parsed.pathname)
  ) {
    throw new Error(
      "SCANNER_STAGING_TEST_DATABASE_URL must name a local mintvault_dgn_* disposable database on port 5432 or 55432"
    );
  }
}

const suite = TEST_URL ? describe : describe.skip;

suite("scanner evidence staging service — real PostgreSQL", () => {
  let admin: Client;
  let staging: typeof import("../server/scanner-evidence-staging-service");
  let captures: typeof import("../server/scanner-capture-service");

  beforeAll(async () => {
    assertDisposableUrl(TEST_URL);
    process.env.MINTVAULT_DATABASE_URL = TEST_URL;
    vi.resetModules();
    admin = new Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`
      CREATE TABLE certificates (
        id integer PRIMARY KEY,
        certificate_number text NOT NULL UNIQUE,
        deleted_at timestamptz
      );
      CREATE TABLE partner_stations (id uuid PRIMARY KEY);
      CREATE TABLE scanner_capture_sessions (
        id text PRIMARY KEY,
        certificate_id integer NOT NULL REFERENCES certificates(id),
        card_id integer,
        submission_item_id integer,
        submission_id integer,
        side varchar(5) NOT NULL,
        workstation_id text NOT NULL,
        station_id uuid REFERENCES partner_stations(id),
        scanner_profile_version text NOT NULL,
        actor_id text,
        state varchar(16) NOT NULL,
        claimed_by_device_id text,
        physical_released boolean NOT NULL DEFAULT false,
        recapture boolean NOT NULL DEFAULT false,
        failure_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        claimed_at timestamptz,
        captured_at timestamptz,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE certificate_image_evidence (
        id serial PRIMARY KEY,
        certificate_id integer NOT NULL REFERENCES certificates(id),
        side text NOT NULL,
        is_current boolean NOT NULL DEFAULT true,
        capture_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE scanner_evidence_staging (
        id uuid PRIMARY KEY,
        capture_session_id text NOT NULL REFERENCES scanner_capture_sessions(id),
        station_id uuid REFERENCES partner_stations(id),
        object_key text NOT NULL UNIQUE,
        expected_sha256 char(64) NOT NULL,
        expected_bytes bigint NOT NULL,
        capture_provenance jsonb NOT NULL,
        state text NOT NULL DEFAULT 'granted',
        expires_at timestamptz NOT NULL,
        finalizing_at timestamptz,
        accepted_at timestamptz,
        failure_reason text,
        staging_deleted_at timestamptz,
        cleanup_claimed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX uq_scanner_evidence_staging_active_session
        ON scanner_evidence_staging (capture_session_id) WHERE state IN ('granted','finalizing');
    `);
    await admin.query(`
      INSERT INTO certificates (id, certificate_number) VALUES (1, 'MV-STAGE-1');
      INSERT INTO partner_stations (id) VALUES ('11111111-1111-4111-8111-111111111111');
      INSERT INTO scanner_capture_sessions
        (id,certificate_id,card_id,submission_id,side,workstation_id,station_id,scanner_profile_version,state,claimed_by_device_id,expires_at)
      VALUES
        ('session-stage-1',1,1,1,'front','MV-STN-TEST','11111111-1111-4111-8111-111111111111','mintvault-canon-lide-400-v3','claimed','device-stage-1',NOW() + INTERVAL '5 minutes');
    `);
    staging = await import("../server/scanner-evidence-staging-service");
    captures = await import("../server/scanner-capture-service");
  });

  afterAll(async () => {
    const { pool } = await import("../server/db");
    await pool.end().catch(() => {});
    await admin?.end().catch(() => {});
  });

  it("coalesces concurrent grants, refuses a changed candidate, and serialises finalisation", async () => {
    const request = {
      sessionId: "session-stage-1",
      deviceId: "device-stage-1",
      authenticatedStationId: "11111111-1111-4111-8111-111111111111",
      expectedSha256: "a".repeat(64),
      expectedBytes: 1234,
      provenance: {
        profileVersion: "mintvault-canon-lide-400-v3",
        scanAreaMm: { x: 1, y: 2, width: 100, height: 130 },
      },
    };
    const [first, second] = await Promise.all([
      staging.grantScannerEvidenceStaging(request),
      staging.grantScannerEvidenceStaging(request),
    ]);
    expect(first.staging.id).toBe(second.staging.id);
    expect(first.session.physicalReleased).toBe(true);
    const released = await admin.query<{ physical_released: boolean }>(
      "SELECT physical_released FROM scanner_capture_sessions WHERE id=$1",
      [request.sessionId]
    );
    expect(released.rows[0].physical_released).toBe(true);
    await expect(staging.grantScannerEvidenceStaging({ ...request, expectedSha256: "b".repeat(64) })).rejects.toThrow(
      /different TIFF candidate/i
    );

    const prepared = await staging.beginScannerEvidenceFinalisation({
      sessionId: request.sessionId,
      stagingId: first.staging.id,
      deviceId: request.deviceId,
      authenticatedStationId: request.authenticatedStationId,
    });
    expect(prepared.alreadyAccepted).toBe(false);
    await expect(
      staging.beginScannerEvidenceFinalisation({
        sessionId: request.sessionId,
        stagingId: first.staging.id,
        deviceId: request.deviceId,
        authenticatedStationId: request.authenticatedStationId,
      })
    ).rejects.toThrow(/already being finalised/i);
    await expect(
      staging.beginScannerEvidenceFinalisation({
        sessionId: request.sessionId,
        stagingId: first.staging.id,
        deviceId: "device-stage-2",
        authenticatedStationId: request.authenticatedStationId,
      })
    ).rejects.toThrow(/not found for this station/i);

    await captures.beginScannerCapture(request.sessionId, request.deviceId);
    await captures.finishScannerCapture(request.sessionId, false, "temporary object storage failure", true);
    await staging.failScannerEvidenceFinalisation(first.staging.id, "temporary object storage failure", true);
    const retried = await staging.beginScannerEvidenceFinalisation({
      sessionId: request.sessionId,
      stagingId: first.staging.id,
      deviceId: request.deviceId,
      authenticatedStationId: request.authenticatedStationId,
    });
    expect(retried.alreadyAccepted).toBe(false);
    await staging.completeScannerEvidenceFinalisation(first.staging.id);

    const cleanup = await staging.claimScannerEvidenceStagingCleanup(20);
    expect(cleanup).toContainEqual(
      expect.objectContaining({ id: first.staging.id, objectKey: first.staging.objectKey })
    );
    expect(await staging.claimScannerEvidenceStagingCleanup(20)).toEqual([]);
    await staging.markScannerEvidenceStagingDeleted(first.staging.id);
    const row = await admin.query<{ staging_deleted_at: Date | null }>(
      "SELECT staging_deleted_at FROM scanner_evidence_staging WHERE id=$1",
      [first.staging.id]
    );
    expect(row.rows[0].staging_deleted_at).not.toBeNull();
  });

  it("expires a bounded global batch outside the station-claim path", async () => {
    await admin.query(`
      INSERT INTO certificates (id, certificate_number) VALUES (2, 'MV-STAGE-2');
      INSERT INTO scanner_capture_sessions
        (id,certificate_id,card_id,submission_id,side,workstation_id,station_id,scanner_profile_version,state,expires_at)
      VALUES
        ('session-expired-2',2,2,2,'front','MV-STN-TEST','11111111-1111-4111-8111-111111111111','mintvault-canon-lide-400-v3','armed',NOW() - INTERVAL '1 minute');
    `);
    expect(await captures.expireScannerCaptureSessions(1)).toBe(1);
    const state = await admin.query<{ state: string }>(
      "SELECT state FROM scanner_capture_sessions WHERE id='session-expired-2'"
    );
    expect(state.rows[0].state).toBe("expired");
  });
});
