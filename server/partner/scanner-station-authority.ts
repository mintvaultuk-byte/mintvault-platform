import crypto from "node:crypto";
import { withPartnerAdminTransaction } from "./db";
import type { StationPrincipal } from "./station-service";

export class ScannerStationAuthorityError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_CONFLICT" | "SEMANTIC_OPERATION_REQUIRED" | "PROFILE_INVALID",
    message: string
  ) {
    super(message);
  }
}

export function canonicalScannerJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalScannerJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalScannerJson(object[key])}`)
    .join(",")}}`;
}

export function scannerRequestFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalScannerJson(value)).digest("hex");
}

type SemanticRow = {
  station_id: string;
  tenant_id: string;
  location_id: string;
  state: "PENDING" | "COMPLETED" | "REFUSED";
  operation_type: string;
  endpoint: string;
  actor_user_id: string;
  request_fingerprint: string;
  http_status: number | null;
  result: unknown;
};

export type SemanticResult = { status: number; body: unknown; replayed: boolean };

function semanticId(station: StationPrincipal): string {
  if (station.protocol !== 2 || !station.semanticOperationId) {
    throw new ScannerStationAuthorityError(
      "SEMANTIC_OPERATION_REQUIRED",
      "This station mutation requires protocol v2 and a semantic operation ID"
    );
  }
  return station.semanticOperationId;
}

export async function beginStationSemanticOperation(input: {
  station: StationPrincipal;
  actorUserId: string;
  operationType: string;
  endpoint: string;
  payload: unknown;
}): Promise<SemanticResult | null> {
  const operationId = semanticId(input.station);
  const fingerprint = scannerRequestFingerprint(input.payload);
  return withPartnerAdminTransaction(async (client) => {
    await client.query(
      `INSERT INTO scanner_station_semantic_operations
         (station_id,tenant_id,location_id,semantic_operation_id,operation_type,endpoint,actor_user_id,request_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (semantic_operation_id) DO NOTHING`,
      [
        input.station.id,
        input.station.tenantId,
        input.station.locationId,
        operationId,
        input.operationType,
        input.endpoint,
        input.actorUserId,
        fingerprint,
      ]
    );
    const found = await client.query<SemanticRow>(
      `SELECT station_id,tenant_id,location_id,state,operation_type,endpoint,actor_user_id,
              request_fingerprint,http_status,result
         FROM scanner_station_semantic_operations
        WHERE semantic_operation_id=$1
        FOR UPDATE`,
      [operationId]
    );
    const row = found.rows[0];
    if (
      !row ||
      row.station_id !== input.station.id ||
      row.tenant_id !== input.station.tenantId ||
      row.location_id !== input.station.locationId ||
      row.operation_type !== input.operationType ||
      row.endpoint !== input.endpoint ||
      row.actor_user_id !== input.actorUserId ||
      row.request_fingerprint !== fingerprint
    ) {
      throw new ScannerStationAuthorityError(
        "IDEMPOTENCY_CONFLICT",
        "The semantic operation ID is already bound to a different station mutation"
      );
    }
    if (row.state !== "PENDING") {
      return { status: Number(row.http_status), body: row.result, replayed: true };
    }
    return null;
  });
}

export async function completeStationSemanticOperation(input: {
  station: StationPrincipal;
  status: number;
  body: unknown;
  refused?: boolean;
}): Promise<SemanticResult> {
  const operationId = semanticId(input.station);
  return withPartnerAdminTransaction(async (client) => {
    const updated = await client.query<{ http_status: number; result: unknown }>(
      `UPDATE scanner_station_semantic_operations
          SET state=$3,http_status=$4,result=$5::jsonb,completed_at=now()
        WHERE station_id=$1 AND semantic_operation_id=$2 AND state='PENDING'
        RETURNING http_status,result`,
      [
        input.station.id,
        operationId,
        input.refused ? "REFUSED" : "COMPLETED",
        input.status,
        canonicalScannerJson(input.body),
      ]
    );
    if (updated.rowCount === 1) {
      return { status: input.status, body: input.body, replayed: false };
    }
    const found = await client.query<{ http_status: number; result: unknown }>(
      `SELECT http_status,result FROM scanner_station_semantic_operations
        WHERE station_id=$1 AND semantic_operation_id=$2 AND state<>'PENDING'`,
      [input.station.id, operationId]
    );
    if (!found.rows[0]) throw new Error("Semantic operation completion was lost");
    return { status: found.rows[0].http_status, body: found.rows[0].result, replayed: true };
  });
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScannerStationAuthorityError("PROFILE_INVALID", "Scanner profile candidate is invalid");
  }
  return value as Record<string, unknown>;
}

