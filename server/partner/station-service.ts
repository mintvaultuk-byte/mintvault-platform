import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { PartnerPrincipal } from "./session";
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import {
  StationIdentityError,
  assertStationRequestBodyDigest,
  createStationCode,
  normalizeStationPublicKey,
  parseStationRequestHeaders,
  parseStationRequestHeadersV2,
  stationPublicKeyFingerprint,
  verifyStationSignature,
  verifyStationSignatureV2,
} from "./station-identity";

export type StationStatus =
  | "PENDING"
  | "ACTIVE"
  | "SUSPENDED"
  | "REVOKED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED";
export type StationFleetTransition = "ACTIVE" | "SUSPENDED" | "REVOKED";
export type CalibrationStatus = "UNPROVISIONED" | "VALID" | "INVALID" | "EXPIRED";

export type StationPrincipal = {
  id: string;
  code: string;
  tenantId: string;
  locationId: string;
  appVersion: string | null;
  scannerProfileVersion: string | null;
  calibrationStatus: CalibrationStatus;
  currentCalibrationId: string | null;
  currentProfileRevisionId: string | null;
  protocol: 1 | 2;
  semanticOperationId: string | null;
};

/** Credential-free station summary used only to let an authorised Partner
 * operator choose a real, ready capture destination. The browser never sees a
 * public key, nonce, device identifier or session target. */
export type PartnerCaptureStation = {
  stationCode: string;
  locationId: string;
  locationName: string;
};

export class StationServiceError extends Error {
  constructor(
    readonly code:
      | "validation"
      | "forbidden"
      | "station_not_found"
      | "station_not_active"
      | "station_replay"
      | "station_key_conflict"
      | "version_blocked"
      | "calibration_required"
      | "location_required",
    message: string
  ) {
    super(message);
  }
}

type StationAuthRow = {
  id: string;
  station_code: string;
  tenant_id: string;
  location_id: string;
  status: StationStatus;
  public_key_pem: string;
  app_version: string | null;
  minimum_supported_version: string | null;
  scanner_profile_version: string | null;
  calibration_status: CalibrationStatus;
  current_calibration_id: string | null;
  current_profile_revision_id: string | null;
  credential_epoch: string | number;
  request_epoch: string | number;
  organisation_status: string;
  location_status: string;
};

function boundedText(value: unknown, field: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new StationServiceError("validation", `${field} is invalid`);
  }
  return value.trim();
}

function optionalText(value: unknown, max = 160): string | null {
  if (value == null || value === "") return null;
  return boundedText(value, "value", max);
}

function finiteRegion(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StationServiceError("validation", `${field} is required`);
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = source[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 400) {
      throw new StationServiceError("validation", `${field}.${key} is invalid`);
    }
    out[key] = Number(number.toFixed(3));
  }
  if (out.width <= 0 || out.height <= 0) throw new StationServiceError("validation", `${field} dimensions are invalid`);
  return out;
}

function finiteMargins(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StationServiceError("validation", `${field} is invalid`);
  }
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["left", "right", "top", "bottom"]) {
    const number = raw[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 100) {
      throw new StationServiceError("validation", `${field}.${key} is invalid`);
    }
    out[key] = Number(number.toFixed(3));
  }
  return out;
}

function safeObject(value: unknown, field: string, allowed: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StationServiceError("validation", `${field} is invalid`);
  }
  const raw = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of allowed) {
    if (raw[key] == null || raw[key] === "") continue;
    out[key] = boundedText(raw[key], `${field}.${key}`, 200);
  }
  if (!out.model && !out.deviceId && !out.serial) {
    throw new StationServiceError("validation", `${field} needs scanner model, device ID or serial`);
  }
  return out;
}

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

