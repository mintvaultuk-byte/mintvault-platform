import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  APPROVED_STAGING_CANON_GEOMETRY_REPAIR,
  approvedStagingCanonGeometryRepairPlan,
  executeApprovedStagingCanonGeometryRepair,
  runApprovedStagingCanonGeometryRepair,
} from "../server/partner/staging-canon-geometry-repair";
import { applyMigrationsRealistic } from "./helpers/partner-realistic-db";
import { startPostgres17 } from "./helpers/postgres17-cluster";

const ENV = {
  FLY_APP_NAME: "mintvault-v2",
  MINTVAULT_RUNTIME_ENV: "staging",
  MINTVAULT_DATABASE_URL: "postgresql://staging_user:unused@staging.invalid/mintvault_staging",
  PARTNER_ADMIN_DATABASE_URL: "postgresql://admin_user:unused@staging.invalid/mintvault_staging",
} as NodeJS.ProcessEnv;

const PLAN = approvedStagingCanonGeometryRepairPlan(ENV);
const CORRECTED_CALIBRATION_ID = "00000000-0000-4000-8000-000000000001";

const stationScope = {
  station_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
  station_code: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationCode,
  station_status: "ACTIVE",
  calibration_status: "VALID",
  pending_upload_count: 0,
  tenant_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
  tenant_name: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantName,
  location_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
  location_name: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationName,
};

const previousCalibration = {
  calibration_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
  calibration_tenant_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
  calibration_location_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
  calibration_station_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
  calibration_created_by_user_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
  calibration_health: "VALID",
  calibration_fingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationFingerprint,
  scanner_hardware_fingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint,
  scanner_hardware: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardware,
  scanner_profile_version: "mintvault-canon-lide-400-v3",
  acquisition_region: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousAcquisitionRegion,
  working_region: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousWorkingRegion,
  placement_tolerance_mm: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousPlacementToleranceMm,
  calibration_version: "capture-geometry-v1",
  calibration_row: {
    id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
    station_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
    tenant_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
    location_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
    calibration_fingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationFingerprint,
    scanner_hardware_fingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint,
  },
};

const correctedCalibration = {
  calibration_id: CORRECTED_CALIBRATION_ID,
  calibration_tenant_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
  calibration_location_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
  calibration_station_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
  calibration_created_by_user_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
  calibration_health: "VALID",
  calibration_fingerprint: PLAN.calibrationFingerprint,
  scanner_hardware_fingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint,
  scanner_hardware: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardware,
  scanner_profile_version: PLAN.scannerProfileVersion,
  acquisition_region: PLAN.acquisitionRegion,
  working_region: PLAN.workingRegion,
  placement_tolerance_mm: PLAN.placementToleranceMm,
  calibration_version: PLAN.calibrationVersion,
  calibration_row: {
    id: CORRECTED_CALIBRATION_ID,
    station_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
    tenant_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
    location_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
    calibration_fingerprint: PLAN.calibrationFingerprint,
    scanner_hardware_fingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint,
  },
};

type FixtureOptions = {
  staleRegion?: unknown;
  events?: Record<string, unknown>[];
  current?: "previous" | "corrected";
  insertConflict?: boolean;
  calibrationUsed?: boolean;
  liveState?: Partial<{ live_capture: boolean; live_staging: boolean; half_captured: boolean }>;
  actor?: Partial<{
    status: string;
    mfa_enabled: boolean;
    can_calibrate: boolean;
    has_live_mfa_session: boolean;
  }>;
  previousCalibrationTenantId?: string;
};

