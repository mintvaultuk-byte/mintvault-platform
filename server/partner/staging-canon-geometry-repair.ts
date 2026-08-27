import crypto from "node:crypto";
import type pg from "pg";
import captureProfile from "../../shared/lide400-capture-profile.cjs";
import {
  assertMintVaultDatabaseEnvironmentSafety,
  classifyMintVaultRuntimeEnvironment,
  mintVaultDatabaseIdentity,
} from "../lib/database-environment-guard";
import { withPartnerAdminTransaction } from "./db";
import { IDLE_MINUTES } from "./session";

const { STANDARD_TCG, captureWindowRectMm, placementBoundaryRectMm, previewGreenMinMarginMm } = captureProfile;

export const APPROVED_STAGING_CANON_GEOMETRY_REPAIR = Object.freeze({
  repairKey: "lide400-y-origin-physical-proof-20260827-v1",
  flyAppName: "mintvault-v2",
  stationId: "7e03d4dd-76d3-42bb-a840-3716cf97b591",
  stationCode: "MV-STN-6DIISWMIEU2IKRG4",
  tenantId: "7093971a-95a4-4bb2-bfaa-d8f48cd8f922",
  tenantName: "pokemon kings",
  locationId: "f256795b-f4a6-4475-8d58-ebfb2b875a92",
  locationName: "2 TEMPLE GARDENS",
  actorUserId: "06c9f685-b79a-4b71-b5df-a716d0bc637a",
  actorEmail: "neilsophieoliver@gmail.com",
  previousCalibrationId: "f7b7fe4f-aefb-423c-a4a5-dc9cec8fabcf",
  previousCalibrationFingerprint: "85ca92c49f67f5ee8d8092e2a48649164a5e68ab0c9fdbfd0c419efefb781fd8",
  scannerHardwareFingerprint: "d67689cde63326818f5f1bf3ab1da556fc9f53134fe98f4a352a482450502141",
  scannerHardware: Object.freeze({
    manufacturer: "Canon",
    model: "Canon LiDE 400",
    deviceId: "mac-MV-STN-6DIISWMIEU2IKRG4",
  }),
  previousAcquisitionRegion: Object.freeze({ x: 0, y: 167.01, width: 100, height: 130 }),
  previousWorkingRegion: Object.freeze({ x: 4.6, y: 171.61, width: 90.8, height: 120.8 }),
  previousPlacementToleranceMm: Object.freeze({ left: 4.6, right: 4.6, top: 4.6, bottom: 4.6 }),
});

type RepairMode = "inspect" | "apply" | "rollback";
type QueryClient = Pick<pg.PoolClient, "query">;

type StationCalibrationRow = {
  station_id: string;
  station_code: string;
  station_status: string;
  calibration_status: string;
  current_calibration_id: string | null;
  pending_upload_count: number;
  tenant_id: string;
  tenant_name: string;
  location_id: string;
  location_name: string;
  calibration_id: string | null;
  calibration_tenant_id: string | null;
  calibration_location_id: string | null;
  calibration_station_id: string | null;
  calibration_created_by_user_id: string | null;
  calibration_health: string | null;
  calibration_fingerprint: string | null;
  scanner_hardware_fingerprint: string | null;
  scanner_hardware: Record<string, unknown> | null;
  scanner_profile_version: string | null;
  acquisition_region: Record<string, number> | null;
  working_region: Record<string, number> | null;
  placement_tolerance_mm: Record<string, number> | null;
  calibration_version: string | null;
  calibration_row: Record<string, unknown> | null;
};