function versionTuple(raw: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(raw.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function appVersionSatisfies(installed: string | null, minimum: string | null): boolean {
  if (!minimum) return true;
  if (!installed) return false;
  const a = versionTuple(installed);
  const b = versionTuple(minimum);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
}

/**
 * A station can only attest a newly installed Scanner version on its signed
 * heartbeat.  The exact JSON bytes are already part of the station signature,
 * so a proxy or another browser session cannot advance this value.  Keeping
 * this parser separate also makes it impossible for an arbitrary capture body
 * to become a version-update channel.
 */
export function signedHeartbeatAppVersion(method: string, requestPath: string, rawBody: unknown): string | null {
  let pathname: string;
  try {
    pathname = new URL(requestPath, "https://mintvault.invalid").pathname;
  } catch {
    return null;
  }
  if (method.toUpperCase() !== "POST" || pathname !== "/api/partner/stations/heartbeat" || !Buffer.isBuffer(rawBody)) {
    return null;
  }
  try {
    const payload = JSON.parse(rawBody.toString("utf8")) as { appVersion?: unknown };
    const value = typeof payload.appVersion === "string" ? payload.appVersion.trim() : "";
    return versionTuple(value) ? value : null;
  } catch {
    return null;
  }
}

function shouldPersistAttestedVersion(current: string | null, attested: string | null): boolean {
  if (!attested) return false;
  const next = versionTuple(attested);
  if (!next) return false;
  const existing = current ? versionTuple(current) : null;
  if (!existing) return true;
  return (
    next[0] > existing[0] ||
    (next[0] === existing[0] && (next[1] > existing[1] || (next[1] === existing[1] && next[2] >= existing[2])))
  );
}

async function resolvePermittedLocation(
  client: PoolClient,
  principal: PartnerPrincipal,
  suppliedLocationId: unknown
): Promise<string> {
  const requested =
    typeof suppliedLocationId === "string" && suppliedLocationId.trim() ? suppliedLocationId.trim() : null;
  if (requested) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT l.id
         FROM partner_locations l
        WHERE l.id=$1 AND l.tenant_id=$2 AND l.status='ACTIVE'
          AND ($3::boolean OR EXISTS (
            SELECT 1 FROM partner_user_locations ul WHERE ul.user_id=$4 AND ul.location_id=l.id
          ))`,
      [requested, principal.tenantId, principal.orgWide, principal.userId]
    );
    if (rows.length !== 1) throw new StationServiceError("forbidden", "You are not authorised for that location");
    return rows[0].id;
  }
  if (principal.locationId) return resolvePermittedLocation(client, principal, principal.locationId);
  const { rows } = await client.query<{ id: string }>(
    `SELECT l.id FROM partner_locations l
      WHERE l.tenant_id=$1 AND l.status='ACTIVE'
        AND ($2::boolean OR EXISTS (
          SELECT 1 FROM partner_user_locations ul WHERE ul.user_id=$3 AND ul.location_id=l.id
        ))
      ORDER BY l.created_at, l.id LIMIT 2`,
    [principal.tenantId, principal.orgWide, principal.userId]
  );
  if (rows.length === 1) return rows[0].id;
  throw new StationServiceError(
    "location_required",
    "Select one of your authorised locations before registering this Mac"
  );
}

export async function requestStationEnrollment(
  principal: PartnerPrincipal,
  input: {
    locationId?: unknown;
    publicKeyPem: unknown;
    publicKeyFingerprint?: unknown;
    installationFingerprint?: unknown;
    appVersion?: unknown;
    clientOpId?: unknown;
  }
): Promise<{ id: string; stationCode: string; status: "PENDING"; locationId: string }> {
  const publicKeyPem = normalizeStationPublicKey(boundedText(input.publicKeyPem, "publicKeyPem", 8_000));
  const publicKeyFingerprint = stationPublicKeyFingerprint(publicKeyPem);
  const installationFingerprint =
    input.installationFingerprint == null
      ? null
      : boundedText(input.installationFingerprint, "installationFingerprint", 64);
  if (installationFingerprint && !/^[a-f0-9]{64}$/i.test(installationFingerprint)) {
    throw new StationServiceError("validation", "installationFingerprint is invalid");
  }
  const appVersion = optionalText(input.appVersion, 64);
  const clientOpId = typeof input.clientOpId === "string" ? input.clientOpId.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientOpId)) {
    throw new StationServiceError("validation", "clientOpId is invalid");
  }
  if (input.publicKeyFingerprint != null && String(input.publicKeyFingerprint).toLowerCase() !== publicKeyFingerprint) {
    throw new StationServiceError("validation", "publicKeyFingerprint does not match publicKeyPem");
  }
  const enrolmentFingerprint = fingerprint({
    locationId: input.locationId == null ? null : String(input.locationId),
    publicKeyPem,
    publicKeyFingerprint,
    installationFingerprint: installationFingerprint?.toLowerCase() ?? null,
    appVersion,
  });
  return withPartnerAdminTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`station-enrol:${clientOpId}`]);
    const replay = await client.query<{
      request_fingerprint: string;
      tenant_id: string;
      actor_user_id: string;
      public_key_fingerprint: string;
      id: string;
      station_code: string;
      status: string;
      location_id: string;
    }>(
      `SELECT op.request_fingerprint,op.actor_user_id,op.public_key_fingerprint,op.tenant_id,
              s.id,s.station_code,s.status,s.location_id
         FROM partner_station_enrolment_operations op
         JOIN partner_stations s ON s.id=op.station_id
        WHERE op.client_op_id=$1`,
      [clientOpId]
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (
        row.tenant_id !== principal.tenantId ||
        row.request_fingerprint !== enrolmentFingerprint ||
        row.actor_user_id !== principal.userId ||
        row.public_key_fingerprint !== publicKeyFingerprint
      ) {
        throw new StationServiceError("validation", "Enrolment idempotency conflict");
      }
      return { id: row.id, stationCode: row.station_code, status: "PENDING", locationId: row.location_id };
    }
    const locationId = await resolvePermittedLocation(client, principal, input.locationId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const stationCode = createStationCode();
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO partner_stations
             (station_code, tenant_id, location_id, public_key_pem, public_key_fingerprint, installation_fingerprint, app_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [
            stationCode,
            principal.tenantId,
            locationId,
            publicKeyPem,
            publicKeyFingerprint,
            installationFingerprint?.toLowerCase() ?? null,
            appVersion,
          ]
        );
        const id = rows[0].id;
        await client.query(
          `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
           VALUES ($1,$2,$3,$4,'station_enrolment_requested',$5::jsonb)`,
          [principal.tenantId, locationId, id, principal.userId, JSON.stringify({ appVersion, publicKeyFingerprint })]
        );
        await client.query(
          `INSERT INTO partner_station_enrolment_operations
             (tenant_id,actor_user_id,client_op_id,public_key_fingerprint,request_fingerprint,station_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [principal.tenantId, principal.userId, clientOpId, publicKeyFingerprint, enrolmentFingerprint, id]
        );
        return { id, stationCode, status: "PENDING", locationId };
      } catch (error: any) {
        if (error?.code !== "23505") throw error;
        if (String(error?.constraint || "").includes("public_key_fingerprint")) {
          throw new StationServiceError(
            "station_key_conflict",
            "This Mac key is already enrolled; it cannot be cloned to another station"
          );
        }
      }
    }
    throw new StationServiceError("validation", "Unable to allocate a unique station code");
  });
}

/** Locations a scanner-capable user may choose during Mac enrolment. */
export async function listPermittedStationLocations(
  principal: PartnerPrincipal
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await partnerAdminQuery<{ id: string; name: string }>(
    `SELECT l.id, l.name
       FROM partner_locations l
      WHERE l.tenant_id=$1 AND l.status='ACTIVE'
        AND ($2::boolean OR EXISTS (
          SELECT 1 FROM partner_user_locations ul WHERE ul.user_id=$3 AND ul.location_id=l.id
        ))
      ORDER BY l.name, l.id`,
    [principal.tenantId, principal.orgWide, principal.userId]
  );
  return rows;
}

/**
 * The requesting operator can poll only a station in their own permitted
 * tenant/location. This carries no key material and lets a newly enrolled Mac
 * learn that a Super Admin has approved it without accepting client claims.
 */
