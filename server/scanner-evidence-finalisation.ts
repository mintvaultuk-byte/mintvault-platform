import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import type { ScannerCaptureSession } from "./scanner-capture-service";

type TrustedCapturePrincipal = {
  stationId: string | null;
  tenantId: string | null;
  locationId: string | null;
  actorId: string | null;
};

export type FinalisedScannerEvidence = {
  inspection: Awaited<ReturnType<typeof import("./lib/image-evidence").inspectScannerEvidence>>;
  provenance: Awaited<ReturnType<typeof import("./lib/lide400-profile").parseLide400CaptureProvenance>>;
  frameAssessment: Awaited<ReturnType<typeof import("./lib/lide400-card-frame").assessLide400CardFrame>>;
};

/**
 * The sole promotion boundary from untrusted bytes (multipart compatibility
 * body or an R2 staging object) into immutable scanner evidence.  It derives
 * every target/provenance relationship from the armed server session and the
 * authenticated station/operator, never from the TIFF transport.
 */
export async function finaliseScannerEvidence(input: {
  session: ScannerCaptureSession;
  buffer: Buffer;
  mimeType: string;
  provenanceInput: unknown;
  trusted: TrustedCapturePrincipal;
}): Promise<FinalisedScannerEvidence> {
  const { inspectScannerEvidence, uploadRawScannerSide, markRawUploaded, setScanStatus } =
    await import("./scan-ingest-service");
  const { parseLide400CaptureProvenance, assertLide400Evidence } = await import("./lib/lide400-profile");
  const { assessLide400CardFrame } = await import("./lib/lide400-card-frame");

  const inspection = await inspectScannerEvidence(input.buffer);
  const provenance = parseLide400CaptureProvenance(input.provenanceInput);
  assertLide400Evidence(inspection, provenance);
  const frameAssessment = await assessLide400CardFrame(input.buffer, inspection, provenance.scanAreaMm);
  if (!frameAssessment.accepted) {
    throw new Error(frameAssessment.reason || "Card-boundary safety check rejected this acquired TIFF");
  }
  if (
    provenance.profileVersion !== input.session.scannerProfileVersion ||
    provenance.workstationId !== input.session.workstationId
  ) {
    throw new Error("Capture provenance does not match the armed workstation/profile");
  }
  if (input.trusted.stationId && input.session.stationId !== input.trusted.stationId) {
    throw new Error("Capture session is not bound to this authenticated station");
  }
  // Fail before writing an immutable back master. This preserves a previously
  // accepted front if back capture/validation/retry fails.
  if (input.session.side === "back") {
    const front = await db.execute(sql`
      SELECT 1 FROM certificate_image_evidence
      WHERE certificate_id = ${input.session.certificateId} AND side = 'front' AND is_current = true
      LIMIT 1`);
    if (!front.rows.length) throw new Error("Back capture refused until an immutable front master exists");
  }
  await uploadRawScannerSide(
    input.session.certificateId,
    input.session.side,
    { buffer: input.buffer, mimeType: input.mimeType, ext: "tif", inspection },
    {
      allowRecapture: input.session.recapture,
      captureMetadata: {
        captureSessionId: input.session.id,
        cardId: input.session.cardId,
        submissionItemId: input.session.submissionItemId,
        submissionId: input.session.submissionId,
        cardFrameAssessment: frameAssessment,
        ...provenance,
        stationId: input.trusted.stationId ?? input.session.stationId,
        tenantId: input.trusted.tenantId,
        locationId: input.trusted.locationId,
        actorId: input.trusted.actorId ?? input.session.actorId,
      },
    }
  );
  await markRawUploaded(input.session.certificateId);
  await setScanStatus(input.session.certificateId, "processing");
  return { inspection, provenance, frameAssessment };
}

export async function recordAcceptedScannerEvidence(input: {
  session: ScannerCaptureSession;
  evidence: FinalisedScannerEvidence;
  trusted: TrustedCapturePrincipal;
}): Promise<void> {
  await storage.writeAuditLog(
    "certificate",
    String(input.session.certificateId),
    "scanner_capture_accepted",
    "scanner",
    {
      capture_session_id: input.session.id,
      side: input.session.side,
      card_id: input.session.cardId,
      submission_item_id: input.session.submissionItemId,
      submission_id: input.session.submissionId,
      workstation_id: input.session.workstationId,
      station_id: input.trusted.stationId ?? input.session.stationId,
      tenant_id: input.trusted.tenantId,
      location_id: input.trusted.locationId,
      actor_id: input.trusted.actorId ?? input.session.actorId,
      scanner_device_id: input.evidence.provenance.scannerDeviceId,
      scanner_model: input.evidence.provenance.scannerModel,
      scanner_profile_version: input.evidence.provenance.profileVersion,
      sha256: input.evidence.inspection.sha256,
      recapture: input.session.recapture,
    }
  );
}
