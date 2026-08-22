import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import {
  resolvePartnerSession,
  requirePartnerAuth,
  requirePartnerCapability,
  requireNotViewOnly,
  requireNotSensitiveFrozen,
} from "./session";
import { partnerRateLimit } from "./rate-limit";
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
import { CardJobCancellationError, cancelCardJob } from "./card-job-cancellation";
import { FixAuthorityError, authoriseFix, invalidateSide, listFixQueue } from "./fix-authority";
import { CaptureAuthorityError, authoriseStationCapture } from "./capture-authority";
import { CaptureGeometryError } from "../lib/lide400-capture-authority";

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

/*
 * RC-F11 — the three signed-station hot paths that carried NO rate limit at all.
 *
 * CodeQL reported these as `js/missing-rate-limiting` and it was right: `POST /card-jobs`,
 * `GET /stations/fix-queue` and `POST /card-jobs/:cardJobId/fix-authorise` reached the database and
 * the credit authority with only the Ed25519 station signature and the operator session in front of
 * them. Those two proofs establish WHO is calling; they place no bound on HOW OFTEN, so a
 * compromised or simply malfunctioning shop Mac in a retry loop could exhaust the estate.
 *
 * BUDGETS ARE SET FROM THE PHYSICAL WORKFLOW, NOT FROM A GENERIC WEB-FORM DEFAULT. Scanning is the
 * high-frequency path and a shift must stay fast — this is a locked product requirement, and a limit
 * that interrupts a real batch would be worked around by staff, which is strictly worse than the
 * abuse it prevents. An operator physically places a card, scans it, and moves on; even a fast bench
 * doing continuous batch work is nowhere near one card per second. So the ceilings below are set far
 * above any achievable human rate and act only as a runaway/abuse stop.
 *
 * KEYED PER STATION, so one shop's Mac can never consume another tenant's allowance — a station
 * belongs to exactly one tenant and one location, which makes the station id the tightest correct
 * key.
 *
 * FLEET-WIDE, NOT PER-PROCESS. These three deliberately use `partnerRateLimit` (the pluggable-store
 * limiter) rather than `rateLimit` from express-rate-limit like their neighbours above. Production
 * runs two Fly Machines, and express-rate-limit's default store is per-process — MEASURED on staging
 * 2026-08-15: Machine A returned 429 while Machine B, hit immediately after, still served, so the
 * effective ceiling was 2x with no shared state. `partnerRateLimit` goes through the store that
 * mount.ts swaps for the shared PostgreSQL one at boot (invariant I19), so a runaway station is
 * bounded across the FLEET rather than per Machine.
 *
 * `failClosed: true` denies if the counter cannot be read. That costs nothing real: every one of
 * these routes needs the same database to do its work, so a store outage would have failed the
 * request anyway — it never turns a working scan into a refused one.
 *
 * The four limiters above stay on express-rate-limit deliberately: they are pre-existing, outside
 * this repair's scope, and changing them would be an unreviewed behavioural change to shipped paths.
 */
const partnerStationCardJobStartRateLimit = partnerRateLimit({
  name: "partner-station-card-job",
  windowMs: 60_000,
  // 120/min = two card starts per second, sustained, per station. Unreachable by hand; a runaway
  // loop hits it immediately. Deliberately far above partnerStationCaptureRateLimit (20/min), which
  // bounds capture SESSIONS rather than the cards a bench can start.
  max: 120,
  failClosed: true,
  keyFn: (req) => req.station?.id ?? "unknown",
});

const partnerStationFixQueueRateLimit = partnerRateLimit({
  name: "partner-station-fix-queue",
  windowMs: 60_000,
  // A read, and the shop-floor app polls it; matches the established read budget.
  max: 120,
  failClosed: true,
  keyFn: (req) => req.station?.id ?? "unknown",
});