export async function getStationEnrollmentStatus(
  principal: PartnerPrincipal,
  stationCode: unknown
): Promise<{
  stationCode: string;
  status: StationStatus;
  locationId: string;
  calibrationStatus: CalibrationStatus;
  appVersion: string | null;
  minimumSupportedVersion: string | null;
  publicKeyFingerprint: string;
  currentProfileRevisionId: string | null;
  currentProfileDigestSha256: string | null;
  scannerUpdatePolicy: unknown;
}> {
  const code = typeof stationCode === "string" ? stationCode.trim().toUpperCase() : "";
  if (!/^MV-STN-[A-Z2-7]{10,24}$/.test(code)) throw new StationServiceError("validation", "stationCode is invalid");
  return withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      station_code: string;
      status: StationStatus;
      location_id: string;
      calibration_status: CalibrationStatus;
      app_version: string | null;
      minimum_supported_version: string | null;
      public_key_fingerprint: string;
      current_profile_revision_id: string | null;
      profile_digest_sha256: string | null;
      scanner_update_policy: unknown;
      enrolment_expired: boolean;
    }>(
      `SELECT s.id,s.station_code,s.status,s.location_id,s.calibration_status,
              s.app_version,s.minimum_supported_version,s.public_key_fingerprint,
              s.current_profile_revision_id,profile.profile_digest_sha256,s.scanner_update_policy,
              (s.enrolment_expires_at <= now()) AS enrolment_expired
         FROM partner_stations s
         LEFT JOIN partner_station_profile_revisions profile ON profile.id=s.current_profile_revision_id
        WHERE s.station_code=$1 AND s.tenant_id=$2
          AND ($3::boolean OR EXISTS (
            SELECT 1 FROM partner_user_locations ul WHERE ul.user_id=$4 AND ul.location_id=s.location_id
          ))
        LIMIT 1
        FOR UPDATE OF s`,
      [code, principal.tenantId, principal.orgWide, principal.userId]
    );
    const station = rows[0];
    if (!station) throw new StationServiceError("forbidden", "Station is not available to this operator");
    if (station.status === "PENDING" && station.enrolment_expired) {
      await client.query(
        `UPDATE partner_stations
            SET status='EXPIRED',credential_epoch=credential_epoch+1,updated_at=now()
          WHERE id=$1 AND status='PENDING'`,
        [station.id]
      );
      await client.query(
        `INSERT INTO partner_station_events (tenant_id,location_id,station_id,event_type,detail)
         VALUES ($1,$2,$3,'station_expired',$4::jsonb)`,
        [principal.tenantId, station.location_id, station.id, JSON.stringify({ previousStatus: "PENDING", credentialEpochRotated: true })]
      );
      station.status = "EXPIRED";
    }
    return {
      stationCode: station.station_code,
      status: station.status,
      locationId: station.location_id,
      calibrationStatus: station.calibration_status,
      appVersion: station.app_version,
      minimumSupportedVersion: station.minimum_supported_version,
      publicKeyFingerprint: station.public_key_fingerprint,
      currentProfileRevisionId: station.current_profile_revision_id,
      currentProfileDigestSha256: station.profile_digest_sha256,
      scannerUpdatePolicy: station.scanner_update_policy,
    };
  });
}

/** List capture-ready stations in the authenticated Partner's own scope. */
export async function listPartnerCaptureStations(principal: PartnerPrincipal): Promise<PartnerCaptureStation[]> {
  const { rows } = await partnerAdminQuery<{
    station_code: string;
    location_id: string;
    location_name: string;
    app_version: string | null;
    minimum_supported_version: string | null;
    calibration_status: CalibrationStatus;
    current_calibration_id: string | null;
    current_profile_revision_id: string | null;
  }>(
    `SELECT s.station_code, s.location_id, l.name AS location_name,
            s.app_version, s.minimum_supported_version,
            s.calibration_status, s.current_calibration_id, s.current_profile_revision_id
       FROM partner_stations s
       JOIN partner_organisations o ON o.id=s.tenant_id AND o.status='ACTIVE'
       JOIN partner_locations l ON l.id=s.location_id AND l.status='ACTIVE'
      WHERE s.tenant_id=$1
        AND s.status='ACTIVE'
        AND ($2::boolean OR s.location_id=$3::uuid)
      ORDER BY l.name ASC, s.station_code ASC`,
    [principal.tenantId, principal.orgWide, principal.locationId]
  );
  return rows
    .filter(
      (station) =>
        station.calibration_status === "VALID" &&
        !!station.current_calibration_id &&
        !!station.current_profile_revision_id &&
        appVersionSatisfies(station.app_version, station.minimum_supported_version)
    )
    .map((station) => ({
      stationCode: station.station_code,
      locationId: station.location_id,
      locationName: station.location_name,
    }));
}

/** Resolve an approved station for a trusted browser/admin target arm. */
export async function resolveActiveStationByCode(stationCode: unknown): Promise<StationPrincipal | null> {
  const code = typeof stationCode === "string" ? stationCode.trim().toUpperCase() : "";
  if (!/^MV-STN-[A-Z2-7]{10,24}$/.test(code)) return null;
  const { rows } = await partnerAdminQuery<StationAuthRow>(
    `SELECT s.id, s.station_code, s.tenant_id, s.location_id, s.status, s.public_key_pem,
            s.app_version, s.minimum_supported_version, s.scanner_profile_version,
            s.calibration_status, s.current_calibration_id, s.current_profile_revision_id,
            s.credential_epoch, s.request_epoch,
            o.status AS organisation_status, l.status AS location_status
       FROM partner_stations s
       JOIN partner_organisations o ON o.id=s.tenant_id
       JOIN partner_locations l ON l.id=s.location_id
      WHERE s.station_code=$1 AND s.status='ACTIVE' AND o.status='ACTIVE' AND l.status='ACTIVE' LIMIT 1`,
    [code]
  );
  const station = rows[0];
  if (!station || !appVersionSatisfies(station.app_version, station.minimum_supported_version)) return null;
  return {
    id: station.id,
    code: station.station_code,
    tenantId: station.tenant_id,
    locationId: station.location_id,
    appVersion: station.app_version,
    scannerProfileVersion: station.scanner_profile_version,
    calibrationStatus: station.calibration_status,
    currentCalibrationId: station.current_calibration_id,
    currentProfileRevisionId: station.current_profile_revision_id,
    protocol: 1,
    semanticOperationId: null,
  };
}

