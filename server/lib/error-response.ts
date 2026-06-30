import type { Response } from "express";

/**
 * Phase 4 — single safe server-error responder.
 *
 * The H-d global error handler only catches THROWN errors; the ~129 inline
 * `res.status(5xx).json({ error: err.message })` catch blocks across the route
 * files respond directly and so bypass it, leaking internal exception detail
 * (DB errors, stack-derived messages, library internals) to clients.
 *
 * This helper is the one safe 5xx response path: it logs the FULL error
 * server-side (message + stack via console.error of the raw value) and returns
 * a GENERIC body to the client. Intentional, user-facing 4xx validation
 * responses are left exactly as they are — only internal 5xx detail is stripped.
 */
export function sendServerError(res: Response, err: unknown, status = 500): void {
  // Full detail to the server log only.
  console.error("[server-error]", err);
  if (!res.headersSent) {
    res.status(status).json({ error: "Internal server error" });
  }
}
