import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import {
  resolvePartnerSession,
  requirePartnerAuth,
  requirePartnerCapability,
  requireNotViewOnly,
  requireNotSensitiveFrozen,
  setPartnerCookie,
  clearPartnerCookie,
} from "./session";
import { StationIdentityError } from "./station-identity";
import {
  StationServiceError,
  assertStationCaptureReady,
  authenticateStationRequest,
  getStationEnrollmentStatus,
  listPartnerCaptureStations,
  listPermittedStationLocations,
  recordStationHeartbeat,
  resolveActiveStationByCode,
  requestStationEnrollment,
  saveStationCalibration,
  type StationPrincipal,
} from "./station-service";
import { authorizePartnerScannerCertificate } from "./grading-routes";
import { CardJobAuthorityError, startNewCardJobAtStation } from "./card-job-authority";
import { FixAuthorityError, authoriseFix, invalidateSide, listFixQueue } from "./fix-authority";
import { CardJobCancellationError, cancelCardJobBeforeEvidence } from "./card-job-cancellation";
import { completeStationResync, issueStationResyncChallenge } from "./station-resync-service";
import {
  ScannerStationAuthorityError,
  acceptStationProfileRevision,
  beginStationSemanticOperation,
  completeStationSemanticOperation,
} from "./scanner-station-authority";
import { SCANNER_ACCESS_MINUTES } from "./auth";
import {
  bindScannerRefreshSession,
  refreshScannerAccessSession,
  revokeScannerSession,
} from "./scanner-session-service";

/**
 * FIX failures map to statuses that tell the operator what to do next.
 *
 * A cross-tenant or forged Card Job id resolves to CARD_JOB_NOT_FOUND -> 404, deliberately the same
 * answer a genuinely absent id gets: a distinct 403 would confirm that the id is real and belongs to
 * somebody, which is exactly the fact an attacker is probing for.
 */
function fixError(res: Response, error: unknown): void {
  if (error instanceof FixAuthorityError) {
    const status =
      error.code === "CARD_JOB_NOT_FOUND"
        ? 404
        : error.code === "STATION_NOT_ACTIVE" || error.code === "ORGANISATION_NOT_ACTIVE"
          ? 403
          : error.code === "JOB_NOT_FIXABLE"
            ? 409
            : 400;
    res.status(status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  stationError(res, error);
}

const partnerStationReadRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) => `partner-station-read:${req.partner?.userId ?? "unknown"}`,
  message: { error: "Too many station status requests. Please wait a minute and try again." },
});

const partnerStationHeartbeatRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) => `partner-station-heartbeat:${req.station?.id ?? "unknown"}`,
  message: { error: "Too many station heartbeat requests. Please wait a minute and try again." },
});

const partnerScannerSessionRateLimit = rateLimit({
  windowMs: 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) => `partner-scanner-session:${req.station?.id ?? "unknown"}`,
  message: { error: "Too many Scanner session requests. Sign in again or wait a minute." },
});

const partnerStationCaptureRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) =>
    `partner-station-capture:${req.partner?.userId ?? "unknown"}|${req.params.stationCode ?? "unknown"}`,
  message: { error: "Too many station capture requests. Please wait a minute and try again." },
});

// This deliberately runs before signature/session validation: authentication itself
// verifies a signed payload and resolves the operator session, so it must be protected
// from unauthenticated request floods as well as the authenticated write below.
const partnerStationCalibrationIngressRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  message: { error: "Too many station calibration requests. Please wait a minute and try again." },
});

const partnerStationCalibrationRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) => `partner-station-calibration:${req.station?.id ?? "unknown"}`,
  message: { error: "Too many station calibration requests. Please wait a minute and try again." },
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      station?: StationPrincipal;
    }
  }
}