export async function authenticateStationRequest(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  rawBody?: unknown
): Promise<StationPrincipal> {
  const protocol2 = (Array.isArray(headers["x-mintvault-station-protocol"])
    ? headers["x-mintvault-station-protocol"]?.[0]
    : headers["x-mintvault-station-protocol"]) === "2";
  const parsed = protocol2
    ? parseStationRequestHeadersV2(headers, method, path)
    : parseStationRequestHeaders(headers, method, path);
  assertStationRequestBodyDigest(parsed.envelope, rawBody);
  const { rows } = await partnerAdminQuery<StationAuthRow>(
    `SELECT s.id, s.station_code, s.tenant_id, s.location_id, s.status, s.public_key_pem,
            s.app_version, s.minimum_supported_version, s.scanner_profile_version,
            s.calibration_status, s.current_calibration_id, s.current_profile_revision_id,
            s.credential_epoch, s.request_epoch,
            o.status AS organisation_status, l.status AS location_status
       FROM partner_stations s
       JOIN partner_organisations o ON o.id=s.tenant_id
       JOIN partner_locations l ON l.id=s.location_id
      WHERE s.station_code=$1 LIMIT 1`,
    [parsed.envelope.stationCode]
  );
  const station = rows[0];
  if (!station) throw new StationServiceError("station_not_found", "Station is not enrolled");
  const signatureValid = protocol2
    ? verifyStationSignatureV2(station.public_key_pem, parsed.envelope as import("./station-identity").StationRequestEnvelopeV2, parsed.signature)
    : verifyStationSignature(station.public_key_pem, parsed.envelope as import("./station-identity").StationRequestEnvelope, parsed.signature);
  if (!signatureValid) {
    throw new StationIdentityError("invalid_signature", "Station signature is invalid");
  }
  if (station.status !== "ACTIVE" || station.organisation_status !== "ACTIVE" || station.location_status !== "ACTIVE") {
    throw new StationServiceError("station_not_active", "Station, partner or location is not active");
  }
  // A correctly signed newly installed app used to deadlock here: the server
  // compared the old stored version before the heartbeat route was allowed to
  // store the new body version.  Only this body-bound heartbeat attestation can
  // break that cycle; capture/calibration routes still require the persisted
  // version after this transaction commits.
  const attestedVersion = signedHeartbeatAppVersion(method, path, rawBody);
  const effectiveVersion = shouldPersistAttestedVersion(station.app_version, attestedVersion)
    ? attestedVersion
    : station.app_version;
  if (!appVersionSatisfies(effectiveVersion, station.minimum_supported_version)) {
    throw new StationServiceError("version_blocked", "Station version is below the minimum supported version");
  }
  // A monotonic signed nonce gives replay resistance without a high-churn
  // nonce table at 5,000 online stations. The conditional update is the
  // global, database-backed acceptance point across every app replica.
  const replayValue = protocol2
    ? (parsed.envelope as import("./station-identity").StationRequestEnvelopeV2).sequence.toString()
    : (parsed.envelope as import("./station-identity").StationRequestEnvelope).nonce.toString();
  const v2Envelope = protocol2
    ? (parsed.envelope as import("./station-identity").StationRequestEnvelopeV2)
    : null;
  const advanced = await partnerAdminQuery<{ id: string; app_version: string | null }>(
    `UPDATE partner_stations s
        SET last_request_nonce=CASE WHEN $4::boolean THEN s.last_request_nonce ELSE $2::bigint END,
            last_request_sequence=CASE WHEN $4::boolean THEN $2::bigint ELSE s.last_request_sequence END,
            app_version=COALESCE($3, s.app_version),
            updated_at=now()
      WHERE s.id=$1 AND s.status='ACTIVE'
        AND (($4::boolean AND s.credential_epoch=$5::bigint AND s.request_epoch=$6::bigint AND s.last_request_sequence < $2::bigint)
          OR (NOT $4::boolean AND s.last_request_nonce < $2::bigint))
        AND EXISTS (SELECT 1 FROM partner_organisations o WHERE o.id=s.tenant_id AND o.status='ACTIVE')
        AND EXISTS (SELECT 1 FROM partner_locations l WHERE l.id=s.location_id AND l.status='ACTIVE')
      RETURNING s.id, s.app_version`,
    [
      station.id,
      replayValue,
      shouldPersistAttestedVersion(station.app_version, attestedVersion) ? attestedVersion : null,
      protocol2,
      v2Envelope?.credentialEpoch.toString() ?? String(station.credential_epoch),
      v2Envelope?.requestEpoch.toString() ?? String(station.request_epoch),
    ]
  );
  if (advanced.rows.length !== 1)
    throw new StationServiceError("station_replay", "Station request was replayed or the station was suspended");
  return {
    id: station.id,
    code: station.station_code,
    tenantId: station.tenant_id,
    locationId: station.location_id,
    appVersion: advanced.rows[0].app_version,
    scannerProfileVersion: station.scanner_profile_version,
    calibrationStatus: station.calibration_status,
    currentCalibrationId: station.current_calibration_id,
    currentProfileRevisionId: station.current_profile_revision_id,
    protocol: protocol2 ? 2 : 1,
    semanticOperationId: v2Envelope?.semanticOperationId ?? null,
  };
}

export function assertStationCaptureReady(station: StationPrincipal, requiredProfileVersion: string): void {
  if (station.calibrationStatus !== "VALID" || !station.currentCalibrationId || !station.currentProfileRevisionId) {
    throw new StationServiceError(
      "calibration_required",
      "Station calibration is required before authoritative capture"
    );
  }
  if (station.scannerProfileVersion !== requiredProfileVersion) {
    throw new StationServiceError(
      "calibration_required",
      "Station calibration does not match the locked scanner profile"
    );
  }
}

export async function recordStationHeartbeat(
  station: StationPrincipal,
  input: {
    appVersion?: unknown;
    scannerConnected: unknown;
    scannerHardware: unknown;
    scannerProfileVersion?: unknown;
    pendingUploadCount?: unknown;
    captureState?: unknown;
    lastFailureCode?: unknown;
  }
): Promise<{ calibrationStatus: CalibrationStatus; hardwareChanged: boolean; profileChanged: boolean }> {
  const appVersion = input.appVersion == null ? station.appVersion : boundedText(input.appVersion, "appVersion", 64);
  if (typeof input.scannerConnected !== "boolean")
    throw new StationServiceError("validation", "scannerConnected is invalid");
  const scannerHardware = safeObject(input.scannerHardware, "scannerHardware", [
    "manufacturer",
    "model",
    "serial",
    "deviceId",
  ]);
  const hardwareFingerprint = fingerprint(scannerHardware);
  const scannerProfileVersion =
    input.scannerProfileVersion == null
      ? station.scannerProfileVersion
      : boundedText(input.scannerProfileVersion, "scannerProfileVersion", 120);
  const pendingUploadCount = input.pendingUploadCount == null ? 0 : Number(input.pendingUploadCount);
  if (!Number.isInteger(pendingUploadCount) || pendingUploadCount < 0 || pendingUploadCount > 1000) {
    throw new StationServiceError("validation", "pendingUploadCount is invalid");
  }
  const captureState = input.captureState == null ? "IDLE" : boundedText(input.captureState, "captureState", 64);
  const lastFailureCode = optionalText(input.lastFailureCode, 120);
  return withPartnerAdminTransaction(async (client) => {
    const current = await client.query<{
      scanner_connected: boolean;
      scanner_hardware_fingerprint: string | null;
      scanner_profile_version: string | null;
      capture_state: string;
      last_failure_code: string | null;
    }>(
      `SELECT scanner_connected, scanner_hardware_fingerprint, scanner_profile_version, capture_state, last_failure_code
         FROM partner_stations WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [station.id, station.tenantId]
    );
    if (current.rows.length !== 1)
      throw new StationServiceError("station_not_active", "Station is no longer available");
    const previous = current.rows[0];
    const hardwareChanged =
      previous.scanner_hardware_fingerprint != null && previous.scanner_hardware_fingerprint !== hardwareFingerprint;
    // A jig calibration is inseparable from both the physical scanner and the
    // locked acquisition profile. A new profile may have a different platen
    // transform, DPI or acquisition implementation even when the USB identity
    // is unchanged, so it must require a fresh calibration before evidence.
    const profileChanged =
      previous.scanner_profile_version != null && previous.scanner_profile_version !== scannerProfileVersion;
    const calibrationInvalidated = hardwareChanged || profileChanged;
    const calibrationStatus: CalibrationStatus = calibrationInvalidated ? "INVALID" : station.calibrationStatus;
    const updated = await client.query<{ id: string }>(
      `UPDATE partner_stations
          SET app_version=$2, scanner_connected=$3, scanner_hardware=$4::jsonb,
              scanner_hardware_fingerprint=$5, scanner_profile_version=$6,
              pending_upload_count=$7, capture_state=$8, last_failure_code=$9,
              calibration_status=$10,
              current_calibration_id=CASE WHEN $11 THEN NULL ELSE current_calibration_id END,
              last_seen_at=now(), updated_at=now()
        WHERE id=$1 AND status='ACTIVE'
        RETURNING id`,
      [
        station.id,
        appVersion,
        input.scannerConnected,
        JSON.stringify(scannerHardware),
        hardwareFingerprint,
        scannerProfileVersion,
        pendingUploadCount,
        captureState,
        lastFailureCode,
        calibrationStatus,
        calibrationInvalidated,
      ]
    );
    if (updated.rows.length !== 1) throw new StationServiceError("station_not_active", "Station is no longer active");
    const connectionChanged = previous.scanner_connected !== input.scannerConnected;
    const captureStateChanged = previous.capture_state !== captureState;
    const failureChanged = previous.last_failure_code !== lastFailureCode;
    // Heartbeats update the current row every interval, but append at most one
    // event only when an operator-relevant transition/failure actually changes.
    if (hardwareChanged || profileChanged || connectionChanged || captureStateChanged || failureChanged) {
      await client.query(
        `INSERT INTO partner_station_events (tenant_id,location_id,station_id,event_type,detail)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          station.tenantId,
          station.locationId,
          station.id,
          hardwareChanged
            ? "scanner_hardware_changed"
            : profileChanged
              ? "scanner_profile_changed"
              : connectionChanged
                ? "scanner_connection_changed"
                : failureChanged
                  ? "scanner_failure_changed"
                  : "scanner_capture_state_changed",
          JSON.stringify({
            scannerConnected: input.scannerConnected,
            hardwareFingerprint,
            scannerProfileVersion,
            captureState,
            lastFailureCode,
          }),
        ]
      );
    }
    return { calibrationStatus, hardwareChanged, profileChanged };
  });
}

