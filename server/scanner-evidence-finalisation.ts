import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import type { ScannerCaptureSession } from "./scanner-capture-service";
import { authoritativeRegionForSession, assertDeclaredRegionMatchesAuthority } from "./lib/lide400-capture-authority";

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

function parseCaptureMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function textMetadata(metadata: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function loadAcceptedScannerEvidence(session: ScannerCaptureSession): Promise<FinalisedScannerEvidence> {
  const found = await db.execute(sql`
    SELECT sha256, byte_length, pixel_width, pixel_height, bit_depth, dpi, format, capture_metadata
      FROM certificate_image_evidence
     WHERE certificate_id = ${session.certificateId}
       AND side = ${session.side}
       AND is_current = true
       AND capture_metadata ->> 'captureSessionId' = ${session.id}
     LIMIT 1`);
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("Accepted scanner evidence is not available for reconciliation");
  const metadata = parseCaptureMetadata(row.capture_metadata);
  return {
    inspection: {
      sha256: String(row.sha256),
      byteLength: Number(row.byte_length),
      width: Number(row.pixel_width),
      height: Number(row.pixel_height),
      bitDepth: row.bit_depth == null ? null : Number(row.bit_depth),
      dpi: row.dpi == null ? null : Number(row.dpi),
      format: String(row.format),
    } as FinalisedScannerEvidence["inspection"],
    provenance: {
      scannerDeviceId: textMetadata(metadata, "scannerDeviceId", "scanner_device_id") ?? "",
      scannerModel: textMetadata(metadata, "scannerModel", "scanner_model") ?? "",
      profileVersion:
        textMetadata(metadata, "profileVersion", "scanner_profile_version") ?? session.scannerProfileVersion,
      workstationId: textMetadata(metadata, "workstationId") ?? session.workstationId,
      scanAreaMm: metadata.declaredScanAreaMm ?? metadata.scanAreaMm ?? null,
    } as FinalisedScannerEvidence["provenance"],
    frameAssessment: (metadata.cardFrameAssessment ?? null) as FinalisedScannerEvidence["frameAssessment"],
  };
}

async function scannerAcceptanceAuditExists(session: ScannerCaptureSession): Promise<boolean> {
  const found = await db.execute(sql`
    SELECT 1
      FROM audit_log
     WHERE entity_type = 'certificate'
       AND entity_id = ${String(session.certificateId)}
       AND action = 'scanner_capture_accepted'
       AND details ->> 'capture_session_id' = ${session.id}
     LIMIT 1`);
  return found.rows.length > 0;
}

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

  // FRONT-before-BACK, checked FIRST. This is one indexed SELECT, whereas the
  // checks below decode a TIFF of up to 128 MiB and run card-boundary analysis
  // on it. Refusing a BACK-first capture before that work is done costs nothing
  // and avoids doing the most expensive work in the function only to discard it.
  //
  // It also fails before writing an immutable back master, which preserves a
  // previously accepted front if back capture/validation/retry fails (§33).
  if (input.session.side === "back") {
    const front = await db.execute(sql`
      SELECT 1 FROM certificate_image_evidence
      WHERE certificate_id = ${input.session.certificateId} AND side = 'front' AND is_current = true
      LIMIT 1`);
    if (!front.rows.length) throw new Error("Back capture refused until an immutable front master exists");
  }

  const inspection = await inspectScannerEvidence(input.buffer);
  const provenance = parseLide400CaptureProvenance(input.provenanceInput);
  assertLide400Evidence(inspection, provenance);

  /*
   * THE ACQUISITION RECTANGLE COMES FROM THE SERVER, NOT FROM THE UPLOAD.
   *
   * `provenance.scanAreaMm` is a STATION-supplied number. It was safe to scale millimetres by while
   * every station used the same hard-coded window — the size was pinned against a server constant
   * and the margin verdict depends on size alone — but the window is now movable per station, so a
   * declared ORIGIN is an unverified claim about where on the platen this scan happened.
   *
   * The authority is the region snapshotted onto this session when the side was ARMED, taken from
   * the station's current VALID calibration. The upload's own declaration is then required merely to
   * AGREE with it; disagreement means a stale local config, a hand-edited station file or a forged
   * payload, and all three are refusals.
   */
  const authoritativeRegion = authoritativeRegionForSession(input.session);
  assertDeclaredRegionMatchesAuthority(provenance.scanAreaMm, authoritativeRegion);
  /*
   * RE-CHECKED AT COMMIT, not only at arm. At arm the other side may be armed and not yet uploaded,
   * so there is nothing to compare against and the check passes silently — which lets two stations
   * calibrated differently hold the two sides of one card, each upload agreeing with its own
   * snapshot. By now the first side's evidence exists.
   */
  const { assertCommittedSidesShareOneRectangle } = await import("./scanner-capture-service");
  await assertCommittedSidesShareOneRectangle(input.session.certificateId, input.session.side, authoritativeRegion);
  const frameAssessment = await assessLide400CardFrame(input.buffer, inspection, authoritativeRegion);
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
        /*
         * THE SERVER'S RECTANGLE, WRITTEN LAST so it wins over the client's declaration in the
         * spread above. `scanAreaMm` from provenance is a STATION-supplied number permitted to
         * differ by up to 0.5 mm; storing it made it the "proven geometry" that the cross-side
         * pairing check reads back, so the two tolerances composed to 1.0 mm. The declared value is
         * kept alongside for forensics rather than discarded.
         */
        declaredScanAreaMm: provenance.scanAreaMm,
        scanAreaMm: authoritativeRegion,
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
  if (!(await scannerAcceptanceAuditExists(input.session))) {
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

  /*
   * ADVANCE THE PARTNER CARD JOB — the bridge from capture to grading.
   *
   * This is the ONE convergence point for accepted scanner evidence: both the multipart compatibility
   * body and the R2 staging path arrive here, so the lifecycle is driven once rather than at each
   * transport. Until this call existed nothing in the repository moved
   * `partner_card_jobs.status`, so a Scanner card that had been fully captured on both sides stayed
   * in NEEDS_SCAN and could never be opened for grading.
   *
   * A no-op for HQ and connector-imported certificates, which have no Card Job.
   */
  const { advanceCardJobAfterCaptureSafely } = await import("./partner/card-job-lifecycle");
  await advanceCardJobAfterCaptureSafely(input.session.certificateId);
}

export async function reconcileAcceptedScannerEvidence(input: {
  session: ScannerCaptureSession;
  evidence?: FinalisedScannerEvidence;
  trusted: TrustedCapturePrincipal;
  stagingId?: string | null;
}): Promise<{ cardRegistered: boolean }> {
  const evidence = input.evidence ?? (await loadAcceptedScannerEvidence(input.session));
  const { enqueueScannerProcessing } = await import("./scanner-processing-queue");
  const { finishScannerCapture, isScannerCaptureCardRegistered } = await import("./scanner-capture-service");
  await enqueueScannerProcessing(input.session.certificateId, input.session.stationId);
  await finishScannerCapture(input.session.id, true);
  const cardRegistered = await isScannerCaptureCardRegistered(input.session.certificateId);
  await recordAcceptedScannerEvidence({
    session: input.session,
    evidence,
    trusted: input.trusted,
  });
  if (input.stagingId) {
    const { completeScannerEvidenceFinalisation } = await import("./scanner-evidence-staging-service");
    await completeScannerEvidenceFinalisation(input.stagingId);
  }
  return { cardRegistered };
}