type RepairEventRow = {
  id: string;
  tenant_id: string;
  location_id: string;
  station_id: string;
  actor_user_id: string | null;
  event_type: string;
  detail: Record<string, unknown>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

function requireExact(label: string, actual: unknown, expected: unknown): void {
  if (!sameJson(actual, expected)) {
    throw new Error(`[scanner-geometry-repair] ${label} mismatch; refusing incident-specific repair`);
  }
}

export function approvedStagingCanonGeometryRepairPlan(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.FLY_APP_NAME !== APPROVED_STAGING_CANON_GEOMETRY_REPAIR.flyAppName ||
    classifyMintVaultRuntimeEnvironment(env) !== "staging"
  ) {
    throw new Error("[scanner-geometry-repair] Refusing outside the exact mintvault-v2 STAGING runtime");
  }

  const mainUrl = env.MINTVAULT_DATABASE_URL;
  const adminUrl = env.PARTNER_ADMIN_DATABASE_URL || mainUrl;
  if (!mainUrl || !adminUrl) {
    throw new Error("[scanner-geometry-repair] STAGING database authority is not configured");
  }
  assertMintVaultDatabaseEnvironmentSafety(mainUrl, env, "MINTVAULT_DATABASE_URL");
  assertMintVaultDatabaseEnvironmentSafety(adminUrl, env, "PARTNER_ADMIN_DATABASE_URL");
  if (
    mintVaultDatabaseIdentity(mainUrl, "MINTVAULT_DATABASE_URL") !==
    mintVaultDatabaseIdentity(adminUrl, "PARTNER_ADMIN_DATABASE_URL")
  ) {
    throw new Error(
      "[scanner-geometry-repair] Partner admin and MintVault databases are not the same STAGING authority"
    );
  }

  const acquisitionRegion = captureWindowRectMm({ x: 0, y: 0 }, STANDARD_TCG);
  const placementBoundary = placementBoundaryRectMm(STANDARD_TCG);
  const previewMarginMm = previewGreenMinMarginMm(STANDARD_TCG);
  const workingRegion = {
    x: acquisitionRegion.x + placementBoundary.x,
    y: acquisitionRegion.y + placementBoundary.y,
    width: placementBoundary.width,
    height: placementBoundary.height,
  };
  const placementToleranceMm = {
    left: previewMarginMm,
    right: previewMarginMm,
    top: previewMarginMm,
    bottom: previewMarginMm,
  };
  const scannerHardware = { ...APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardware };
  const calibrationFingerprint = fingerprint({
    scannerHardwareFingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint,
    scannerProfileVersion: STANDARD_TCG.scannerProfileVersion,
    acquisitionRegion,
    workingRegion,
    placementToleranceMm,
    calibrationVersion: STANDARD_TCG.version,
  });

  return {
    stationCode: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationCode,
    previousCalibrationId: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
    scannerHardware,
    scannerHardwareFingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint,
    scannerProfileVersion: STANDARD_TCG.scannerProfileVersion,
    calibrationVersion: STANDARD_TCG.version,
    acquisitionRegion,
    workingRegion,
    placementToleranceMm,
    previewGreenMinMarginMm: previewMarginMm,
    masterEvidenceMinMarginMm: STANDARD_TCG.evidenceMinMarginMm,
    calibrationFingerprint,
  };
}

async function lockedStationCalibration(client: QueryClient, lock: boolean): Promise<StationCalibrationRow> {
  const result = await client.query<StationCalibrationRow>(
    `SELECT s.id AS station_id, s.station_code, s.status AS station_status,
            s.calibration_status, s.current_calibration_id, s.pending_upload_count,
            s.tenant_id, o.legal_name AS tenant_name,
            s.location_id, l.name AS location_name,
            k.id AS calibration_id, k.tenant_id AS calibration_tenant_id,
            k.location_id AS calibration_location_id, k.station_id AS calibration_station_id,
            k.created_by_user_id AS calibration_created_by_user_id,
            k.health_status AS calibration_health,
            k.calibration_fingerprint, k.scanner_hardware_fingerprint,
            k.scanner_hardware, k.scanner_profile_version,
            k.acquisition_region, k.working_region, k.placement_tolerance_mm,
            k.calibration_version, to_jsonb(k) AS calibration_row
       FROM partner_stations s
       JOIN partner_organisations o ON o.id=s.tenant_id
       JOIN partner_locations l ON l.id=s.location_id
       JOIN partner_station_calibrations k ON k.id=s.current_calibration_id
      WHERE s.id=$1 AND s.station_code=$2
      ${lock ? "FOR UPDATE OF s, k" : ""}`,
    [APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId, APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationCode]
  );
  if (result.rows.length !== 1) throw new Error("[scanner-geometry-repair] Exact approved station was not found");
  return result.rows[0];
}

function assertStationScope(row: StationCalibrationRow): void {
  const expected = APPROVED_STAGING_CANON_GEOMETRY_REPAIR;
  requireExact("station id", row.station_id, expected.stationId);
  requireExact("station code", row.station_code, expected.stationCode);
  requireExact("station status", row.station_status, "ACTIVE");
  requireExact("calibration status", row.calibration_status, "VALID");
  requireExact("tenant id", row.tenant_id, expected.tenantId);
  requireExact("tenant name", row.tenant_name.toLowerCase(), expected.tenantName);
  requireExact("location id", row.location_id, expected.locationId);
  requireExact("location name", row.location_name, expected.locationName);
  requireExact("pending upload count", Number(row.pending_upload_count), 0);
}