export async function saveStationCalibration(
  station: StationPrincipal,
  actorUserId: string,
  input: {
    scannerHardware: unknown;
    scannerProfileVersion: unknown;
    acquisitionRegion: unknown;
    workingRegion?: unknown;
    placementToleranceMm?: unknown;
    calibrationVersion: unknown;
  }
): Promise<{ id: string; calibrationStatus: "VALID" }> {
  const scannerHardware = safeObject(input.scannerHardware, "scannerHardware", [
    "manufacturer",
    "model",
    "serial",
    "deviceId",
  ]);
  const scannerHardwareFingerprint = fingerprint(scannerHardware);
  const scannerProfileVersion = boundedText(input.scannerProfileVersion, "scannerProfileVersion", 120);
  const acquisitionRegion = finiteRegion(input.acquisitionRegion, "acquisitionRegion");
  const workingRegion = input.workingRegion == null ? {} : finiteRegion(input.workingRegion, "workingRegion");
  const placementToleranceMm =
    input.placementToleranceMm == null ? {} : finiteMargins(input.placementToleranceMm, "placementToleranceMm");
  const calibrationVersion = boundedText(input.calibrationVersion, "calibrationVersion", 120);
  const calibrationFingerprint = fingerprint({
    scannerHardwareFingerprint,
    scannerProfileVersion,
    acquisitionRegion,
    workingRegion,
    placementToleranceMm,
    calibrationVersion,
  });
  return withPartnerAdminTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO partner_station_calibrations
         (tenant_id,location_id,station_id,calibration_fingerprint,scanner_hardware_fingerprint,scanner_hardware,
          scanner_profile_version,acquisition_region,working_region,placement_tolerance_mm,calibration_version,health_status,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,'VALID',$12)
       ON CONFLICT (station_id,calibration_fingerprint) DO UPDATE SET calibration_fingerprint=EXCLUDED.calibration_fingerprint
       RETURNING id`,
      [
        station.tenantId,
        station.locationId,
        station.id,
        calibrationFingerprint,
        scannerHardwareFingerprint,
        JSON.stringify(scannerHardware),
        scannerProfileVersion,
        JSON.stringify(acquisitionRegion),
        JSON.stringify(workingRegion),
        JSON.stringify(placementToleranceMm),
        calibrationVersion,
        actorUserId,
      ]
    );
    const id = inserted.rows[0].id;
    const stationUpdated = await client.query(
      `UPDATE partner_stations
          SET current_calibration_id=$2, calibration_status='VALID', scanner_hardware=$3::jsonb,
              scanner_hardware_fingerprint=$4, scanner_profile_version=$5, updated_at=now()
        WHERE id=$1 AND status='ACTIVE'`,
      [station.id, id, JSON.stringify(scannerHardware), scannerHardwareFingerprint, scannerProfileVersion]
    );
    if (stationUpdated.rowCount !== 1) {
      throw new StationServiceError("station_not_active", "Station authority changed during profile setup");
    }
    await client.query(
      `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_calibration_saved',$5::jsonb)`,
      [
        station.tenantId,
        station.locationId,
        station.id,
        actorUserId,
        JSON.stringify({ calibrationId: id, scannerHardwareFingerprint, scannerProfileVersion, calibrationVersion }),
      ]
    );
    return { id, calibrationStatus: "VALID" };
  });
}

