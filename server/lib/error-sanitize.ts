import crypto from "node:crypto";

/**
 * Helpers for keeping internal error detail out of client responses
 * (Phase 1: security/redact-logs-and-errors).
 *
 * Two layers:
 *   - clientErrorMessage(): used by the central Express error handler for
 *     UNCAUGHT errors — 5xx in production collapse to a generic message.
 *   - scrubServerErrorBody(): used by the response-layer interceptor in
 *     server/index.ts to also neutralise the ~100 route handlers that catch
 *     their own errors and respond `res.status(5xx).json({ error: err.message })`
 *     directly (bypassing the central handler). One choke point covers them all,
 *     present and future, instead of editing every call site.
 *
 * 4xx messages are intentional and client-actionable, so they always pass
 * through. Non-production keeps full detail for developer ergonomics.
 */

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function clientErrorMessage(status: number | undefined, message: string | undefined, isProd: boolean): string {
  const statusCode = typeof status === "number" && Number.isFinite(status) ? status : 500;
  if (isProd && statusCode >= 500) return "Internal Server Error";
  return message || "Internal Server Error";
}

export interface ScrubResult {
  body: Record<string, unknown>;
  requestId: string;
  original: string;
  alreadyHandled: boolean;
}

/**
 * For a 5xx response body carrying an `error` or `message` string, return a
 * scrubbed copy with that text replaced by a generic message plus a correlation
 * id (preserving an existing requestId so the central handler's id is kept).
 * Returns null when there is nothing to scrub. The caller decides WHEN to apply
 * it (production 5xx only) so non-prod keeps full detail.
 */
export function scrubServerErrorBody(body: Record<string, unknown>): ScrubResult | null {
  const hasError = typeof body.error === "string";
  const hasMessage = typeof body.message === "string";
  if (!hasError && !hasMessage) return null;

  const existingId = typeof body.requestId === "string" ? (body.requestId as string) : null;
  const requestId = existingId ?? newRequestId();
  const original = (hasError ? body.error : body.message) as string;

  const scrubbed: Record<string, unknown> = { ...body, requestId };
  if (hasError) scrubbed.error = "Internal Server Error";
  if (hasMessage) scrubbed.message = "Internal Server Error";

  return { body: scrubbed, requestId, original, alreadyHandled: existingId !== null };
}
