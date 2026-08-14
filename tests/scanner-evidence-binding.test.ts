import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScannerCaptureSession } from "../server/scanner-capture-service";
import { validateScannerEvidenceBinding } from "../server/scanner-evidence-binding";

function fixture() {
  const issued = new Date(Date.now() - 1_000);
  const expires = new Date(Date.now() + 60_000);
  const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
  const session: ScannerCaptureSession = {
    id: "capture-binding-proof",
    certificateId: 123,
    certificateNumber: "MV123",
    cardId: null,
    submissionItemId: null,
    submissionId: null,
    stationId: ids[0],
    actorId: ids[1],
    side: "front",
    workstationId: "MV-STN-BINDINGPROOF",
    scannerProfileVersion: "mintvault-canon-lide-400-v3",
    state: "claimed",
    expiresAt: expires,
    recapture: false,
    failureReason: null,
    captureAuthorisationId: ids[2],
    semanticOperationId: ids[3],
    cardJobId: ids[4],
    profileRevisionId: ids[5],
    profileDigestSha256: "a".repeat(64),
    tenantId: ids[6],
    locationId: ids[7],
    originalOperatorId: ids[1],
    originalOperatorRole: "SCANNER_OPERATOR",
    capturePurpose: "AUTHORITATIVE_CARD_CAPTURE",
    revision: 1,
    authorisationIssuedAt: issued,
    authorisationExpiresAt: expires,
    cancelEligible: true,
  };
  const binding = {
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
    authorisation_issued_at: issued.toISOString(),
    authorisation_expires_at: expires.toISOString(),
    device_captured_at: new Date().toISOString(),
    device_timestamp_authority: "NON_AUTHORITATIVE",
    sha256: "b".repeat(64),
    byte_length: 4096,
    mime_type: "image/tiff",
    app_version: "1.0.0",
    capture_helper_version: "1.0.1",
    identity_helper_version: "1.0.1",
  };
  return { session, binding };
}

describe("Scanner evidence immutable binding", () => {
  it("accepts and canonicalises the one exact authority tuple", () => {
    const { session, binding } = fixture();
    expect(validateScannerEvidenceBinding(session, binding)).toEqual(binding);
  });

  it.each([
    ["capture_authorisation_id", crypto.randomUUID()],
    ["semantic_operation_id", crypto.randomUUID()],
    ["card_job_id", crypto.randomUUID()],
    ["side", "back"],
    ["revision", 2],
    ["profile_revision_id", crypto.randomUUID()],
    ["tenant_id", crypto.randomUUID()],
    ["location_id", crypto.randomUUID()],
    ["station_id", crypto.randomUUID()],
    ["original_operator_id", crypto.randomUUID()],
    ["original_operator_role", "PARTNER_OWNER"],
    ["purpose", "SETUP_PREVIEW"],
  ])("rejects changed immutable field %s", (field, value) => {
    const { session, binding } = fixture();
    expect(() => validateScannerEvidenceBinding(session, { ...binding, [field]: value })).toThrow(/does not match/);
  });

  it("rejects expired authority, authoritative device time, and digest/size drift", () => {
    const expired = fixture();
    expired.session.authorisationExpiresAt = new Date(Date.now() - 1);
    expired.binding.authorisation_expires_at = expired.session.authorisationExpiresAt.toISOString();
    expect(() => validateScannerEvidenceBinding(expired.session, expired.binding)).toThrow(/expired/);
    const timestamp = fixture();
    expect(() => validateScannerEvidenceBinding(timestamp.session, {
      ...timestamp.binding,
      device_timestamp_authority: "AUTHORITATIVE",
    })).toThrow(/timestamp authority/);
    const digest = fixture();
    expect(() => validateScannerEvidenceBinding(digest.session, { ...digest.binding, sha256: "not-a-digest" }))
      .toThrow(/sha256/);
    expect(() => validateScannerEvidenceBinding(digest.session, { ...digest.binding, byte_length: 0 }))
      .toThrow(/byte length/);
  });
});