export async function transitionStationStatus(
  stationCode: string,
  status: StationFleetTransition,
  actorUserId: string | null,
  reason: string
): Promise<void> {
  const cleanCode = boundedText(stationCode, "stationCode", 40).toUpperCase();
  const cleanReason = boundedText(reason, "reason", 1000);
  await withPartnerAdminTransaction(async (client) => {
    const current = await client.query<{ id: string; tenant_id: string; location_id: string; status: StationStatus }>(
      `SELECT id,tenant_id,location_id,status FROM partner_stations WHERE station_code=$1 FOR UPDATE`,
      [cleanCode]
    );
    const row = current.rows[0];
    if (!row) throw new StationServiceError("station_not_found", "Station not found");
    if (["REVOKED", "REJECTED", "CANCELLED", "EXPIRED"].includes(row.status) && row.status !== status)
      throw new StationServiceError("validation", "Terminal station cannot be reactivated");
    await client.query(
      `UPDATE partner_stations
          SET status=$2, credential_epoch=credential_epoch+1,
              approved_at=CASE WHEN $2='ACTIVE' THEN now() ELSE approved_at END,
              approved_by=CASE WHEN $2='ACTIVE' THEN $3 ELSE approved_by END,
              suspended_at=CASE WHEN $2='SUSPENDED' THEN now() ELSE suspended_at END,
              suspended_by=CASE WHEN $2='SUSPENDED' THEN $3 ELSE suspended_by END,
              revoked_at=CASE WHEN $2='REVOKED' THEN now() ELSE revoked_at END,
              revoked_by=CASE WHEN $2='REVOKED' THEN $3 ELSE revoked_by END,
              updated_at=now()
        WHERE id=$1`,
      [row.id, status, actorUserId]
    );
    await client.query(
      `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        row.tenant_id,
        row.location_id,
        row.id,
        actorUserId,
        `station_${status.toLowerCase()}`,
        JSON.stringify({ reason: cleanReason, previousStatus: row.status, credentialEpochRotated: true }),
      ]
    );
  });
}

/** Reject is intentionally distinct from revocation: it applies only before a
 * station was approved and leaves a durable operator-facing rejection event. */
export async function rejectPendingStation(
  stationCode: string,
  actorUserId: string | null,
  reason: string
): Promise<void> {
  const cleanCode = boundedText(stationCode, "stationCode", 40).toUpperCase();
  const cleanReason = boundedText(reason, "reason", 1000);
  await withPartnerAdminTransaction(async (client) => {
    const current = await client.query<{ id: string; tenant_id: string; location_id: string; status: StationStatus }>(
      `SELECT id,tenant_id,location_id,status FROM partner_stations WHERE station_code=$1 FOR UPDATE`,
      [cleanCode]
    );
    const row = current.rows[0];
    if (!row) throw new StationServiceError("station_not_found", "Station not found");
    if (row.status !== "PENDING") {
      throw new StationServiceError("validation", "Only a pending station can be rejected");
    }
    await client.query(
      `UPDATE partner_stations
          SET status='REJECTED', credential_epoch=credential_epoch+1,
              revoked_at=now(), revoked_by=$2, updated_at=now()
        WHERE id=$1`,
      [row.id, actorUserId]
    );
    await client.query(
      `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_rejected',$5::jsonb)`,
      [
        row.tenant_id,
        row.location_id,
        row.id,
        actorUserId,
        JSON.stringify({ reason: cleanReason, previousStatus: row.status, credentialEpochRotated: true }),
      ]
    );
  });
}

/** Cancel is the owner-supported remedy for a pending enrolment requested at
 * the wrong location.  It is terminal and fingerprint-bound on the Scanner,
 * so the old local credential is retired before another request can exist. */
export async function cancelPendingStation(
  stationCode: string,
  actorUserId: string | null,
  reason: string
): Promise<void> {
  const cleanCode = boundedText(stationCode, "stationCode", 40).toUpperCase();
  const cleanReason = boundedText(reason, "reason", 1000);
  await withPartnerAdminTransaction(async (client) => {
    const current = await client.query<{ id: string; tenant_id: string; location_id: string; status: StationStatus }>(
      `SELECT id,tenant_id,location_id,status FROM partner_stations WHERE station_code=$1 FOR UPDATE`,
      [cleanCode]
    );
    const row = current.rows[0];
    if (!row) throw new StationServiceError("station_not_found", "Station not found");
    if (row.status !== "PENDING" && row.status !== "CANCELLED") {
      throw new StationServiceError("validation", "Only a pending station can be cancelled");
    }
    if (row.status === "CANCELLED") return;
    await client.query(
      `UPDATE partner_stations
          SET status='CANCELLED',credential_epoch=credential_epoch+1,updated_at=now()
        WHERE id=$1 AND status='PENDING'`,
      [row.id]
    );
    await client.query(
      `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_cancelled',$5::jsonb)`,
      [
        row.tenant_id,
        row.location_id,
        row.id,
        actorUserId,
        JSON.stringify({ reason: cleanReason, previousStatus: row.status, credentialEpochRotated: true }),
      ]
    );
  });
}

/** A replacement is always a distinct pending credential.  Activation and
 * old-station revocation are one transaction; no queue, grant, calibration or
 * profile authority is inherited by the replacement. */
export async function activateReplacementStation(input: {
  stationCode: string;
  replacesStationCode: string;
  actorUserId: string | null;
  reason: string;
}): Promise<void> {
  const stationCode = boundedText(input.stationCode, "stationCode", 40).toUpperCase();
  const replacesStationCode = boundedText(input.replacesStationCode, "replacesStationCode", 40).toUpperCase();
  const reason = boundedText(input.reason, "reason", 1000);
  if (stationCode === replacesStationCode) throw new StationServiceError("validation", "A station cannot replace itself");
  await withPartnerAdminTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      station_code: string;
      tenant_id: string;
      location_id: string;
      status: StationStatus;
      replaces_station_id: string | null;
    }>(
      `SELECT id,station_code,tenant_id,location_id,status,replaces_station_id
         FROM partner_stations WHERE station_code=ANY($1::text[]) ORDER BY station_code FOR UPDATE`,
      [[stationCode, replacesStationCode]]
    );
    const replacement = selected.rows.find((row) => row.station_code === stationCode);
    const prior = selected.rows.find((row) => row.station_code === replacesStationCode);
    if (!replacement || !prior) throw new StationServiceError("station_not_found", "Replacement station not found");
    if (replacement.tenant_id !== prior.tenant_id || replacement.location_id !== prior.location_id) {
      throw new StationServiceError("validation", "Replacement stations must be in the same tenant and location");
    }
    if (replacement.status === "ACTIVE" && replacement.replaces_station_id === prior.id && prior.status === "REVOKED") return;
    if (replacement.status !== "PENDING") {
      throw new StationServiceError("validation", "The replacement must be a pending new station");
    }
    if (!["ACTIVE", "SUSPENDED", "REVOKED"].includes(prior.status)) {
      throw new StationServiceError("validation", "The replaced station must be an existing approved station");
    }
    await client.query(
      `UPDATE scanner_evidence_staging staging
          SET state='expired',failure_reason='station_replaced',updated_at=now()
         FROM scanner_capture_sessions capture
        WHERE staging.capture_session_id=capture.id AND capture.station_id=$1
          AND staging.state IN ('granted','finalizing')`,
      [prior.id]
    );
    await client.query(
      `UPDATE scanner_capture_sessions
          SET state='cancelled',failure_reason='station_replaced'
        WHERE station_id=$1 AND state IN ('armed','claimed','capturing')`,
      [prior.id]
    );
    if (prior.status !== "REVOKED") {
      await client.query(
        `UPDATE partner_stations
            SET status='REVOKED',credential_epoch=credential_epoch+1,request_epoch=request_epoch+1,
                last_request_sequence=0,revoked_at=now(),revoked_by=$2,updated_at=now()
          WHERE id=$1`,
        [prior.id, input.actorUserId]
      );
    }
    await client.query(
      `UPDATE partner_stations
          SET status='ACTIVE',replaces_station_id=$2,credential_epoch=credential_epoch+1,
              request_epoch=request_epoch+1,last_request_sequence=0,approved_at=now(),approved_by=$3,updated_at=now()
        WHERE id=$1 AND status='PENDING'`,
      [replacement.id, prior.id, input.actorUserId]
    );
    await client.query(
      `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_replaced',$5::jsonb),
              ($1,$2,$6,$4,'station_replacement_activated',$7::jsonb)`,
      [
        prior.tenant_id,
        prior.location_id,
        prior.id,
        input.actorUserId,
        JSON.stringify({ reason, replacementStationId: replacement.id, replacementStationCode: replacement.station_code }),
        replacement.id,
        JSON.stringify({ reason, replacesStationId: prior.id, replacesStationCode: prior.station_code }),
      ]
    );
  });
}