function assertExactPreviousCalibration(row: StationCalibrationRow, requireCurrentPointer = true): void {
  const expected = APPROVED_STAGING_CANON_GEOMETRY_REPAIR;
  if (requireCurrentPointer) {
    requireExact("current calibration id", row.current_calibration_id, expected.previousCalibrationId);
  }
  requireExact("calibration row id", row.calibration_id, expected.previousCalibrationId);
  requireExact("calibration tenant scope", row.calibration_tenant_id, expected.tenantId);
  requireExact("calibration location scope", row.calibration_location_id, expected.locationId);
  requireExact("calibration station scope", row.calibration_station_id, expected.stationId);
  requireExact("calibration health", row.calibration_health, "VALID");
  requireExact(
    "previous calibration fingerprint",
    row.calibration_fingerprint,
    expected.previousCalibrationFingerprint
  );
  requireExact("hardware fingerprint", row.scanner_hardware_fingerprint, expected.scannerHardwareFingerprint);
  requireExact("Canon hardware identity", row.scanner_hardware, expected.scannerHardware);
  requireExact("scanner profile", row.scanner_profile_version, STANDARD_TCG.scannerProfileVersion);
  requireExact("stale acquisition region", row.acquisition_region, expected.previousAcquisitionRegion);
  requireExact("stale working region", row.working_region, expected.previousWorkingRegion);
  requireExact("stale placement tolerance", row.placement_tolerance_mm, expected.previousPlacementToleranceMm);
  requireExact("calibration version", row.calibration_version, STANDARD_TCG.version);
}

function assertExactCorrectedCalibration(
  row: StationCalibrationRow,
  calibrationId: string,
  plan: ReturnType<typeof approvedStagingCanonGeometryRepairPlan>,
  requireCurrentPointer = true
): void {
  if (requireCurrentPointer) {
    requireExact("corrected current calibration id", row.current_calibration_id, calibrationId);
  }
  requireExact("corrected calibration row id", row.calibration_id, calibrationId);
  requireExact(
    "corrected calibration tenant scope",
    row.calibration_tenant_id,
    APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId
  );
  requireExact(
    "corrected calibration location scope",
    row.calibration_location_id,
    APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId
  );
  requireExact(
    "corrected calibration station scope",
    row.calibration_station_id,
    APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId
  );
  requireExact(
    "corrected calibration creator",
    row.calibration_created_by_user_id,
    APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId
  );
  requireExact("corrected calibration health", row.calibration_health, "VALID");
  requireExact("corrected calibration fingerprint", row.calibration_fingerprint, plan.calibrationFingerprint);
  requireExact(
    "corrected hardware fingerprint",
    row.scanner_hardware_fingerprint,
    APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint
  );
  requireExact("corrected Canon hardware identity", row.scanner_hardware, plan.scannerHardware);
  requireExact("corrected scanner profile", row.scanner_profile_version, plan.scannerProfileVersion);
  requireExact("corrected acquisition region", row.acquisition_region, plan.acquisitionRegion);
  requireExact("corrected working region", row.working_region, plan.workingRegion);
  requireExact("corrected placement tolerance", row.placement_tolerance_mm, plan.placementToleranceMm);
  requireExact("corrected calibration version", row.calibration_version, plan.calibrationVersion);
}

async function exactCalibrationById(
  client: QueryClient,
  calibrationId: string,
  lock = true
): Promise<StationCalibrationRow> {
  const result = await client.query<StationCalibrationRow>(
    `SELECT s.id AS station_id, s.station_code, s.status AS station_status,
            s.calibration_status, s.current_calibration_id, s.pending_upload_count,
            s.tenant_id, o.legal_name AS tenant_name,
            s.location_id, l.name AS location_name,
            k.id AS calibration_id, k.tenant_id AS calibration_tenant_id,
            k.location_id AS calibration_location_id, k.station_id AS calibration_station_id,
            k.created_by_user_id AS calibration_created_by_user_id,
            k.health_status AS calibration_health,
            k.calibration_fingerprint, k.scanner_hardware_fingerprint,
            k.scanner_hardware, k.scanner_profile_version,
            k.acquisition_region, k.working_region, k.placement_tolerance_mm,
            k.calibration_version, to_jsonb(k) AS calibration_row
       FROM partner_stations s
       JOIN partner_organisations o ON o.id=s.tenant_id
       JOIN partner_locations l ON l.id=s.location_id
       JOIN partner_station_calibrations k
         ON k.id=$3 AND k.station_id=s.id
        AND k.tenant_id=s.tenant_id AND k.location_id=s.location_id
      WHERE s.id=$1 AND s.station_code=$2
      ${lock ? "FOR UPDATE OF k" : ""}`,
    [
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationCode,
      calibrationId,
    ]
  );
  if (result.rows.length !== 1) {
    throw new Error("[scanner-geometry-repair] Exact scoped calibration row was not found");
  }
  return result.rows[0];
}

