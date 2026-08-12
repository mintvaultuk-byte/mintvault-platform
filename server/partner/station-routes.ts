import { Router, type Request, type Response, type NextFunction } from "express";
import { resolvePartnerSession, requirePartnerAuth, requirePartnerCapability } from "./session";
import { StationIdentityError } from "./station-identity";
import {
  StationServiceError,
  assertStationCaptureReady,
  authenticateStationRequest,
  getStationEnrollmentStatus,
  listPermittedStationLocations,
  recordStationHeartbeat,
  resolveActiveStationByCode,
  requestStationEnrollment,
  saveStationCalibration,
  type StationPrincipal,
} from "./station-service";
import { authorizePartnerScannerCertificate } from "./grading-routes";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      station?: StationPrincipal;
    }
  }
}

function stationError(res: Response, error: unknown): void {
  if (error instanceof StationIdentityError) {
    res
      .status(error.code === "expired_timestamp" ? 401 : 400)
      .json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof StationServiceError) {
    const status =
      error.code === "forbidden"
        ? 403
        : error.code === "station_not_found"
          ? 404
          : error.code === "station_replay"
            ? 409
            : 400;
    res.status(status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[partner-stations] request failed", error);
  res.status(500).json({ error: { code: "internal_error", message: "Station request could not be completed" } });
}

async function requireSignedStation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    req.station = await authenticateStationRequest(req.headers, req.method, req.originalUrl, req.rawBody);
    next();
  } catch (error) {
    stationError(res, error);
  }
}

async function requireSignedStationOperator(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.station) {
      res
        .status(401)
        .json({ error: { code: "station_required", message: "Approved station authentication is required" } });
      return;
    }
    const token = req.header("x-mintvault-operator-session") || "";
    const operator = await resolvePartnerSession(token);
    if (!operator?.mfaPassed || !operator.permissions.has("partner.cards.scan")) {
      res.status(403).json({
        error: { code: "operator_scan_forbidden", message: "An authorised signed-in scanner operator is required" },
      });
      return;
    }
    if (
      operator.tenantId !== req.station.tenantId ||
      (!operator.orgWide && operator.locationId !== req.station.locationId)
    ) {
      res.status(403).json({
        error: {
          code: "station_operator_scope_mismatch",
          message: "Operator is not authorised for this station location",
        },
      });
      return;
    }
    req.partner = operator;
    next();
  } catch (error) {
    stationError(res, error);
  }
}

/** Mounted below the existing Partner portal gates and session middleware. */
export function partnerStationRouter(): Router {
  const r = Router();

  r.post("/stations/enrol", requirePartnerAuth, requirePartnerCapability("partner.cards.scan"), async (req, res) => {
    try {
      const station = await requestStationEnrollment(req.partner!, {
        locationId: req.body?.locationId,
        publicKeyPem: req.body?.publicKeyPem,
        installationFingerprint: req.body?.installationFingerprint,
        appVersion: req.body?.appVersion,
      });
      res.status(201).json({ station });
    } catch (error) {
      stationError(res, error);
    }
  });

  r.get(
    "/stations/enrolment-locations",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    async (req, res) => {
      try {
        res.json({ locations: await listPermittedStationLocations(req.partner!) });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.get(
    "/stations/:stationCode/enrolment-status",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    async (req, res) => {
      try {
        res.json({ station: await getStationEnrollmentStatus(req.partner!, req.params.stationCode) });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.post("/stations/heartbeat", requireSignedStation, requireSignedStationOperator, async (req, res) => {
    try {
      const result = await recordStationHeartbeat(req.station!, {
        appVersion: req.body?.appVersion,
        scannerConnected: req.body?.scannerConnected,
        scannerHardware: req.body?.scannerHardware,
        scannerProfileVersion: req.body?.scannerProfileVersion,
        pendingUploadCount: req.body?.pendingUploadCount,
        captureState: req.body?.captureState,
        lastFailureCode: req.body?.lastFailureCode,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      stationError(res, error);
    }
  });

  r.post("/stations/calibrations", requireSignedStation, requireSignedStationOperator, async (req, res) => {
    try {
      const calibration = await saveStationCalibration(req.station!, req.partner!.userId, {
        scannerHardware: req.body?.scannerHardware,
        scannerProfileVersion: req.body?.scannerProfileVersion,
        acquisitionRegion: req.body?.acquisitionRegion,
        workingRegion: req.body?.workingRegion,
        placementToleranceMm: req.body?.placementToleranceMm,
        calibrationVersion: req.body?.calibrationVersion,
      });
      res.status(201).json({ calibration });
    } catch (error) {
      stationError(res, error);
    }
  });

  // A Partner browser arms the exact certificate/card/side only after both
  // its user session and the approved station have been resolved. The scanner
  // later claims this same station UUID through the existing target lifecycle.
  r.post(
    "/stations/:stationCode/capture-sessions",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    async (req, res) => {
      try {
        const station = await resolveActiveStationByCode(req.params.stationCode);
        if (
          !station ||
          station.tenantId !== req.partner!.tenantId ||
          (!req.partner!.orgWide && req.partner!.locationId !== station.locationId)
        ) {
          throw new StationServiceError("forbidden", "Station is not authorised for your location");
        }
        const { CANON_LIDE_400_PROFILE } = await import("../lib/lide400-profile");
        assertStationCaptureReady(station, CANON_LIDE_400_PROFILE.version);
        const certificateId = Number(req.body?.certificateId);
        if (!Number.isSafeInteger(certificateId) || certificateId <= 0)
          throw new StationServiceError("validation", "certificateId is invalid");
        if (!(await authorizePartnerScannerCertificate(req.partner!, certificateId))) {
          throw new StationServiceError("forbidden", "This card is not assigned to the signed-in operator");
        }
        const { createScannerCaptureSession } = await import("../scanner-capture-service");
        const capture = await createScannerCaptureSession({
          certificateId,
          side: req.body?.side,
          workstationId: station.code,
          stationId: station.id,
          actorId: req.partner!.userId,
          recapture: req.body?.recapture === true,
          scannerProfileVersion: CANON_LIDE_400_PROFILE.version,
        });
        res.status(201).json({ capture });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  return r;
}