/** Move an existing station only inside its tenant and only from a freshly
 * observed, suspended, custody-clean state.  Historical captures, evidence,
 * jobs, events and profiles remain at their original location; the moved
 * station must establish a new immutable profile before scanning. */
export async function transferStationLocation(input: {
  stationCode: string;
  targetLocationId: string;
  actorUserId: string | null;
  reason: string;
}): Promise<void> {
  const stationCode = boundedText(input.stationCode, "stationCode", 40).toUpperCase();
  const targetLocationId = boundedText(input.targetLocationId, "targetLocationId", 64).toLowerCase();
  const reason = boundedText(input.reason, "reason", 1000);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(targetLocationId)) {
    throw new StationServiceError("validation", "targetLocationId is invalid");
  }
  await withPartnerAdminTransaction(async (client) => {
    const stationResult = await client.query<{
      id: string;
      tenant_id: string;
      location_id: string;
      status: StationStatus;
      pending_upload_count: number;
      capture_state: string;
      recently_seen: boolean;
    }>(
      `SELECT id,tenant_id,location_id,status,pending_upload_count,capture_state,
              (last_seen_at >= now() - interval '5 minutes') AS recently_seen
         FROM partner_stations WHERE station_code=$1 FOR UPDATE`,
      [stationCode]
    );
    const station = stationResult.rows[0];
    if (!station) throw new StationServiceError("station_not_found", "Station not found");
    if (station.location_id === targetLocationId && station.status === "ACTIVE") return;
    if (station.status !== "SUSPENDED") {
      throw new StationServiceError("validation", "Suspend the station before approving a location transfer");
    }
    const location = await client.query<{ id: string }>(
      `SELECT id FROM partner_locations WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE' FOR UPDATE`,
      [targetLocationId, station.tenant_id]
    );
    if (location.rows.length !== 1) {
      throw new StationServiceError("validation", "Target location must be active and in the same tenant");
    }
    if (!station.recently_seen || station.pending_upload_count !== 0 || station.capture_state !== "IDLE") {
      throw new StationServiceError("validation", "Station must be recently observed idle with no pending uploads");
    }
    const unresolved = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM scanner_capture_sessions capture
          LEFT JOIN scanner_evidence_staging staging ON staging.capture_session_id=capture.id
         WHERE capture.station_id=$1
           AND (capture.state IN ('armed','claimed','capturing') OR staging.state IN ('granted','finalizing'))
       ) AS exists`,
      [station.id]
    );
    if (unresolved.rows[0]?.exists) {
      throw new StationServiceError("validation", "Station has unresolved capture or evidence state");
    }
    await client.query(
      `UPDATE partner_stations
          SET location_id=$2,status='ACTIVE',credential_epoch=credential_epoch+1,
              request_epoch=request_epoch+1,last_request_nonce=0,last_request_sequence=0,
              current_calibration_id=NULL,current_profile_revision_id=NULL,
              calibration_status='UNPROVISIONED',scanner_profile_version=NULL,
              approved_at=now(),approved_by=$3,updated_at=now()
        WHERE id=$1 AND status='SUSPENDED'`,
      [station.id, targetLocationId, input.actorUserId]
    );
    await client.query(
      `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_location_transferred_from',$5::jsonb),
              ($1,$6,$3,$4,'station_location_transferred_to',$7::jsonb)`,
      [
        station.tenant_id,
        station.location_id,
        station.id,
        input.actorUserId,
        JSON.stringify({ reason, targetLocationId }),
        targetLocationId,
        JSON.stringify({ reason, previousLocationId: station.location_id, profileReset: true }),
      ]
    );
  });
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) === JSON.stringify([...keys].sort())
  );
}

function scannerVersionTuple(value: unknown): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

function scannerVersionDirection(left: string, right: string): number {
  const a = scannerVersionTuple(left);
  const b = scannerVersionTuple(right);
  if (!a || !b) throw new StationServiceError("validation", "Scanner update policy version is invalid");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validateScannerUpdatePolicy(value: unknown, currentVersion: string): Record<string, unknown> {
  const keys = [
    "schemaVersion", "authority", "policyId", "operation", "targetVersion", "minimumSupportedVersion",
    "teamIdentifier", "sourceCommit", "issuedAt", "expiresAt", "reason", "artifacts",
  ];
  if (!exactKeys(value, keys)) throw new StationServiceError("validation", "Scanner update policy fields are not exact");
  const policy = value as Record<string, any>;
  if (policy.schemaVersion !== 1 || policy.authority !== "MINTVAULT_STATION_POLICY"
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{7,127}$/.test(String(policy.policyId || ""))
      || !new Set(["UPDATE", "ROLLBACK"]).has(policy.operation)
      || !scannerVersionTuple(policy.targetVersion) || !scannerVersionTuple(policy.minimumSupportedVersion)
      || !/^[A-Z0-9]{10}$/.test(String(policy.teamIdentifier || ""))
      || !/^[a-f0-9]{40}$/.test(String(policy.sourceCommit || ""))
      || typeof policy.reason !== "string" || policy.reason.trim().length < 3 || policy.reason.length > 240) {
    throw new StationServiceError("validation", "Scanner update policy authority is invalid");
  }
  const direction = scannerVersionDirection(policy.targetVersion, currentVersion);
  if ((policy.operation === "UPDATE" && direction <= 0) || (policy.operation === "ROLLBACK" && direction >= 0)
      || scannerVersionDirection(policy.targetVersion, policy.minimumSupportedVersion) < 0) {
    throw new StationServiceError("validation", "Scanner update policy direction is invalid");
  }
  const issuedAt = Date.parse(policy.issuedAt);
  const expiresAt = Date.parse(policy.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt
      || expiresAt - issuedAt > 24 * 60 * 60 * 1000 || now < issuedAt - 5 * 60 * 1000 || now >= expiresAt) {
    throw new StationServiceError("validation", "Scanner update policy lifetime is invalid or expired");
  }
  if (!exactKeys(policy.artifacts, ["zip", "dmg", "latest"])) {
    throw new StationServiceError("validation", "Scanner update policy artifacts are not exact");
  }
  const prefix = `MintVault-Scanner-${policy.targetVersion}-arm64`;
  for (const [kind, filename, maximum, needsSha512] of [
    ["zip", `${prefix}.zip`, 1024 ** 3, true],
    ["dmg", `${prefix}.dmg`, 1024 ** 3, false],
    ["latest", "latest-mac.yml", 1024 ** 2, false],
  ] as const) {
    const artifact = policy.artifacts[kind];
    const artifactKeys = needsSha512 ? ["filename", "size", "sha256", "sha512"] : ["filename", "size", "sha256"];
    if (!exactKeys(artifact, artifactKeys) || artifact.filename !== filename
        || typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size)
        || artifact.size <= 0 || artifact.size > maximum
        || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))
        || (needsSha512 && !/^[A-Za-z0-9+/]{86}==$/.test(String(artifact.sha512 || "")))) {
      throw new StationServiceError("validation", `Scanner ${kind} policy artifact is invalid`);
    }
  }
  return JSON.parse(JSON.stringify({ ...policy, reason: policy.reason.trim() }));
}

/** Super Admin issuance is the authenticated MintVault authority. Static feed
 * metadata remains evidence only and cannot select UPDATE versus ROLLBACK. */
export async function setStationUpdatePolicy(input: {
  stationCode: string;
  policy: unknown;
  actorUserId: string | null;
  reason: string;
}): Promise<void> {
  const stationCode = boundedText(input.stationCode, "stationCode", 40).toUpperCase();
  const reason = boundedText(input.reason, "reason", 240);
  await withPartnerAdminTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      tenant_id: string;
      location_id: string;
      app_version: string | null;
    }>(
      `SELECT id,tenant_id,location_id,app_version FROM partner_stations
        WHERE station_code=$1 FOR UPDATE`,
      [stationCode]
    );
    const station = selected.rows[0];
    if (!station) throw new StationServiceError("station_not_found", "Station not found");
    if (!station.app_version || !scannerVersionTuple(station.app_version)) {
      throw new StationServiceError("validation", "Station has not attested a valid current Scanner version");
    }
    const policy = validateScannerUpdatePolicy(input.policy, station.app_version);
    await client.query(
      `UPDATE partner_stations
          SET scanner_update_policy=$2::jsonb,minimum_supported_version=$3,updated_at=now()
        WHERE id=$1`,
      [station.id, JSON.stringify(policy), policy.minimumSupportedVersion]
    );
    await client.query(
      `INSERT INTO partner_station_events
         (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_update_policy_issued',$5::jsonb)`,
      [
        station.tenant_id,
        station.location_id,
        station.id,
        input.actorUserId,
        JSON.stringify({
          reason,
          policyId: policy.policyId,
          operation: policy.operation,
          targetVersion: policy.targetVersion,
          minimumSupportedVersion: policy.minimumSupportedVersion,
          sourceCommit: policy.sourceCommit,
          expiresAt: policy.expiresAt,
        }),
      ]
    );
  });
}