async function assertActorAuthority(client: QueryClient): Promise<void> {
  const result = await client.query<{
    id: string;
    email: string;
    status: string;
    mfa_enabled: boolean;
    can_calibrate: boolean;
    has_live_mfa_session: boolean;
  }>(
    `SELECT u.id, u.email, u.status, u.mfa_enabled,
            EXISTS (
              SELECT 1
                FROM partner_user_roles ur
                JOIN partner_role_permissions rp ON rp.role_id=ur.role_id
                JOIN partner_permissions p ON p.id=rp.permission_id
               WHERE ur.user_id=u.id AND ur.tenant_id=u.tenant_id
                 AND p.code='partner.stations.calibrate'
            ) AS can_calibrate,
            EXISTS (
              SELECT 1
                FROM partner_sessions s
                JOIN partner_organisations o ON o.id=s.tenant_id
                JOIN partner_locations l
                  ON l.id=s.location_id AND l.tenant_id=s.tenant_id
               WHERE s.user_id=u.id AND s.tenant_id=u.tenant_id
                 AND s.location_id=$4
                 AND s.mfa_passed=true AND s.revoked_at IS NULL
                 AND s.absolute_expires_at>now()
                 AND s.last_seen_at>=now()-($5::integer*interval '1 minute')
                 AND s.credential_version=u.credential_version
                 AND o.status='ACTIVE' AND l.status='ACTIVE'
                 AND EXISTS (
                   SELECT 1 FROM partner_user_locations ul
                    WHERE ul.tenant_id=u.tenant_id
                      AND ul.user_id=u.id AND ul.location_id=s.location_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM partner_emergency_controls ec
                    WHERE ec.tenant_id=u.tenant_id AND ec.frozen=true
                      AND (
                        (ec.scope='partner' AND (ec.location_id IS NULL OR ec.location_id=s.location_id))
                        OR (ec.scope='location' AND ec.location_id=s.location_id)
                        OR (
                          ec.scope IN ('view_only','sensitive')
                          AND (ec.location_id IS NULL OR ec.location_id=s.location_id)
                        )
                      )
                 )
                 AND COALESCE((
                   SELECT f.enabled FROM partner_feature_flags f
                    WHERE f.flag='partner_emergency_stop'
                      AND f.tenant_id IS NULL AND f.location_id IS NULL
                    ORDER BY f.updated_at DESC, f.id DESC LIMIT 1
                 ),false)=false
            ) AS has_live_mfa_session
       FROM partner_users u
      WHERE u.id=$1 AND u.tenant_id=$2 AND lower(u.email)=lower($3)`,
    [
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorEmail,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
      IDLE_MINUTES,
    ]
  );
  const actor = result.rows[0];
  if (
    result.rows.length !== 1 ||
    actor.status !== "ACTIVE" ||
    actor.mfa_enabled !== true ||
    actor.can_calibrate !== true ||
    actor.has_live_mfa_session !== true
  ) {
    throw new Error("[scanner-geometry-repair] Exact MFA-passed station maintainer authority is not currently valid");
  }
}

async function repairEvents(client: QueryClient): Promise<RepairEventRow[]> {
  const result = await client.query<RepairEventRow>(
    `SELECT id::text, tenant_id::text, location_id::text, station_id::text,
            actor_user_id::text, event_type, detail
       FROM partner_station_events
      WHERE station_id=$1
        AND event_type IN ('station_capture_geometry_repaired','station_capture_geometry_rollback')
        AND detail->>'repairKey'=$2
      ORDER BY id`,
    [APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId, APPROVED_STAGING_CANON_GEOMETRY_REPAIR.repairKey]
  );
  return result.rows;
}