function stationError(res: Response, error: unknown): void {
  if (error instanceof ScannerStationAuthorityError) {
    res.status(error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
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
            : error.code === "version_blocked"
              ? 426
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

async function resolveSignedStationOperator(
  req: Request,
  res: Response,
  next: NextFunction,
  touchActivity: boolean
): Promise<void> {
  try {
    if (!req.station) {
      res
        .status(401)
        .json({ error: { code: "station_required", message: "Approved station authentication is required" } });
      return;
    }
    const token = req.header("x-mintvault-operator-session") || "";
    const operator = await resolvePartnerSession(token, { touchActivity });
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

function requireSignedStationOperator(req: Request, res: Response, next: NextFunction): void {
  void resolveSignedStationOperator(req, res, next, true);
}

function requireSignedStationOperatorBackground(req: Request, res: Response, next: NextFunction): void {
  void resolveSignedStationOperator(req, res, next, false);
}

/** Mounted below the existing Partner portal gates and session middleware. */
export function partnerStationRouter(): Router {
  const r = Router();

  /*
   * AG-2: bringing a NEW Mac into service is station management, not station operation, so it is
   * gated on partner.stations.enrol rather than partner.cards.scan. Migration 0085 grants that to
   * exactly the three roles that already held cards.scan, so nobody who could enrol before has
   * lost the ability — but SCANNER_OPERATOR, which can operate an approved station, cannot bring a
   * new one into service.
   */
  r.post(
    "/stations/enrol",
    requirePartnerAuth,
    requirePartnerCapability("partner.stations.enrol"),
    async (req, res) => {
      try {
        const station = await requestStationEnrollment(req.partner!, {
          locationId: req.body?.locationId,
          publicKeyPem: req.body?.publicKeyPem,
          publicKeyFingerprint: req.body?.publicKeyFingerprint,
          installationFingerprint: req.body?.installationFingerprint,
          appVersion: req.body?.appVersion,
          clientOpId: req.body?.clientOpId,
        });
        res.status(201).json({ station });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.get(
    "/stations/enrolment-locations",
    requirePartnerAuth,
    requirePartnerCapability("partner.stations.enrol"),
    async (req, res) => {
      try {
        res.json({ locations: await listPermittedStationLocations(req.partner!) });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  // The browser chooses only from server-resolved stations in its own
  // tenant/location. It never types or stores a workstation/device identity.
  r.get(
    "/stations/capture-ready",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    async (req, res) => {
      try {
        res.json({ stations: await listPartnerCaptureStations(req.partner!) });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.get(
    "/stations/:stationCode/enrolment-status",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    partnerStationReadRateLimit,
    async (req, res) => {
      try {
        res.json({ station: await getStationEnrollmentStatus(req.partner!, req.params.stationCode) });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  /**
   * P7 — the dashboard's "remove this image from grading".
   *
   * A BROWSER action, so it is guarded by the partner session rather than a station signature: the
   * person deciding an image is unusable is looking at it on the dashboard, not standing at the Mac.
   * `requireNotViewOnly` and `requireNotSensitiveFrozen` apply because retiring evidence is a
   * mutation with forensic consequences.
   *
   * Nothing is deleted. The image is superseded, the card moves to FIX_REQUIRED, and the MV, the
   * certificate, the reservation and the original master all stay exactly where they are.
   */
  r.post(
    "/card-jobs/:cardJobId/invalidate-side",
    requirePartnerAuth,
    // AG-2: taking an image OUT of grading is a judgement, not a capture. SCANNER_OPERATOR captures
    // the replacement but does not decide that a replacement is needed.
    requirePartnerCapability("partner.cards.fix"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      const principal = req.partner!;
      try {
        const result = await invalidateSide({
          tenantId: principal.tenantId,
          locationId: principal.locationId,
          cardJobId: String(req.params.cardJobId),
          side: req.body?.side,
          actorUserId: principal.userId,
          reason: typeof req.body?.reason === "string" ? req.body.reason : "",
        });
        res.json({ invalidated: result });
      } catch (error) {
        fixError(res, error);
      }
    }
  );

  /** The same server-derived FIX queue, for the dashboard. Identical tenant scoping. */
  r.get("/fix-queue", requirePartnerAuth, requirePartnerCapability("partner.cards.view"), async (req, res) => {
    const principal = req.partner!;
    try {
      /*
       * Org-wide roles (OWNER / MANAGER / FINANCE_VIEWER) are entitled to the whole estate; everyone
       * else sees only the shop floor they are assigned to. `orgWide` is resolved server-side from
       * the user's roles on every request — the same rule switchLocation applies — so this is not a
       * client-supplied scope.
       */
      res.json({
        items: await listFixQueue({
          tenantId: principal.tenantId,
          locationId: principal.locationId,
          restrictToLocation: !principal.orgWide,
        }),
      });
    } catch (error) {
      fixError(res, error);
    }
  });

  r.post(
    "/stations/replay-resync/challenge",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    async (req, res) => {
      try {
        res.status(201).json({ challenge: await issueStationResyncChallenge(req.partner!, req.body?.stationCode) });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.post(
    "/stations/replay-resync/complete",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    async (req, res) => {
      try {
        res.json({ replayState: await completeStationResync(req.partner!, {
          stationCode: req.body?.stationCode,
          challengeId: req.body?.challengeId,
          signature: req.body?.signature,
        }) });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.post(
    "/stations/session/bind",
    requireSignedStation,
    requireSignedStationOperator,
    partnerScannerSessionRateLimit,
    async (req, res) => {
      try {
        res.status(201).json({
          session: await bindScannerRefreshSession(req.station!, req.partner!),
        });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.post(
    "/stations/session/refresh",
    requireSignedStation,
    partnerScannerSessionRateLimit,
    async (req, res) => {
      try {
        const refreshed = await refreshScannerAccessSession(req.station!, req.body?.refreshToken);
        setPartnerCookie(res, refreshed.accessToken, SCANNER_ACCESS_MINUTES * 60);
        res.json({
          session: {
            accessExpiresAt: refreshed.accessExpiresAt,
            refreshExpiresAt: refreshed.refreshExpiresAt,
            stationCode: req.station!.code,
          },
        });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  r.post(
    "/stations/session/logout",
    requireSignedStation,
    partnerScannerSessionRateLimit,
    async (req, res) => {
      try {
        await revokeScannerSession(req.station!, req.body?.refreshToken);
        clearPartnerCookie(res);
        res.json({ ok: true });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  // From origin/main: a signed station may still flood its own heartbeat. Keyed per
  // station id, so one noisy Mac cannot exhaust the budget for the whole fleet.
  r.post(
    "/stations/heartbeat",
    requireSignedStation,
    requireSignedStationOperatorBackground,
    partnerStationHeartbeatRateLimit,
    async (req, res) => {
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
    }
  );

  /**
   * P6 — "NEW CARD": authorise exactly ONE new Card Job against exactly ONE Grading Credit.
   *
   * BOTH identities are required and neither substitutes for the other (locked station rule):
   *   requireSignedStation          the approved Mac, proven by its Ed25519 request signature
   *   requireSignedStationOperator  the human, proven by an MFA-passed partner session holding
   *                                 partner.cards.scan, with tenant/location matching the station
   *
   * A stolen laptop with no operator session cannot start work, and a valid operator on an
   * unenrolled Mac cannot either.
   *
   * TENANT, LOCATION AND OPERATOR ARE TAKEN FROM THE AUTHENTICATED PRINCIPALS, NEVER THE BODY. The
   * only thing the client supplies is `clientOpId` — the retry token — and an optional card label.
   * There is therefore no request a station can craft that starts a card for another partner.
   */
  r.post("/card-jobs", requireSignedStation, requireSignedStationOperator, async (req, res) => {
    const station = req.station!;
    const operator = req.partner!;
    try {
      const result = await startNewCardJobAtStation({
        tenantId: station.tenantId,
        locationId: station.locationId,
        stationId: station.id,
        clientOpId: typeof req.body?.clientOpId === "string" ? req.body.clientOpId : "",
        actorUserId: operator.userId,
        actorEmail: req.body?.operatorEmail ?? operator.userId,
        cardName: typeof req.body?.cardName === "string" ? req.body.cardName : null,
      });
      const { ensureNextCardJobCaptureSession } = await import("../scanner-capture-service");
      await ensureNextCardJobCaptureSession({
        cardJobId: result.cardJobId,
        stationId: station.id,
        actorId: operator.userId,
        originalOperatorRole: "SCANNER_OPERATOR",
      });
      // 200 on replay, 201 on a genuinely new job: a retrying station can tell the difference
      // without having to compare ids, and neither answer costs a second credit.
      res.status(result.replayed ? 200 : 201).json({ cardJob: result });
    } catch (error) {
      if (error instanceof CardJobAuthorityError) {
        const status =
          error.code === "INSUFFICIENT_CREDITS"
            ? 402
            : error.code === "IDEMPOTENCY_CONFLICT"
              ? 409
              : error.code === "CARD_UNIT_INVALID"
                ? 400
                : error.code === "IDENTITY_UNAVAILABLE"
                  ? 503
                  : 403;
        res.status(status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      stationError(res, error);
    }
  });

  /**
   * P7 — the FIX queue, for the Scanner.
   *
   * THIS IS THE ROUTE THAT REPLACES THE DEAD "Fix missing images" BUTTON. That button called
   * `/api/admin/orphan-certs`, which addresses certificates with no tenant predicate and therefore
   * correctly refuses a signed station. Rather than weakening it, this returns the same operator
   * affordance derived from THIS partner's own Card Jobs.
   *
   * Because the list is server-derived and tenant-scoped, the normal FIX flow never asks anyone to
   * type an MV number — which is what removes the opportunity to type someone else's.
   */
  /*
   * A DISTINCT PATH from the dashboard's `/fix-queue`, not a shared one. The two callers prove
   * themselves completely differently — the dashboard by session cookie, the station by Ed25519
   * request signature plus an operator-session header — and Express matches the first registered
   * route, so one path with two guard stacks would silently mean only the first stack ever runs.
   */
  r.get("/stations/fix-queue", requireSignedStation, requireSignedStationOperator, async (req, res) => {
    const station = req.station!;
    try {
      // A Mac stands on ONE shop floor. Always confined — never the whole estate.
      const items = await listFixQueue({
        tenantId: station.tenantId,
        locationId: station.locationId,
        restrictToLocation: true,
      });
      res.json({ items });
    } catch (error) {
      fixError(res, error);
    }
  });

  /**
   * P7 — authorise the replacement capture. COSTS ZERO GRADING CREDITS.
   *
   * Same Card Job, same MV, same certificate, same reservation. The service contains no wallet call
   * at all, so this works identically when the shop's balance is zero — which is the point: a card
   * already paid for must always be finishable.
   */
  r.post(
    "/card-jobs/:cardJobId/fix-authorise",
    requireSignedStation,
    requireSignedStationOperator,
    async (req, res) => {
      const station = req.station!;
      const operator = req.partner!;
      try {
        const endpoint = `/api/partner/card-jobs/${String(req.params.cardJobId)}/fix-authorise`;
        const replay = await beginStationSemanticOperation({
          station,
          actorUserId: operator.userId,
          operationType: "FIX_AUTHORISE",
          endpoint,
          payload: req.body,
        });
        if (replay) return res.status(replay.status).json(replay.body);
        const authorisation = await authoriseFix({
          tenantId: station.tenantId,
          locationId: station.locationId,
          cardJobId: String(req.params.cardJobId),
          requestedSides: req.body?.sides,
          stationId: station.id,
          actorUserId: operator.userId,
        });
        const { ensureNextCardJobCaptureSession } = await import("../scanner-capture-service");
        await ensureNextCardJobCaptureSession({
          cardJobId: authorisation.cardJobId,
          stationId: station.id,
          actorId: operator.userId,
          originalOperatorRole: "SCANNER_OPERATOR",
          recapture: true,
        });
        const completed = await completeStationSemanticOperation({
          station,
          status: 200,
          body: { fix: authorisation },
        });
        res.status(completed.status).json(completed.body);
      } catch (error) {
        fixError(res, error);
      }
    }
  );

  r.post(
    "/card-jobs/:cardJobId/cancel",
    requireSignedStation,
    requireSignedStationOperator,
    async (req, res) => {
      const station = req.station!;
      const operator = req.partner!;
      const cardJobId = String(req.params.cardJobId);
      const endpoint = `/api/partner/card-jobs/${cardJobId}/cancel`;
      try {
        if (req.body?.clientOpId !== station.semanticOperationId) {
          throw new ScannerStationAuthorityError("IDEMPOTENCY_CONFLICT", "Cancellation operation ID mismatch");
        }
        const replay = await beginStationSemanticOperation({
          station,
          actorUserId: operator.userId,
          operationType: "CARD_JOB_CANCEL",
          endpoint,
          payload: req.body,
        });
        if (replay) return res.status(replay.status).json(replay.body);
        const cancellation = await cancelCardJobBeforeEvidence({
          station,
          actorUserId: operator.userId,
          cardJobId,
          clientOpId: station.semanticOperationId!,
          captureSessionId: String(req.body?.captureSessionId || ""),
          captureAuthorisationId: String(req.body?.captureAuthorisationId || ""),
        });
        const completed = await completeStationSemanticOperation({
          station,
          status: 200,
          body: { cancellation },
        });
        return res.status(completed.status).json(completed.body);
      } catch (error) {
        if (error instanceof CardJobCancellationError) {
          const status = error.code === "CARD_JOB_NOT_FOUND" ? 404 : 409;
          const body = {
            error: { code: error.code, message: error.message, ...(error.cardJobId ? { cardJobId: error.cardJobId } : {}) },
          };
          try {
            const completed = await completeStationSemanticOperation({ station, status, body, refused: true });
            return res.status(completed.status).json(completed.body);
          } catch (completionError) {
            stationError(res, completionError);
            return;
          }
        }
        stationError(res, error);
      }
    }
  );

  // From origin/main: this runs BEFORE authentication on purpose. requireSignedStation
  // verifies a signed payload and resolves the operator session, so the endpoint must be
  // protected from unauthenticated floods as well as from an authenticated one.
  r.post(
    "/stations/calibrations",
    partnerStationCalibrationIngressRateLimit,
    requireSignedStation,
    requireSignedStationOperator,
    partnerStationCalibrationRateLimit,
    async (req, res) => {
    try {
      const replay = await beginStationSemanticOperation({
        station: req.station!,
        actorUserId: req.partner!.userId,
        operationType: "PROFILE_ACCEPT",
        endpoint: "/api/partner/stations/calibrations",
        payload: req.body,
      });
      if (replay) return res.status(replay.status).json(replay.body);
      // Validate and persist the immutable, server-digested profile first.  If
      // the legacy calibration write later fails the station remains safely
      // UNPROVISIONED and the service UI can replay the same semantic operation.
      // The opposite order could leave calibration VALID with no accepted
      // profile revision, a fail-closed but unrecoverable appliance state.
      const profile = await acceptStationProfileRevision({
        station: req.station!,
        actorUserId: req.partner!.userId,
        payload: req.body,
      });
      const calibration = await saveStationCalibration(req.station!, req.partner!.userId, {
        scannerHardware: req.body?.scannerHardware,
        scannerProfileVersion: req.body?.scannerProfileVersion,
        acquisitionRegion: req.body?.acquisitionRegion,
        workingRegion: req.body?.workingRegion,
        placementToleranceMm: req.body?.placementToleranceMm,
        calibrationVersion: req.body?.calibrationVersion,
      });
      const completed = await completeStationSemanticOperation({
        station: req.station!,
        status: 201,
        body: { calibration: { ...calibration, ...profile } },
      });
      res.status(completed.status).json(completed.body);
    } catch (error) {
      stationError(res, error);
    }
    }
  );

  // A Partner browser arms the exact certificate/card/side only after both
  // its user session and the approved station have been resolved. The scanner
  // later claims this same station UUID through the existing target lifecycle.
  r.post(
    "/stations/:stationCode/capture-sessions",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    partnerStationCaptureRateLimit,
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

  /** The operator may read the state of only a capture session that is bound to
   * their current Partner certificate assignment and station location. This is
   * status-only; the signed station remains the sole capture/claim principal. */
  r.get(
    "/stations/capture-sessions/:sessionId",
    requirePartnerAuth,
    requirePartnerCapability("partner.cards.scan"),
    partnerStationReadRateLimit,
    async (req, res) => {
      try {
        const sessionId = String(req.params.sessionId || "");
        if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
          throw new StationServiceError("validation", "capture session is invalid");
        }
        const { withPartnerAdminTransaction } = await import("./db");
        const result = await withPartnerAdminTransaction((client) =>
          client.query<{
            id: string;
            certificate_id: number;
            side: "front" | "back";
            state: string;
            failure_reason: string | null;
            expires_at: string;
            workstation_id: string;
          }>(
            `SELECT s.id, s.certificate_id, s.side, s.state, s.failure_reason,
                    s.expires_at, s.workstation_id
               FROM scanner_capture_sessions s
               JOIN partner_stations station ON station.id=s.station_id
              WHERE s.id=$1
                AND station.tenant_id=$2
                AND ($3::boolean OR station.location_id=$4::uuid)
              LIMIT 1`,
            [sessionId, req.partner!.tenantId, req.partner!.orgWide, req.partner!.locationId]
          )
        );
        const capture = result.rows[0];
        if (!capture || !(await authorizePartnerScannerCertificate(req.partner!, capture.certificate_id))) {
          throw new StationServiceError("forbidden", "Capture session is not available to this operator");
        }
        res.json({
          capture: {
            id: capture.id,
            side: capture.side,
            state: capture.state,
            failureReason: capture.failure_reason,
            expiresAt: capture.expires_at,
            workstationId: capture.workstation_id,
          },
        });
      } catch (error) {
        stationError(res, error);
      }
    }
  );

  return r;
}