export async function listFleetStations(input: {
  page?: unknown;
  pageSize?: unknown;
  status?: unknown;
  query?: unknown;
  tenantId?: unknown;
}) {
  const page = Math.max(1, Math.min(10_000, Number.isInteger(input.page) ? Number(input.page) : 1));
  const pageSize = Math.max(1, Math.min(100, Number.isInteger(input.pageSize) ? Number(input.pageSize) : 25));
  const status =
    typeof input.status === "string" && ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED", "REJECTED", "CANCELLED", "EXPIRED"].includes(input.status)
      ? input.status
      : null;
  const query = typeof input.query === "string" && input.query.trim() ? input.query.trim().slice(0, 100) : null;
  const tenantId = typeof input.tenantId === "string" && input.tenantId.trim() ? input.tenantId.trim() : null;
  const where = [
    "($1::text IS NULL OR s.status=$1)",
    "($2::text IS NULL OR s.tenant_id::text=$2)",
    "($3::text IS NULL OR s.station_code ILIKE '%' || $3 || '%' OR o.legal_name ILIKE '%' || $3 || '%' OR l.name ILIKE '%' || $3 || '%')",
  ].join(" AND ");
  const values = [status, tenantId, query, pageSize, (page - 1) * pageSize];
  const [rows, total] = await Promise.all([
    partnerAdminQuery<{
      stationCode: string;
      status: StationStatus;
      tenantId: string;
      partnerName: string;
      locationId: string;
      locationName: string;
      appVersion: string | null;
      scannerConnected: boolean;
      calibrationStatus: CalibrationStatus;
      pendingUploadCount: number;
      captureState: string;
      lastSeenAt: string | null;
      lastFailureCode: string | null;
    }>(
      `SELECT s.station_code AS "stationCode", s.status, s.tenant_id AS "tenantId", o.legal_name AS "partnerName",
              s.location_id AS "locationId", l.name AS "locationName", s.app_version AS "appVersion",
              s.scanner_connected AS "scannerConnected", s.calibration_status AS "calibrationStatus",
              s.pending_upload_count AS "pendingUploadCount", s.capture_state AS "captureState",
              s.last_seen_at AS "lastSeenAt", s.last_failure_code AS "lastFailureCode"
         FROM partner_stations s
         JOIN partner_organisations o ON o.id=s.tenant_id
         JOIN partner_locations l ON l.id=s.location_id
        WHERE ${where}
        ORDER BY s.last_seen_at DESC NULLS LAST, s.station_code ASC
        LIMIT $4 OFFSET $5`,
      values
    ),
    partnerAdminQuery<{ total: string }>(
      `SELECT count(*)::text AS total FROM partner_stations s
         JOIN partner_organisations o ON o.id=s.tenant_id
         JOIN partner_locations l ON l.id=s.location_id
        WHERE ${where}`,
      values.slice(0, 3)
    ),
  ]);
  return { stations: rows.rows, total: Number(total.rows[0]?.total ?? 0), page, pageSize };
}