function canonicalRepairEvents(
  events: RepairEventRow[],
  plan: ReturnType<typeof approvedStagingCanonGeometryRepairPlan>
): { repaired: RepairEventRow | null; rolledBack: RepairEventRow | null } {
  const expected = APPROVED_STAGING_CANON_GEOMETRY_REPAIR;
  for (const event of events) {
    requireExact("repair event tenant", event.tenant_id, expected.tenantId);
    requireExact("repair event location", event.location_id, expected.locationId);
    requireExact("repair event station", event.station_id, expected.stationId);
    requireExact("repair event actor", event.actor_user_id, expected.actorUserId);
  }
  const repairRows = events.filter((event) => event.event_type === "station_capture_geometry_repaired");
  const rollbackRows = events.filter((event) => event.event_type === "station_capture_geometry_rollback");
  if (repairRows.length > 1 || rollbackRows.length > 1) {
    throw new Error("[scanner-geometry-repair] Duplicate incident repair history exists");
  }
  const repaired = repairRows[0] ?? null;
  const rolledBack = rollbackRows[0] ?? null;
  if (events.some((event) => !/^\d+$/.test(event.id))) {
    throw new Error("[scanner-geometry-repair] Incident repair event id is malformed");
  }
  if (rolledBack && !repaired) {
    throw new Error("[scanner-geometry-repair] Rollback exists without its repair event");
  }
  if (repaired && rolledBack && BigInt(rolledBack.id) <= BigInt(repaired.id)) {
    throw new Error("[scanner-geometry-repair] Rollback event does not follow the repair event");
  }
  if (repaired) {
    const newCalibrationId = String(repaired.detail.newCalibrationId || "");
    const previousRowDigest = String(repaired.detail.previousRowDigest || "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(newCalibrationId) ||
      !/^[0-9a-f]{64}$/.test(previousRowDigest)
    ) {
      throw new Error("[scanner-geometry-repair] Repair event identifiers are malformed");
    }
    requireExact("repair event detail", repaired.detail, {
      repairKey: expected.repairKey,
      reason: "physical-canon-proof-stale-inverted-y-driver-origin",
      previousCalibrationId: expected.previousCalibrationId,
      previousCalibrationFingerprint: expected.previousCalibrationFingerprint,
      previousRowDigest,
      previousAcquisitionRegion: expected.previousAcquisitionRegion,
      newCalibrationId,
      newCalibrationFingerprint: plan.calibrationFingerprint,
      newAcquisitionRegion: plan.acquisitionRegion,
      masterEvidenceMinMarginMm: plan.masterEvidenceMinMarginMm,
      previewGreenMinMarginMm: plan.previewGreenMinMarginMm,
    });
    if (rolledBack) {
      requireExact("rollback event detail", rolledBack.detail, {
        repairKey: expected.repairKey,
        previousCalibrationId: newCalibrationId,
        restoredCalibrationId: expected.previousCalibrationId,
        reason: "incident-repair-rollback-before-physical-acceptance",
      });
    }
  }
  return { repaired, rolledBack };
}

