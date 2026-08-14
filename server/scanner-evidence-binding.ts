import type { ScannerCaptureSession } from "./scanner-capture-service";

export type ScannerEvidenceBinding = {
  capture_session_id: string;
  capture_authorisation_id: string;
  semantic_operation_id: string;
  card_job_id: string;
  certificate_number: string;
  side: "front" | "back";
  revision: number;
  profile_revision_id: string;
  tenant_id: string;
  location_id: string;
  station_id: string;
  workstation_id: string;
  original_operator_id: string;
  original_operator_role: string;
  purpose: string;
  authorisation_issued_at: string;
  authorisation_expires_at: string;
  device_captured_at: string;
  device_timestamp_authority: "NON_AUTHORITATIVE";
  sha256: string;
  byte_length: number;
  mime_type: "image/tiff";
  app_version: string;
  capture_helper_version: string;
  identity_helper_version: string;
};

function requiredText(value: unknown, label: string, max = 255): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Evidence ${label} is invalid`);
  }
  return value;
}

function iso(value: Date | null, label: string): string {
  if (!value || !Number.isFinite(value.getTime())) throw new Error(`Capture ${label} is unavailable`);
  return value.toISOString();
}

export function validateScannerEvidenceBinding(
  session: ScannerCaptureSession,
  raw: unknown
): ScannerEvidenceBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Evidence binding is required");
  const body = raw as Record<string, unknown>;
  if (
    !session.captureAuthorisationId ||
    !session.semanticOperationId ||
    !session.cardJobId ||
    !session.profileRevisionId ||
    !session.tenantId ||
    !session.locationId ||
    !session.stationId ||
    !session.originalOperatorId ||
    !session.originalOperatorRole ||
    !session.capturePurpose ||
    !session.revision
  ) {
    throw new Error("Capture session lacks immutable Scanner authority");
  }
  const expected: Record<string, unknown> = {
    capture_session_id: session.id,
    capture_authorisation_id: session.captureAuthorisationId,
    semantic_operation_id: session.semanticOperationId,
    card_job_id: session.cardJobId,
    certificate_number: session.certificateNumber,
    side: session.side,
    revision: session.revision,
    profile_revision_id: session.profileRevisionId,
    tenant_id: session.tenantId,
    location_id: session.locationId,
    station_id: session.stationId,
    workstation_id: session.workstationId,
    original_operator_id: session.originalOperatorId,
    original_operator_role: session.originalOperatorRole,
    purpose: session.capturePurpose,
    authorisation_issued_at: iso(session.authorisationIssuedAt, "issued-at timestamp"),
    authorisation_expires_at: iso(session.authorisationExpiresAt, "expiry timestamp"),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) throw new Error(`Evidence binding does not match capture ${key}`);
  }
  if (Date.now() >= session.authorisationExpiresAt!.getTime()) throw new Error("Capture authorisation expired");
  const sha256 = requiredText(body.sha256, "sha256", 64).toLowerCase();
  const byteLength = Number(body.byte_length);
  const deviceCapturedAt = requiredText(body.device_captured_at, "device capture timestamp", 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Evidence sha256 is invalid");
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 512 * 1024 * 1024) {
    throw new Error("Evidence byte length is invalid");
  }
  if (!Number.isFinite(Date.parse(deviceCapturedAt))) throw new Error("Evidence device capture timestamp is invalid");
  if (body.device_timestamp_authority !== "NON_AUTHORITATIVE" || body.mime_type !== "image/tiff") {
    throw new Error("Evidence timestamp authority or MIME type is invalid");
  }
  return {
    ...(expected as Omit<ScannerEvidenceBinding,
      | "device_captured_at"
      | "device_timestamp_authority"
      | "sha256"
      | "byte_length"
      | "mime_type"
      | "app_version"
      | "capture_helper_version"
      | "identity_helper_version">),
    device_captured_at: deviceCapturedAt,
    device_timestamp_authority: "NON_AUTHORITATIVE",
    sha256,
    byte_length: byteLength,
    mime_type: "image/tiff",
    app_version: requiredText(body.app_version, "app version", 64),
    capture_helper_version: requiredText(body.capture_helper_version, "capture helper version", 64),
    identity_helper_version: requiredText(body.identity_helper_version, "identity helper version", 64),
  };
}