function validCapabilityProof(profile: Record<string, unknown>): boolean {
  try {
    const proof = requiredObject(profile.capabilityProof);
    const region = requiredObject(proof.acquisitionRegion);
    const frame = requiredObject(proof.frameAssessment);
    const margins = requiredObject(frame.evidenceMarginMm);
    const widthMm = Number(region.width);
    const heightMm = Number(region.height);
    const expectedWidth = Math.round((widthMm / 25.4) * 1200);
    const expectedHeight = Math.round((heightMm / 25.4) * 1200);
    return (
      /^[a-f0-9]{64}$/.test(String(proof.sha256 || "")) &&
      Number.isSafeInteger(proof.sizeBytes) && Number(proof.sizeBytes) >= 64 * 1024 &&
      Number(proof.sizeBytes) <= 512 * 1024 * 1024 &&
      proof.format === "TIFF" && proof.requestedDpi === 1200 && proof.driverResolutionDpi === 1200 &&
      proof.colourMode === "RGB" && proof.bitDepth === 8 &&
      Number.isFinite(widthMm) && Number.isFinite(heightMm) &&
      Number.isSafeInteger(proof.widthPx) && Math.abs(Number(proof.widthPx) - expectedWidth) <= 2 &&
      Number.isSafeInteger(proof.heightPx) && Math.abs(Number(proof.heightPx) - expectedHeight) <= 2 &&
      frame.accepted === true &&
      ["left", "right", "top", "bottom"].every((key) => Number(margins[key]) >= 4) &&
      proof.captureHelperVersion === profile.captureHelperVersion
    );
  } catch {
    return false;
  }
}

/** Persist one immutable, server-digested profile revision. */
export async function acceptStationProfileRevision(input: {
  station: StationPrincipal;
  actorUserId: string;
  payload: unknown;
}): Promise<Record<string, unknown>> {
  const payload = requiredObject(input.payload);
  const profile = requiredObject(payload.profile);
  const operationId = semanticId(input.station);
  const candidateDigest = String(payload.candidateDigestSha256 || "").toLowerCase();
  if (
    String(payload.semanticOperationId || "").toLowerCase() !== operationId ||
    String(payload.clientOpId || "").toLowerCase() !== operationId ||
    String(profile.semanticOperationId || "").toLowerCase() !== operationId ||
    String(profile.stationCode || "").toUpperCase() !== input.station.code ||
    !/^[a-f0-9]{64}$/.test(candidateDigest) ||
    scannerRequestFingerprint(profile) !== candidateDigest ||
    profile.requestedDpi !== 1200 ||
    profile.colourMode !== "RGB" ||
    profile.bitDepth !== 8 ||
    profile.outputFormat !== "TIFF" ||
    profile.presentationRotationDegrees !== 180 ||
    profile.deviceTimestampAuthority !== "NON_AUTHORITATIVE" ||
    !validCapabilityProof(profile)
  ) {
    throw new ScannerStationAuthorityError("PROFILE_INVALID", "Scanner profile binding is invalid");
  }
  return withPartnerAdminTransaction(async (client) => {
    const existing = await client.query<{ id: string; candidate_digest_sha256: string; profile_digest_sha256: string; profile: Record<string, unknown> }>(
      `SELECT id,candidate_digest_sha256,profile_digest_sha256,profile
         FROM partner_station_profile_revisions
        WHERE station_id=$1 AND semantic_operation_id=$2`,
      [input.station.id, operationId]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].candidate_digest_sha256 !== candidateDigest) {
        throw new ScannerStationAuthorityError("IDEMPOTENCY_CONFLICT", "Profile operation payload changed");
      }
      return {
        id: existing.rows[0].id,
        profileRevisionId: existing.rows[0].id,
        semanticOperationId: operationId,
        candidateDigestSha256: candidateDigest,
        profileDigestSha256: existing.rows[0].profile_digest_sha256,
        profile: existing.rows[0].profile,
        calibrationStatus: "VALID",
      };
    }
    const revisionId = crypto.randomUUID();
    const acceptedProfile = { schemaVersion: 1, ...profile, profileRevisionId: revisionId };
    const profileDigest = scannerRequestFingerprint(acceptedProfile);
    await client.query(
      `INSERT INTO partner_station_profile_revisions
         (id,station_id,tenant_id,location_id,semantic_operation_id,candidate_digest_sha256,
          profile_digest_sha256,profile,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        revisionId,
        input.station.id,
        input.station.tenantId,
        input.station.locationId,
        operationId,
        candidateDigest,
        profileDigest,
        canonicalScannerJson(acceptedProfile),
        input.actorUserId,
      ]
    );
    const advanced = await client.query(
      `UPDATE partner_stations SET current_profile_revision_id=$2,updated_at=now()
        WHERE id=$1 AND tenant_id=$3 AND location_id=$4 AND status='ACTIVE'`,
      [input.station.id, revisionId, input.station.tenantId, input.station.locationId]
    );
    if (advanced.rowCount !== 1) {
      throw new ScannerStationAuthorityError("PROFILE_INVALID", "Station profile authority changed during acceptance");
    }
    return {
      id: revisionId,
      profileRevisionId: revisionId,
      semanticOperationId: operationId,
      candidateDigestSha256: candidateDigest,
      profileDigestSha256: profileDigest,
      profile: acceptedProfile,
      calibrationStatus: "VALID",
    };
  });
}