async function assertQuiescent(client: QueryClient): Promise<void> {
  const result = await client.query<{
    live_capture: boolean;
    live_staging: boolean;
    half_captured: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM scanner_capture_sessions s
          WHERE s.station_id=$1
            AND (
              s.state='capturing'
              OR (
                s.state IN ('armed','claimed')
                AND (s.physical_released=true OR s.expires_at>now())
              )
            )
       ) AS live_capture,
       EXISTS (
         SELECT 1
           FROM scanner_evidence_staging e
           JOIN scanner_capture_sessions s ON s.id=e.capture_session_id
          WHERE (e.station_id=$1 OR s.station_id=$1)
            AND e.state IN ('granted','finalizing')
       ) AS live_staging,
       EXISTS (
         SELECT 1
           FROM certificates c
           JOIN certificate_image_evidence e ON e.certificate_id=c.id AND e.is_current=true
          WHERE EXISTS (
                  SELECT 1 FROM scanner_capture_sessions s
                   WHERE s.certificate_id=c.id AND s.station_id=$1
                )
          GROUP BY c.id
         HAVING count(DISTINCT e.side)=1
       ) AS half_captured`,
    [APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId]
  );
  const state = result.rows[0];
  if (!state || state.live_capture || state.live_staging || state.half_captured) {
    throw new Error(
      `[scanner-geometry-repair] Station is not quiescent ` +
        `(liveCapture=${state?.live_capture ?? "unknown"}, liveStaging=${state?.live_staging ?? "unknown"}, ` +
        `halfCaptured=${state?.half_captured ?? "unknown"})`
    );
  }
}

function previousCalibrationRowDigest(row: StationCalibrationRow): string {
  if (!row.calibration_row) throw new Error("[scanner-geometry-repair] Complete calibration row is unavailable");
  return fingerprint(row.calibration_row);
}

async function assertPreservedPreviousCalibration(
  client: QueryClient,
  expectedDigest: unknown,
  lock = true
): Promise<StationCalibrationRow> {
  const previous = await exactCalibrationById(
    client,
    APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
    lock
  );
  assertStationScope(previous);
  assertExactPreviousCalibration(previous, false);
  requireExact("preserved row digest", previousCalibrationRowDigest(previous), expectedDigest);
  return previous;
}

async function assertCorrectedCalibrationUnused(client: QueryClient, calibrationId: string): Promise<void> {
  const result = await client.query<{ used: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM scanner_capture_sessions
        WHERE station_id=$1 AND calibration_id=$2
     ) AS used`,
    [APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId, calibrationId]
  );
  if (!result.rows[0] || result.rows[0].used) {
    throw new Error(
      "[scanner-geometry-repair] Corrected calibration has capture history and can no longer be rolled back"
    );
  }
}

