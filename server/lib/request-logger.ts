/**
 * API request/response logging middleware.
 *
 * EXTRACTED FROM server/index.ts (behaviour-preserving, no semantic change). It was previously an
 * inline `app.use(...)` closure over the module-local `log` helper, which made it impossible to
 * test: importing server/index.ts to reach the middleware boots the entire application (sessions,
 * pools, cron jobs, an HTTP listener). The only prior coverage of the body-suppression rule below
 * therefore grepped the SOURCE TEXT of index.ts — a test that would still pass if this middleware
 * were deleted outright.
 *
 * The log sink is injected rather than imported so a test can capture the emitted lines and assert
 * on them directly. `server/index.ts` passes its own `log`, so production output is byte-identical
 * to before the extraction: same format string, same `res.json` capture mechanic, same
 * `redactSensitive` pass, same `/api` filter, same `res.on("finish")` timing.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { redactSensitive } from "./auth-security";

/** The shape of `log` in server/index.ts. `source` is optional and defaults inside the sink. */
export type RequestLogSink = (message: string, source?: string) => void;

/**
 * Prefixes whose JSON response BODY must never be written to the application log.
 *
 * `redactSensitive` masks credential-shaped keys (password/token/secret/…) but NOT personal
 * data — `email`, `phone`, `full_name`, `address_*`, `company_number`, `vat_number` all pass
 * through verbatim. That is tolerable for narrow single-record admin endpoints, but the partner
 * dashboard returns MANY partners' details in one response and auto-refreshes, so logging its
 * bodies would continuously write bulk partner PII into the Fly log.
 *
 * The same reasoning applies to the whole /api/partner surface, and one case there is worse than
 * PII: POST /api/partner/mfa/enrol returns `otpauthUri`, which embeds the raw TOTP seed as a query
 * parameter (`?secret=…`). `redactSensitive` keys off the FIELD NAME, so it masks `secret` and
 * misses `otpauthUri` entirely — the seed would be written to the log in full, as would the
 * one-time `recoveryCodes` from /api/partner/mfa/confirm and the customer/team PII on
 * /api/partner/customers and /api/partner/users.
 *
 * Method, path, status and duration are still logged — only the body is suppressed.
 */
export const BODY_LOG_SUPPRESSED_PREFIXES = [
  // Public Partner applications carry business contact data. The endpoint only
  // returns an opaque receipt today, but suppress it defensively so a later
  // response-shape change cannot put applicant PII into Fly logs.
  "/api/partner-applications",
  "/api/super-admin/partner-dashboard",
  // Same reasoning as the dashboard above: these responses carry partner contact details — email,
  // telephone, postal address, company/VAT numbers — for one or many partners at a time. The
  // duplicate-check probe added in the partner-management UX work echoes the same categories back.
  // redactSensitive only masks credential-SHAPED KEY NAMES, so none of it would be redacted.
  "/api/super-admin/partner-management",
  "/api/partner",
];

export function isBodyLogSuppressed(reqPath: string): boolean {
  return BODY_LOG_SUPPRESSED_PREFIXES.some((prefix) => reqPath.startsWith(prefix));
}

/**
 * Build the request-logging middleware around a log sink.
 *
 * @param sink where finished-request lines are written (production: `log` from server/index.ts).
 */
export function createRequestLogger(sink: RequestLogSink): RequestHandler {
  return function requestLogger(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    const reqPath = req.path;
    let capturedJsonResponse: Record<string, any> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      if (reqPath.startsWith("/api")) {
        let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
        if (capturedJsonResponse && !isBodyLogSuppressed(reqPath)) {
          const safeBody = redactSensitive(capturedJsonResponse);
          logLine += ` :: ${JSON.stringify(safeBody)}`;
        }

        sink(logLine);
      }
    });

    next();
  };
}
