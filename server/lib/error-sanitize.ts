import crypto from "node:crypto";

/**
 * Helpers for keeping internal error detail out of client responses
 * (Phase 1: security/redact-logs-and-errors).
 *
 * Two layers:
 *   - clientErrorMessage(): used by the central Express error handler for
 *     UNCAUGHT errors — 5xx in production collapse to a generic message.
 *   - productionErrorEnvelope(): used by the response-layer interceptor in
 *     server/index.ts. In production it collapses EVERY 5xx JSON body to a
 *     strict { error, requestId } envelope, dropping every other field (detail,
 *     details, debug, stack, provider/SQL/path/host text). This is what stops
 *     the ~100 route handlers that respond res.status(5xx).json({...}) directly
 *     from leaking internal error text under ANY key — present or future.
 *
 * 4xx messages are intentional and client-actionable, so they always pass
 * through. Non-production keeps full detail for developer ergonomics.
 */

const GENERIC_5XX_MESSAGE = "Internal Server Error";

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function clientErrorMessage(status: number | undefined, message: string | undefined, isProd: boolean): string {
  const statusCode = typeof status === "number" && Number.isFinite(status) ? status : 500;
  if (isProd && statusCode >= 500) return GENERIC_5XX_MESSAGE;
  return message || GENERIC_5XX_MESSAGE;
}

/** Pull a valid existing requestId out of a body, if present. */
function existingRequestId(body: unknown): string | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).requestId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export interface ErrorEnvelopeResult {
  /** true when the body was replaced by the strict envelope (production 5xx). */
  scrubbed: boolean;
  /** the body to send: the strict envelope when scrubbed, else the original. */
  body: unknown;
  /** present only when scrubbed — for safe log correlation. */
  requestId?: string;
}

/**
 * Production 5xx disclosure guard. For a production response with status >= 500
 * it returns a STRICT envelope `{ error, requestId }` and nothing else — every
 * other field is dropped, so no internal detail (detail/details/debug/stack/
 * provider/SQL/path/host) can reach the client regardless of which key a handler
 * used. A valid existing requestId is preserved for correlation; otherwise one
 * is generated. The input is never mutated, and the original error text is
 * deliberately NOT returned (so the interceptor cannot log it). 4xx responses
 * and all non-production responses pass through untouched.
 */
export function productionErrorEnvelope(status: number, body: unknown, isProd: boolean): ErrorEnvelopeResult {
  const statusCode = typeof status === "number" && Number.isFinite(status) ? status : 500;
  // Fail-safe: a non-numeric/odd status in production is treated as a server
  // error and scrubbed rather than passed through.
  if (!isProd || statusCode < 500) return { scrubbed: false, body };
  const requestId = existingRequestId(body) ?? newRequestId();
  return { scrubbed: true, body: { error: GENERIC_5XX_MESSAGE, requestId }, requestId };
}
