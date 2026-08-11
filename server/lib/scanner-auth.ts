import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { requireAdmin } from "../auth";
import { resolvePartnerSession } from "../partner/session";
import { authenticateStationRequest, type StationServiceError } from "../partner/station-service";
import { StationIdentityError } from "../partner/station-identity";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      scannerStation?: import("../partner/station-service").StationPrincipal;
      scannerOperator?: import("../partner/session").PartnerPrincipal;
    }
  }
}

/**
 * Timing-safe comparison of two strings of any length.
 * Returns false on length mismatch without running the full compare
 * (the length itself isn't secret — the token value is).
 */
function tokensMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Allow a request through if EITHER:
 *   1. it presents a valid X-Scanner-Token matching SCANNER_API_TOKEN, OR
 *   2. it passes the existing admin cookie check (requireAdmin).
 *
 * Intended for endpoints that a long-running scanner daemon calls with a
 * static token, while preserving interactive admin access via the cookie
 * session. Scoped to one endpoint — do NOT apply broadly.
 */
export async function requireScannerOrAdmin(req: Request, res: Response, next: NextFunction) {
  // Production stations use a per-Mac Ed25519 request signature AND a current
  // MFA-complete partner operator session. The station code/device id from a
  // query/body is deliberately ignored later in favour of these principals.
  if (req.header("x-mintvault-station-id")) {
    try {
      const station = await authenticateStationRequest(req.headers, req.method, req.originalUrl, req.rawBody);
      const operator = await resolvePartnerSession(req.header("x-mintvault-operator-session") || "");
      if (!operator?.mfaPassed || !operator.permissions.has("partner.cards.scan")) {
        return res.status(403).json({ error: "An authorised scanner operator is required" });
      }
      if (operator.tenantId !== station.tenantId || (!operator.orgWide && operator.locationId !== station.locationId)) {
        return res.status(403).json({ error: "Operator is not authorised for this station location" });
      }
      req.scannerStation = station;
      req.scannerOperator = operator;
      return next();
    } catch (error) {
      const service = error as StationServiceError;
      const status =
        error instanceof StationIdentityError
          ? 401
          : service.code === "station_not_found"
            ? 404
            : service.code === "station_replay"
              ? 409
              : 403;
      return res
        .status(status)
        .json({ error: "Station authentication failed", code: service.code || "station_auth_failed" });
    }
  }

  const expected = process.env.SCANNER_API_TOKEN;
  const provided = req.header("x-scanner-token");

  // Shared token mode is a local/development transition bridge only. A deployed
  // production station must use its Keychain-backed, server-approved identity.
  // This compatibility path is opt-in twice: production can never regain a
  // shared scanner bearer token merely because NODE_ENV was omitted, and a
  // local proof must explicitly declare its isolated legacy bridge.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN === "1" &&
    expected &&
    provided &&
    tokensMatch(provided, expected)
  ) {
    console.log("[scan-ingest] auth: scanner-token");
    return next();
  }

  // Tag the cookie path if it will succeed; the actual gate is requireAdmin.
  if (req.session?.isAdmin) {
    console.log("[scan-ingest] auth: cookie");
  }
  return requireAdmin(req, res, next);
}

/**
 * The browser may arm and observe a target, but it is never a physical scanner
 * identity. In production an actual claim, keepalive, failure report, staged
 * PUT grant or evidence finalisation therefore requires the signed Mac
 * principal established above. Local/development retains the explicit legacy
 * bridge so an isolated compatibility station can be exercised during cutover.
 */
export function requireStationCaptureAgent(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === "production" && !req.scannerStation) {
    res.status(401).json({ error: "A signed station identity is required for scanner capture" });
    return;
  }
  next();
}