export async function executeApprovedStagingCanonGeometryRepair(
  client: QueryClient,
  mode: RepairMode,
  env: NodeJS.ProcessEnv = process.env
) {
  const plan = approvedStagingCanonGeometryRepairPlan(env);
  const station = await lockedStationCalibration(client, mode !== "inspect");
  assertStationScope(station);
  await assertActorAuthority(client);
  await assertQuiescent(client);
  const events = await repairEvents(client);
  const { repaired, rolledBack } = canonicalRepairEvents(events, plan);

  if (mode === "rollback") {
    if (!repaired) throw new Error("[scanner-geometry-repair] No applied incident repair exists to roll back");
    const newCalibrationId = String(repaired.detail.newCalibrationId);
    if (rolledBack) {
      if (station.current_calibration_id !== APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId) {
        throw new Error("[scanner-geometry-repair] Rollback event exists but station pointer is inconsistent");
      }
      assertExactPreviousCalibration(station);
      await assertPreservedPreviousCalibration(client, repaired.detail.previousRowDigest);
      const corrected = await exactCalibrationById(client, newCalibrationId);
      assertStationScope(corrected);
      assertExactCorrectedCalibration(corrected, newCalibrationId, plan, false);
      await assertCorrectedCalibrationUnused(client, newCalibrationId);
      return { mode, alreadyRolledBack: true, plan };
    }
    if (station.current_calibration_id !== newCalibrationId) {
      throw new Error("[scanner-geometry-repair] Station no longer points at the exact incident repair calibration");
    }
    assertExactCorrectedCalibration(station, newCalibrationId, plan);
    await assertCorrectedCalibrationUnused(client, newCalibrationId);
    await assertPreservedPreviousCalibration(client, repaired.detail.previousRowDigest);
    const update = await client.query(
      `UPDATE partner_stations
          SET current_calibration_id=$2, calibration_status='VALID', updated_at=now()
        WHERE id=$1 AND current_calibration_id=$3 AND status='ACTIVE' AND calibration_status='VALID'`,
      [
        APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
        APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
        newCalibrationId,
      ]
    );
    if (update.rowCount !== 1)
      throw new Error("[scanner-geometry-repair] Rollback pointer update did not affect exactly one station");
    const restored = await lockedStationCalibration(client, true);
    assertStationScope(restored);
    assertExactPreviousCalibration(restored);
    requireExact("restored row digest", previousCalibrationRowDigest(restored), repaired.detail.previousRowDigest);
    const rollbackEvent = await client.query(
      `INSERT INTO partner_station_events
         (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_capture_geometry_rollback',$5::jsonb)`,
      [
        APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
        APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
        APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
        APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
        JSON.stringify({
          repairKey: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.repairKey,
          previousCalibrationId: newCalibrationId,
          restoredCalibrationId: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
          reason: "incident-repair-rollback-before-physical-acceptance",
        }),
      ]
    );
    if (rollbackEvent.rowCount !== 1) {
      throw new Error("[scanner-geometry-repair] Rollback audit insert did not affect exactly one row");
    }
    return {
      mode,
      rolledBack: true,
      restoredCalibrationId: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
      plan,
    };
  }

  if (repaired) {
    if (!rolledBack && station.current_calibration_id === repaired.detail.newCalibrationId) {
      assertExactCorrectedCalibration(station, String(repaired.detail.newCalibrationId), plan);
      await assertPreservedPreviousCalibration(client, repaired.detail.previousRowDigest, mode !== "inspect");
      return { mode, alreadyApplied: true, newCalibrationId: repaired.detail.newCalibrationId, plan };
    }
    throw new Error("[scanner-geometry-repair] Incident repair history already exists in a non-applicable state");
  }
  assertExactPreviousCalibration(station);
  const previousRowDigest = previousCalibrationRowDigest(station);

  if (mode === "inspect") {
    return { mode, applicable: true, previousRowDigest, plan };
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO partner_station_calibrations
       (tenant_id,location_id,station_id,calibration_fingerprint,scanner_hardware_fingerprint,scanner_hardware,
        scanner_profile_version,acquisition_region,working_region,placement_tolerance_mm,
        calibration_version,health_status,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,'VALID',$12)
     ON CONFLICT (station_id,calibration_fingerprint) DO NOTHING
     RETURNING id`,
    [
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
      plan.calibrationFingerprint,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.scannerHardwareFingerprint,
      JSON.stringify(plan.scannerHardware),
      plan.scannerProfileVersion,
      JSON.stringify(plan.acquisitionRegion),
      JSON.stringify(plan.workingRegion),
      JSON.stringify(plan.placementToleranceMm),
      plan.calibrationVersion,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
    ]
  );
  const newCalibrationId = inserted.rows[0]?.id;
  if (!newCalibrationId || inserted.rows.length !== 1) {
    throw new Error(
      "[scanner-geometry-repair] Corrected calibration already exists without canonical incident provenance"
    );
  }
  const corrected = await exactCalibrationById(client, newCalibrationId);
  assertStationScope(corrected);
  assertExactCorrectedCalibration(corrected, newCalibrationId, plan, false);

  const update = await client.query(
    `UPDATE partner_stations
        SET current_calibration_id=$2, calibration_status='VALID', updated_at=now()
      WHERE id=$1 AND current_calibration_id=$3 AND status='ACTIVE' AND calibration_status='VALID'`,
    [
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
      newCalibrationId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
    ]
  );
  if (update.rowCount !== 1)
    throw new Error("[scanner-geometry-repair] Pointer update did not affect exactly one station");

  const updated = await lockedStationCalibration(client, true);
  assertStationScope(updated);
  assertExactCorrectedCalibration(updated, newCalibrationId, plan);

  const repairEvent = await client.query(
    `INSERT INTO partner_station_events
       (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
     VALUES ($1,$2,$3,$4,'station_capture_geometry_repaired',$5::jsonb)`,
    [
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.tenantId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.locationId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.stationId,
      APPROVED_STAGING_CANON_GEOMETRY_REPAIR.actorUserId,
      JSON.stringify({
        repairKey: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.repairKey,
        reason: "physical-canon-proof-stale-inverted-y-driver-origin",
        previousCalibrationId: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationId,
        previousCalibrationFingerprint: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousCalibrationFingerprint,
        previousRowDigest,
        previousAcquisitionRegion: APPROVED_STAGING_CANON_GEOMETRY_REPAIR.previousAcquisitionRegion,
        newCalibrationId,
        newCalibrationFingerprint: plan.calibrationFingerprint,
        newAcquisitionRegion: plan.acquisitionRegion,
        masterEvidenceMinMarginMm: plan.masterEvidenceMinMarginMm,
        previewGreenMinMarginMm: plan.previewGreenMinMarginMm,
      }),
    ]
  );
  if (repairEvent.rowCount !== 1) {
    throw new Error("[scanner-geometry-repair] Repair audit insert did not affect exactly one row");
  }
  return { mode, applied: true, newCalibrationId, previousRowDigest, plan };
}

export async function runApprovedStagingCanonGeometryRepair(mode: RepairMode, env: NodeJS.ProcessEnv = process.env) {
  // Run the runtime/database gates before acquiring any row lock.
  approvedStagingCanonGeometryRepairPlan(env);
  return withPartnerAdminTransaction((client) => executeApprovedStagingCanonGeometryRepair(client, mode, env));
}