function clientFixture(options: FixtureOptions = {}) {
  const writes: string[] = [];
  const queries: string[] = [];
  let currentCalibrationId =
    options.current === "corrected"
      ? CORRECTED_CALIBRATION_ID
      : APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId;
  let correctedExists =
    options.current === "corrected" ||
    options.events?.some((event) => event.event_type === "station_capture_geometry_repaired") === true;

  function calibrationRow(calibrationId: string) {
    const calibration =
      calibrationId === CORRECTED_CALIBRATION_ID
        ? correctedCalibration
        : {
            ...previousCalibration,
            calibration_tenant_id: options.previousCalibrationTenantId ?? previousCalibration.calibration_tenant_id,
            acquisition_region: options.staleRegion ?? previousCalibration.acquisition_region,
          };
    return { ...stationScope, current_calibration_id: currentCalibrationId, ...calibration };
  }

  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push(sql);
      if (/^\s*(UPDATE|INSERT|DELETE)\b/.test(sql)) writes.push(sql);
      if (
        sql.includes("FROM partner_stations s") &&
        sql.includes("JOIN partner_station_calibrations k ON k.id=s.current_calibration_id")
      ) {
        return { rows: [calibrationRow(currentCalibrationId)], rowCount: 1 };
      }
      if (sql.includes("JOIN partner_station_calibrations k") && sql.includes("k.id=$3")) {
        const calibrationId = String(values[2]);
        if (calibrationId === CORRECTED_CALIBRATION_ID && !correctedExists) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [calibrationRow(calibrationId)], rowCount: 1 };
      }
      if (sql.includes("FROM partner_users u")) {
        return {
          rows: [
            {
              id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
              email: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorEmail,
              status: "ACTIVE",
              mfa_enabled: true,
              can_calibrate: true,
              has_live_mfa_session: true,
              ...options.actor,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("AS live_capture")) {
        return {
          rows: [{ live_capture: false, live_staging: false, half_captured: false, ...options.liveState }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM partner_station_events")) {
        return { rows: options.events ?? [], rowCount: options.events?.length ?? 0 };
      }
      if (sql.includes("INSERT INTO partner_station_calibrations")) {
        if (options.insertConflict) return { rows: [], rowCount: 0 };
        correctedExists = true;
        return { rows: [{ id: CORRECTED_CALIBRATION_ID }], rowCount: 1 };
      }
      if (sql.includes("AS used")) {
        return { rows: [{ used: options.calibrationUsed === true }], rowCount: 1 };
      }
      if (sql.includes("UPDATE partner_stations")) {
        currentCalibrationId = String(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO partner_station_events")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
  return { client: client as never, writes, queries };
}

function canonicalRepairEvent(previousRowDigest: string) {
  return {
    id: "100",
    tenant_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
    location_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
    station_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
    actor_user_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
    event_type: "station_capture_geometry_repaired",
    detail: {
      repairKey: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.repairKey,
      reason: "physical-canon-proof-stale-inverted-y-driver-origin",
      previousCalibrationId: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
      previousCalibrationFingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationFingerprint,
      previousRowDigest,
      previousAcquisitionRegion: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousAcquisitionRegion,
      newCalibrationId: CORRECTED_CALIBRATION_ID,
      newCalibrationFingerprint: PLAN.calibrationFingerprint,
      newAcquisitionRegion: PLAN.acquisitionRegion,
      masterEvidenceMinMarginMm: PLAN.masterEvidenceMinMarginMm,
      previewGreenMinMarginMm: PLAN.previewGreenMinMarginMm,
    },
  };
}

function canonicalRollbackEvent() {
  return {
    id: "101",
    tenant_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
    location_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
    station_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
    actor_user_id: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
    event_type: "station_capture_geometry_rollback",
    detail: {
      repairKey: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.repairKey,
      previousCalibrationId: CORRECTED_CALIBRATION_ID,
      restoredCalibrationId: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
      reason: "incident-repair-rollback-before-physical-acceptance",
    },
  };
}

describe("approved STAGING Canon geometry repair", () => {
  it("derives the proved 0,0 rectangle while preserving the 4 mm master floor", () => {
    const plan = approvedStagingCanonGeometryRepairPlan(ENV);
    expect(plan.acquisitionRegion).toEqual({ x: 0, y: 0, width: 100, height: 130 });
    expect(plan.workingRegion).toEqual({ x: 5.6, y: 5.6, width: 88.8, height: 118.8 });
    expect(plan.placementToleranceMm).toEqual({ left: 5.6, right: 5.6, top: 5.6, bottom: 5.6 });
    expect(plan.masterEvidenceMinMarginMm).toBe(4);
    expect(plan.previewGreenMinMarginMm).toBe(5.6);
  });

  it("refuses every non-mintvault-v2 runtime before querying a database", async () => {
    const fixture = clientFixture();
    await expect(
      executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", {
        ...ENV,
        FLY_APP_NAME: "mintvault",
        MINTVAULT_RUNTIME_ENV: "production",
      })
    ).rejects.toThrow(/outside the exact mintvault-v2 STAGING runtime/);
    expect(fixture.queries).toEqual([]);
  });

  it("dry-runs against the exact stale row without any mutation", async () => {
    const fixture = clientFixture();
    const result = await executeApprovedStagingCanonGeometryRepair(fixture.client, "inspect", ENV);
    expect(result).toMatchObject({ mode: "inspect", applicable: true });
    expect(fixture.writes).toEqual([]);
  });

  it("appends one corrected calibration and repoints one station without changing the old row", async () => {
    const fixture = clientFixture();
    const result = await executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV);
    expect(result).toMatchObject({
      mode: "apply",
      applied: true,
      newCalibrationId: "00000000-0000-4000-8000-000000000001",
    });
    expect(fixture.writes).toHaveLength(3);
    expect(fixture.writes[0]).toContain("INSERT INTO partner_station_calibrations");
    expect(fixture.writes[1]).toContain("UPDATE partner_stations");
    expect(fixture.writes[2]).toContain("INSERT INTO partner_station_events");
    expect(fixture.writes.join("\n")).not.toMatch(/UPDATE partner_station_calibrations|DELETE FROM/);
  });

  it("refuses a changed stale-row premise before writing", async () => {
    const fixture = clientFixture({ staleRegion: { x: 0, y: 0, width: 100, height: 130 } });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV)).rejects.toThrow(
      /stale acquisition region mismatch/
    );
    expect(fixture.writes).toEqual([]);
  });

  it("fails closed instead of reusing an unexplained calibration-fingerprint conflict", async () => {
    const fixture = clientFixture({ insertConflict: true });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV)).rejects.toThrow(
      /already exists without canonical incident provenance/
    );
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toContain("INSERT INTO partner_station_calibrations");
  });

  it("refuses an operator whose MFA session is not live under application rules", async () => {
    const fixture = clientFixture({ actor: { has_live_mfa_session: false } });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV)).rejects.toThrow(
      /MFA-passed station maintainer authority is not currently valid/
    );
    expect(fixture.writes).toEqual([]);
  });

  it("refuses every live capture state before writing", async () => {
    const fixture = clientFixture({ liveState: { live_capture: true } });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV)).rejects.toThrow(
      /Station is not quiescent/
    );
    expect(fixture.writes).toEqual([]);
  });

  it("refuses a calibration row whose tenant scope no longer matches the station", async () => {
    const fixture = clientFixture({ previousCalibrationTenantId: "00000000-0000-4000-8000-000000000099" });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV)).rejects.toThrow(
      /calibration tenant scope mismatch/
    );
    expect(fixture.writes).toEqual([]);
  });

  it("proves the preserved row again on an idempotent already-applied result", async () => {
    const inspected = await executeApprovedStagingCanonGeometryRepair(clientFixture().client, "inspect", ENV);
    const previousRowDigest = String((inspected as { previousRowDigest: string }).previousRowDigest);
    const fixture = clientFixture({ current: "corrected", events: [canonicalRepairEvent(previousRowDigest)] });
    const result = await executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV);
    expect(result).toMatchObject({ alreadyApplied: true, newCalibrationId: CORRECTED_CALIBRATION_ID });
    expect(fixture.writes).toEqual([]);
  });

  it("refuses duplicate repair events instead of selecting the first one", async () => {
    const inspected = await executeApprovedStagingCanonGeometryRepair(clientFixture().client, "inspect", ENV);
    const event = canonicalRepairEvent(String((inspected as { previousRowDigest: string }).previousRowDigest));
    const fixture = clientFixture({ current: "corrected", events: [event, { ...event, id: "101" }] });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "apply", ENV)).rejects.toThrow(
      /Duplicate incident repair history exists/
    );
    expect(fixture.writes).toEqual([]);
  });

  it("permanently closes rollback as soon as the corrected calibration has any capture history", async () => {
    const inspected = await executeApprovedStagingCanonGeometryRepair(clientFixture().client, "inspect", ENV);
    const event = canonicalRepairEvent(String((inspected as { previousRowDigest: string }).previousRowDigest));
    const fixture = clientFixture({ current: "corrected", events: [event], calibrationUsed: true });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "rollback", ENV)).rejects.toThrow(
      /has capture history and can no longer be rolled back/
    );
    expect(fixture.writes).toEqual([]);
  });

  it("allows the guarded pointer-only rollback before the corrected calibration is ever used", async () => {
    const inspected = await executeApprovedStagingCanonGeometryRepair(clientFixture().client, "inspect", ENV);
    const event = canonicalRepairEvent(String((inspected as { previousRowDigest: string }).previousRowDigest));
    const fixture = clientFixture({ current: "corrected", events: [event] });
    const result = await executeApprovedStagingCanonGeometryRepair(fixture.client, "rollback", ENV);
    expect(result).toMatchObject({
      rolledBack: true,
      restoredCalibrationId: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
    });
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[0]).toContain("UPDATE partner_stations");
    expect(fixture.writes[1]).toContain("station_capture_geometry_rollback");
  });

  it("revalidates both immutable rows and both audit events on an already-rolled-back result", async () => {
    const inspected = await executeApprovedStagingCanonGeometryRepair(clientFixture().client, "inspect", ENV);
    const repair = canonicalRepairEvent(String((inspected as { previousRowDigest: string }).previousRowDigest));
    const fixture = clientFixture({ events: [repair, canonicalRollbackEvent()], current: "previous" });
    const result = await executeApprovedStagingCanonGeometryRepair(fixture.client, "rollback", ENV);
    expect(result).toMatchObject({ alreadyRolledBack: true });
    expect(fixture.writes).toEqual([]);
  });

  it("refuses a rollback audit record that does not follow its repair record", async () => {
    const inspected = await executeApprovedStagingCanonGeometryRepair(clientFixture().client, "inspect", ENV);
    const repair = canonicalRepairEvent(String((inspected as { previousRowDigest: string }).previousRowDigest));
    const rollback = { ...canonicalRollbackEvent(), id: "99" };
    const fixture = clientFixture({ events: [rollback, repair], current: "previous" });
    await expect(executeApprovedStagingCanonGeometryRepair(fixture.client, "rollback", ENV)).rejects.toThrow(
      /Rollback event does not follow the repair event/
    );
    expect(fixture.writes).toEqual([]);
  });

  it("serializes station arming with the geometry pointer transaction", () => {
    const captureService = readFileSync("server/scanner-capture-service.ts", "utf8");
    const operationalAuthority = readFileSync("server/partner/operational-authority.ts", "utf8");
    expect(operationalAuthority).toMatch(
      /JOIN public\.partner_station_calibrations calibration[\s\S]{0,400}FOR SHARE OF station, calibration/
    );
    expect(captureService).toContain("withScannerCaptureOperationalAuthority(");
    expect(captureService).toContain(
      "(authority) => createScannerCaptureSessionOnMain(input, side, workstationId, authority, anchor)"
    );
  });

  it("locks both the station pointer and its current calibration in every mutating mode", () => {
    const repairService = readFileSync("server/partner/staging-canon-geometry-repair.ts", "utf8");
    expect(repairService).toMatch(
      /JOIN partner_station_calibrations k ON k\.id=s\.current_calibration_id[\s\S]{0,180}FOR UPDATE OF s, k/
    );
  });

  it("treats every capturing session and every physically released hold as live", () => {
    const repairService = readFileSync("server/partner/staging-canon-geometry-repair.ts", "utf8");
    expect(repairService).toMatch(
      /s\.state='capturing'[\s\S]{0,220}s\.state IN \('armed','claimed'\)[\s\S]{0,160}s\.physical_released=true OR s\.expires_at>now\(\)/
    );
    expect(repairService).not.toMatch(
      /s\.state IN \('armed','claimed','capturing'\)[\s\S]{0,120}s\.physical_released=false/
    );
  });

  it("mirrors the live session credential, idle, location and emergency boundaries", () => {
    const repairService = readFileSync("server/partner/staging-canon-geometry-repair.ts", "utf8");
    expect(repairService).toContain("s.last_seen_at>=now()-($5::integer*interval '1 minute')");
    expect(repairService).toContain('import { IDLE_MINUTES } from "./session"');
    expect(repairService).toContain("s.credential_version=u.credential_version");
    expect(repairService).toContain("s.location_id=$4");
    expect(repairService).toContain("partner_user_locations");
    expect(repairService).toContain("partner_emergency_controls");
    expect(repairService).toContain("partner_emergency_stop");
  });

  it("executes inspect, apply, idempotency and pre-use rollback against real PostgreSQL 17.10", async () => {
    const envKeys = [
      "FLY_APP_NAME",
      "MINTVAULT_RUNTIME_ENV",
      "MINTVAULT_DATABASE_URL",
      "PARTNER_ADMIN_DATABASE_URL",
      "PARTNER_DATABASE_URL",
      "PARTNER_CONNECTOR_DATABASE_URL",
      "MINTVAULT_STAGING_DATABASE_FINGERPRINT",
    ] as const;
    const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    const cluster = await startPostgres17("scanner-geometry-repair");
    const admin = new pg.Client({ connectionString: cluster.url });
    try {
      await admin.connect();
      await applyMigrationsRealistic(admin, cluster.url, [
        "0001_partner_foundation",
        "0002_partner_auth_support",
        "0034_partner_rbac_seed",
        "0045_partner_stations",
        "0047_scanner_evidence_staging",
        "0091_capture_session_calibration_snapshot",
        "0092_partner_station_calibrate_permission",
        "0094_scanner_capture_physical_release",
      ]);

      const expected = APPROVED_STAGING_CANON_GEOMETRY_REPAIR;
      await admin.query(
        `INSERT INTO partner_organisations
             (id,public_ref,legal_name,status,accreditation_level,health)
           VALUES ($1,'geometry-repair-tenant',$2,'ACTIVE','FULL_PARTNER','HEALTHY')`,
          [expected.tenantId, expected.tenantName]
      );
      await admin.query(
        `INSERT INTO partner_locations
             (id,public_ref,tenant_id,partner_id,name,status)
           VALUES ($1,'geometry-repair-location',$2,$2,$3,'ACTIVE')`,
        [expected.locationId, expected.tenantId, expected.locationName]
      );
      await admin.query(
        `INSERT INTO partner_users
             (id,public_ref,tenant_id,partner_id,email,status,credential_version,mfa_enabled)
           VALUES ($1,'geometry-repair-operator',$2,$2,$3,'ACTIVE',1,true)`,
        [expected.actorUserId, expected.tenantId, expected.actorEmail]
      );
      await admin.query(
        `INSERT INTO partner_user_locations (tenant_id,user_id,location_id)
           VALUES ($1,$2,$3)`,
        [expected.tenantId, expected.actorUserId, expected.locationId]
      );
      await admin.query(
        `INSERT INTO partner_user_roles (tenant_id,user_id,role_id)
           SELECT $1,$2,id FROM partner_roles WHERE code='MVGS_ASSESSMENT_TECHNICIAN'`,
        [expected.tenantId, expected.actorUserId]
      );
      await admin.query(
        `INSERT INTO partner_sessions
             (id,tenant_id,user_id,location_id,token_hash,credential_version,mfa_passed,
              absolute_expires_at,last_seen_at)
           VALUES ('00000000-0000-4000-8000-000000000002',$1,$2,$3,$4,1,true,
                   now()+interval '1 hour',now())`,
        [expected.tenantId, expected.actorUserId, expected.locationId, "b".repeat(64)]
      );
      await admin.query(
        `INSERT INTO partner_feature_flags
             (tenant_id,location_id,flag,enabled)
           VALUES (NULL,NULL,'partner_emergency_stop',false)`
      );
      await admin.query(
        `INSERT INTO partner_stations
             (id,station_code,tenant_id,location_id,status,public_key_pem,
              public_key_fingerprint,installation_fingerprint,app_version,scanner_connected,
              scanner_hardware,scanner_hardware_fingerprint,scanner_profile_version,
              calibration_status,pending_upload_count,capture_state,approved_at,approved_by)
           VALUES ($1,$2,$3,$4,'ACTIVE','test-public-key',$5,$6,'1.5.7',true,$7::jsonb,$8,$9,
                   'UNPROVISIONED',0,'IDLE',now(),$10)`,
        [
          expected.stationId,
          expected.stationCode,
          expected.tenantId,
          expected.locationId,
          "c".repeat(64),
          "d".repeat(64),
          JSON.stringify(expected.scannerHardware),
          expected.scannerHardwareFingerprint,
          PLAN.scannerProfileVersion,
          expected.actorUserId,
        ]
      );
      await admin.query(
        `INSERT INTO partner_station_calibrations
             (id,tenant_id,location_id,station_id,calibration_fingerprint,
              scanner_hardware_fingerprint,scanner_hardware,scanner_profile_version,
              acquisition_region,working_region,placement_tolerance_mm,calibration_version,
              health_status,created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,'VALID',$13)`,
        [
          expected.previousCalibrationId,
          expected.tenantId,
          expected.locationId,
          expected.stationId,
          expected.previousCalibrationFingerprint,
          expected.scannerHardwareFingerprint,
          JSON.stringify(expected.scannerHardware),
          PLAN.scannerProfileVersion,
          JSON.stringify(expected.previousAcquisitionRegion),
          JSON.stringify(expected.previousWorkingRegion),
          JSON.stringify(expected.previousPlacementToleranceMm),
          PLAN.calibrationVersion,
          expected.actorUserId,
        ]
      );
      await admin.query(
        `UPDATE partner_stations
              SET current_calibration_id=$2,calibration_status='VALID'
            WHERE id=$1`,
        [expected.stationId, expected.previousCalibrationId]
      );

      process.env.FLY_APP_NAME = "mintvault-v2";
      process.env.MINTVAULT_RUNTIME_ENV = "staging";
      process.env.MINTVAULT_DATABASE_URL = cluster.url;
      process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
      delete process.env.PARTNER_DATABASE_URL;
      delete process.env.PARTNER_CONNECTOR_DATABASE_URL;
      delete process.env.MINTVAULT_STAGING_DATABASE_FINGERPRINT;

      const oldBefore = await admin.query<{ row: Record<string, unknown> }>(
        "SELECT to_jsonb(k) AS row FROM partner_station_calibrations k WHERE id=$1",
        [expected.previousCalibrationId]
      );
      const inspected = await runApprovedStagingCanonGeometryRepair("inspect");
      expect(inspected).toMatchObject({ mode: "inspect", applicable: true });
      expect(
        await admin.query("SELECT id FROM partner_station_calibrations WHERE station_id=$1", [expected.stationId])
      ).toHaveProperty("rowCount", 1);
      expect(
        await admin.query("SELECT id FROM partner_station_events WHERE station_id=$1", [expected.stationId])
      ).toHaveProperty("rowCount", 0);

      const applied = await runApprovedStagingCanonGeometryRepair("apply");
      expect(applied).toMatchObject({ mode: "apply", applied: true });
      const newCalibrationId = String((applied as { newCalibrationId: string }).newCalibrationId);
      const current = await admin.query<{
        current_calibration_id: string;
        acquisition_region: Record<string, number>;
        working_region: Record<string, number>;
        placement_tolerance_mm: Record<string, number>;
      }>(
        `SELECT s.current_calibration_id,k.acquisition_region,k.working_region,k.placement_tolerance_mm
             FROM partner_stations s
             JOIN partner_station_calibrations k ON k.id=s.current_calibration_id
            WHERE s.id=$1`,
        [expected.stationId]
      );
      expect(current.rows[0]).toMatchObject({
        current_calibration_id: newCalibrationId,
        acquisition_region: PLAN.acquisitionRegion,
        working_region: PLAN.workingRegion,
        placement_tolerance_mm: PLAN.placementToleranceMm,
      });
      const oldAfterApply = await admin.query<{ row: Record<string, unknown> }>(
        "SELECT to_jsonb(k) AS row FROM partner_station_calibrations k WHERE id=$1",
        [expected.previousCalibrationId]
      );
      expect(oldAfterApply.rows[0].row).toEqual(oldBefore.rows[0].row);
      expect(
        await admin.query("SELECT id FROM partner_station_calibrations WHERE station_id=$1", [expected.stationId])
      ).toHaveProperty("rowCount", 2);

      const replayed = await runApprovedStagingCanonGeometryRepair("apply");
      expect(replayed).toMatchObject({ alreadyApplied: true, newCalibrationId });
      expect(
        await admin.query("SELECT id FROM partner_station_events WHERE station_id=$1", [expected.stationId])
      ).toHaveProperty("rowCount", 1);

      const rolledBack = await runApprovedStagingCanonGeometryRepair("rollback");
      expect(rolledBack).toMatchObject({
        rolledBack: true,
        restoredCalibrationId: expected.previousCalibrationId,
      });
      const finalStation = await admin.query<{ current_calibration_id: string }>(
        "SELECT current_calibration_id FROM partner_stations WHERE id=$1",
        [expected.stationId]
      );
      expect(finalStation.rows[0].current_calibration_id).toBe(expected.previousCalibrationId);
      expect(
        await admin.query("SELECT id FROM partner_station_calibrations WHERE station_id=$1", [expected.stationId])
      ).toHaveProperty("rowCount", 2);
      expect(
        await admin.query("SELECT event_type FROM partner_station_events WHERE station_id=$1 ORDER BY id", [
          expected.stationId,
        ])
      ).toMatchObject({
        rows: [
          { event_type: "station_capture_geometry_repaired" },
          { event_type: "station_capture_geometry_rollback" },
        ],
      });
      const oldAfterRollback = await admin.query<{ row: Record<string, unknown> }>(
        "SELECT to_jsonb(k) AS row FROM partner_station_calibrations k WHERE id=$1",
        [expected.previousCalibrationId]
      );
      expect(oldAfterRollback.rows[0].row).toEqual(oldBefore.rows[0].row);
    } finally {
      const { closePartnerPools } = await import("../server/partner/db");
      await closePartnerPools().catch(() => {});
      await admin.end().catch(() => {});
      await cluster.stop().catch(() => {});
      for (const key of envKeys) {
        const value = savedEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 180_000);
});