const partnerStationFixAuthoriseRateLimit = partnerRateLimit({
  name: "partner-station-fix-authorise",
  windowMs: 60_000,
  // Authorising a FIX is rarer than starting a card and is a lineage decision, so it is tighter —
  // still one per second, which no operator reaches.
  max: 60,
  failClosed: true,
  keyFn: (req) => req.station?.id ?? "unknown",
});

const partnerStationCardJobCancelRateLimit = partnerRateLimit({
  name: "partner-station-card-job-cancel",
  windowMs: 60_000,
  // Cancelling is rarer than starting and each one moves money back, so it is tighter than the
  // 120/min card-start budget — still one per second sustained, which no operator reaches. Keyed per
  // station and fleet-wide for the same reasons as its neighbours.
  max: 60,
  failClosed: true,
  keyFn: (req) => req.station?.id ?? "unknown",
});

const partnerStationCaptureAuthoriseRateLimit = partnerRateLimit({
  name: "partner-station-capture-authorise",
  windowMs: 60_000,
  // Two arms per card (front, back) plus retries after a failed sheet. Sits between the card-start
  // budget (120/min) and the FIX budget (60/min): a bench can arm faster than it can start cards,
  // because a rejected sheet is re-armed without starting anything, but this is still one per
  // second sustained per station and no operator reaches it.
  max: 90,
  failClosed: true,
  keyFn: (req) => req.station?.id ?? "unknown",
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
  /*
   * A GEOMETRY REFUSAL IS AN ANSWER, NOT A CRASH.
   *
   * `CaptureGeometryError` is neither of the classes above, so it fell through to the 500 below —
   * and the 500 replaces the message entirely with "Station request could not be completed". So the
   * one sentence that tells the operator what to do ("re-arm this card side", "the capture window
   * origin is not a valid position") was being discarded and reported as a server fault, on the arm
   * path, every time. 409 with the real code and text instead.
   */
  if (error instanceof CaptureGeometryError) {
    res.status(409).json({ error: { code: error.code, message: error.message } });
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

/**
 * MOVING THE CAPTURE AREA IS MAINTENANCE, NOT OPERATION.
 *
 * Identical to `requireSignedStationOperator` in every respect except the capability it demands.
 * The capture area sits in a proven physical position on the scanner bed and normal shop work never
 * moves it — place the card inside it, Preview, Scan. Gating recalibration on `partner.cards.scan`
 * meant the least-privileged role in the system could silently repoint a station's physical
 * acquisition rectangle, and the damage from that is invisible at the time: every card afterwards is
 * framed differently from every card before, and any certificate straddling the change has two sides
 * from two rectangles.
 *
 * Written as its own middleware rather than a parameter, because `tests/release-route-rate-limits.
 * test.ts` pins each route's middleware chain BY NAME — so the authority a route requires is legible
 * in the chain itself and cannot be changed without the pin noticing.
 */
async function requireSignedStationMaintainer(req: Request, res: Response, next: NextFunction): Promise<void> {
  return requireSignedStationCapability(req, res, next, {
    capability: "partner.stations.calibrate",
    code: "operator_calibrate_forbidden",
    message: "Moving the capture area requires station maintenance authority",
  });
}

async function requireSignedStationOperator(req: Request, res: Response, next: NextFunction): Promise<void> {
  return requireSignedStationCapability(req, res, next, {
    capability: "partner.cards.scan",
    code: "operator_scan_forbidden",
    message: "An authorised signed-in scanner operator is required",
  });
}

async function requireSignedStationCapability(
  req: Request,
  res: Response,
  next: NextFunction,
  required: { capability: string; code: string; message: string }
): Promise<void> {
  try {
    if (!req.station) {
      res
        .status(401)
        .json({ error: { code: "station_required", message: "Approved station authentication is required" } });
      return;
    }
    const token = req.header("x-mintvault-operator-session") || "";
    const operator = await resolvePartnerSession(token);
    if (!operator?.mfaPassed || !operator.permissions.has(required.capability)) {
      res.status(403).json({ error: { code: required.code, message: required.message } });
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
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
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

  // From origin/main: a signed station may still flood its own heartbeat. Keyed per
  // station id, so one noisy Mac cannot exhaust the budget for the whole fleet.
  //
  // KEEP THIS COMMENT ABOVE THE ROUTE, NOT INSIDE THE MIDDLEWARE CHAIN. The release guard in
  // tests/release-route-rate-limits.test.ts asserts the authentication -> capability ->
  // rate-limit ORDER by matching the argument list with `\s*` between the middleware names,
  // and `\s*` cannot span a comment. Sitting between `requireSignedStationOperator` and
  // `partnerStationHeartbeatRateLimit` it broke that assertion while changing no behaviour.
  r.post(
    "/stations/heartbeat",
    requireSignedStation,
    requireSignedStationOperator,
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
  // Kept on ONE line: tests/partner-station-new-card.test.ts locates this route with
  // `indexOf('r.post("/card-jobs"')`, so splitting the path onto its own line makes that slice
  // empty and silently voids three P6 security assertions rather than failing loudly.
  r.post(
    "/card-jobs",
    requireSignedStation,
    requireSignedStationOperator,
    partnerStationCardJobStartRateLimit,
    async (req, res) => {
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
          /*
           * The ONBOARDING TEST declaration. Accepted only as this exact literal and otherwise
           * ignored, so no malformed or unexpected body value can classify a card — and a shop
           * cannot mark someone else's card, because the tenant still comes from the signed station
           * identity above and never from the body.
           */
          purpose: req.body?.purpose === "ONBOARDING_TEST" ? "ONBOARDING_TEST" : "NORMAL",
        });
        // 200 on replay, 201 on a genuinely new job: a retrying station can tell the difference
        // without having to compare ids, and neither answer costs a second credit.
        res.status(result.replayed ? 200 : 201).json({ cardJob: result });
      } catch (error) {
        if (error instanceof CardJobAuthorityError) {
          const status =
            error.code === "INSUFFICIENT_CREDITS"
              ? 402
              : // Both are "you cannot have this right now because of state that already exists".
                error.code === "IDEMPOTENCY_CONFLICT" || error.code === "TEST_CARD_ALREADY_OPEN"
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
    }
  );

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
  // One line, for the same reason: tests/partner-scanner-fix.test.ts slices from
  // `indexOf('r.get("/stations/fix-queue"')` and reads the next 300 characters.
  r.get(
    "/stations/fix-queue",
    requireSignedStation,
    requireSignedStationOperator,
    partnerStationFixQueueRateLimit,
    async (req, res) => {
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
    }
  );

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
    partnerStationFixAuthoriseRateLimit,
    async (req, res) => {
      const station = req.station!;
      const operator = req.partner!;
      try {
        const authorisation = await authoriseFix({
          tenantId: station.tenantId,
          locationId: station.locationId,
          cardJobId: String(req.params.cardJobId),
          requestedSides: req.body?.sides,
          stationId: station.id,
          actorUserId: operator.userId,
        });
        res.json({ fix: authorisation });
      } catch (error) {
        fixError(res, error);
      }
    }
  );

  /**
   * P6c — CANCEL A CARD THAT WAS STARTED BY MISTAKE AND NEVER PHOTOGRAPHED.
   *
   * THE EDGE THAT HAD NO CALLER. `NEEDS_SCAN -> CANCELLED` has been legal since migration 0080 and
   * `transitionCardJob` could always perform it, but nothing reachable ever did — so a mis-pressed
   * NEW held its Grading Credit for the full 365-day reservation TTL and left a job that could never
   * be finished or closed. This is that caller, and it is deliberately NOT the submission
   * cancellation path: releasing through the submission would return the credit and leave the Card
   * Job stranded in NEEDS_SCAN, which is worse than the defect.
   *
   * BOTH IDENTITIES ARE REQUIRED, exactly as for NEW. Returning a credit is a money movement, so it
   * demands the same proof that spending one does: the approved Mac's Ed25519 signature AND an
   * MFA-passed operator session holding `partner.cards.scan`, with tenant and location equality
   * between the two. `requireNotViewOnly` is unnecessary here only because that scope cannot hold
   * `partner.cards.scan` in the first place.
   *
   * THE CARD JOB ID IS THE ONLY CLIENT INPUT, and it is resolved under the AUTHENTICATED station's
   * tenant. A forged or cross-tenant id resolves to 404 — the same answer an absent id gets.
   */
  // Kept on ONE line for the same reason as /card-jobs above: the boundary suites locate this route
  // with `indexOf('r.post("/card-jobs/:cardJobId/cancel"')` and read the following characters.
  r.post(
    "/card-jobs/:cardJobId/cancel",
    requireSignedStation,
    requireSignedStationOperator,
    partnerStationCardJobCancelRateLimit,
    async (req, res) => {
      const station = req.station!;
      const operator = req.partner!;
      try {
        const cancellation = await cancelCardJob({
          tenantId: station.tenantId,
          locationId: station.locationId,
          cardJobId: String(req.params.cardJobId),
          stationId: station.id,
          actorUserId: operator.userId,
          actorEmail: req.body?.operatorEmail ?? operator.userId,
          reason: typeof req.body?.reason === "string" ? req.body.reason : "",
        });
        res.json({ cancellation });
      } catch (error) {
        if (error instanceof CardJobCancellationError) {
          const status =
            error.code === "CARD_JOB_NOT_FOUND"
              ? 404
              : error.code === "JOB_NOT_CANCELLABLE" ||
                  error.code === "JOB_HAS_EVIDENCE" ||
                  error.code === "CAPTURE_IN_PROGRESS" ||
                  error.code === "CREDIT_ALREADY_SETTLED"
                ? 409
                : error.code === "REASON_REQUIRED"
                  ? 400
                  : 403;
          res.status(status).json({ error: { code: error.code, message: error.message } });
          return;
        }
        stationError(res, error);
      }
    }
  );

  /**
   * B1 — ARM A CAPTURE SESSION FROM THE STATION ITSELF.
   *
   * THE CLOSED LOOP THIS OPENS. `POST /card-jobs` started a walk-in card and
   * `POST /card-jobs/:id/fix-authorise` said which sides a repair had freed, but neither armed a
   * capture session, and the only Partner route that did (`/stations/:stationCode/capture-sessions`)
   * authenticates with the browser cookie and is reachable only from inside the opened grading
   * workstation — which will not open until the card is READY_TO_GRADE, which requires the very
   * photographs that could not be taken. Walk-in cards therefore stuck in NEEDS_SCAN.
   *
   * WHY THIS IS NOT A NEW PRIVILEGE. The station already proves more here than the browser does on
   * the cookie route: an Ed25519 request signature bound to its credential epoch, PLUS an
   * MFA-passed operator session holding `partner.cards.scan`, PLUS tenant and location equality
   * between station and operator — all established by the two guards below before this handler
   * runs. No new capability is introduced and none is relaxed.
   *
   * THE CERTIFICATE IS NEVER SUPPLIED BY THE CALLER. It is read from a Card Job that was itself
   * located by the AUTHENTICATED station's tenant, and the station's own location must match the
   * job's. `createScannerCaptureSession` then re-proves that same station↔job binding against its
   * own pool before it will arm anything. Two independent locks, neither of which trusts the body.
   */
  // Kept on ONE line for the same reason as /card-jobs above: the boundary suite locates this route
  // with `indexOf('r.post("/card-jobs/:cardJobId/capture-sessions"')` and reads the following
  // characters, so splitting the path onto its own line would silently void those assertions.
  r.post(
    "/card-jobs/:cardJobId/capture-sessions",
    requireSignedStation,
    requireSignedStationOperator,
    partnerStationCaptureAuthoriseRateLimit,
    async (req, res) => {
      const station = req.station!;
      const operator = req.partner!;
      try {
        // Calibration and profile version are a capture precondition, not an arming one, but refusing
        // here gives the operator the real reason at the moment they press the button rather than an
        // opaque failure two steps later when the sheet is already on the glass.
        const { CANON_LIDE_400_PROFILE } = await import("../lib/lide400-profile");
        assertStationCaptureReady(station, CANON_LIDE_400_PROFILE.version);

        const authorisation = await authoriseStationCapture({
          tenantId: station.tenantId,
          locationId: station.locationId,
          cardJobId: String(req.params.cardJobId),
          stationId: station.id,
          actorUserId: operator.userId,
          requestedSide: req.body?.side,
        });

        const { createScannerCaptureSession } = await import("../scanner-capture-service");
        const capture = await createScannerCaptureSession({
          certificateId: authorisation.certificateId,
          side: authorisation.side,
          workstationId: station.code,
          stationId: station.id,
          actorId: operator.userId,
          // Always false. A side that already has a current image is refused by the authority above,
          // so there is nothing here for a recapture flag to mean except "overwrite without the
          // invalidation that is meant to precede it".
          recapture: false,
          scannerProfileVersion: CANON_LIDE_400_PROFILE.version,
        });

        res.status(201).json({
          capture,
          cardJob: {
            cardJobId: authorisation.cardJobId,
            mvNumber: authorisation.mvNumber,
            status: authorisation.status,
            side: authorisation.side,
            missingSides: authorisation.missingSides,
          },
        });
      } catch (error) {
        if (error instanceof CaptureAuthorityError) {
          const status =
            error.code === "CARD_JOB_NOT_FOUND"
              ? 404
              : error.code === "SIDE_INVALID"
                ? 400
                : error.code === "JOB_NOT_CAPTURABLE" ||
                    error.code === "SIDE_ALREADY_PRESENT" ||
                    error.code === "NOTHING_TO_CAPTURE"
                  ? 409
                  : 403;
          res.status(status).json({ error: { code: error.code, message: error.message } });
          return;
        }
        /*
         * THE ARM PATH MUST NOT REDUCE A REAL, ACTIONABLE REFUSAL TO "Station request could not be
         * completed". That generic 500 is what an operator saw when their station already held a live
         * target: it named no card, suggested nothing, and was produced for a condition they could
         * have cleared in one press had anyone told them what it was.
         *
         * `ScannerCaptureConflictError` is imported lazily for the same reason
         * `createScannerCaptureSession` is — the HQ capture service pulls in the Drizzle pool, and the
         * partner router must stay loadable on a partner-only deployment.
         */
        const { ScannerCaptureConflictError } = await import("../scanner-capture-service");
        if (error instanceof ScannerCaptureConflictError) {
          res.status(409).json({
            error: {
              code: error.code,
              message: error.message,
              holdingCertificateNumber: error.holdingCertificateNumber,
              holdingSide: error.holdingSide,
            },
          });
          return;
        }
        stationError(res, error);
      }
    }
  );

  // From origin/main: `partnerStationCalibrationIngressRateLimit` runs BEFORE authentication on
  // purpose. requireSignedStation verifies a signed payload and resolves the operator session, so
  // the endpoint must be protected from unauthenticated floods as well as from an authenticated one.
  //
  // KEEP THIS COMMENT ABOVE THE ROUTE, NOT INSIDE THE MIDDLEWARE CHAIN — see the note on
  // /stations/heartbeat above. tests/release-route-rate-limits.test.ts pins this exact
  // ingress-limit -> authentication -> operator -> per-station-limit ORDER with `\s*` between the
  // middleware names, and `\s*` cannot span a comment.
  r.post(
    "/stations/calibrations",
    partnerStationCalibrationIngressRateLimit,
    requireSignedStation,
    requireSignedStationMaintainer,
    partnerStationCalibrationRateLimit,
    async (req, res) => {
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
          // Generic Partner arming is not a recapture authority. FIX/repair flows must invalidate
          // the exact side first, then arm through their own server-owned path.
          recapture: false,
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
