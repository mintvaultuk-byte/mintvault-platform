import crypto from "node:crypto";

/**
 * Keep internal error detail out of client responses AND out of logs.
 *
 * - clientErrorMessage(): 4xx messages are intentional/client-actionable and
 *   pass through; 5xx collapse to a generic message.
 * - errorEnvelope(): the response-layer interceptor (server/index.ts) collapses
 *   EVERY 5xx body to a strict { error, requestId } envelope in ALL environments
 *   by default, dropping every other field under any key. Detail is only ever
 *   shown when explicitly opted in for local debugging (errorDetailsAllowed()).
 * - safeErrorSummary(): the ONLY thing that should be logged for an error —
 *   error class + a provider-independent code + operation + requestId. Never the
 *   raw message, stack, connection string, signed URL, email, token, or path.
 */

const GENERIC_5XX_MESSAGE = "Internal Server Error";

export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Detailed 5xx client/error output is permitted ONLY for local debugging. */
export function errorDetailsAllowed(
  env: string | undefined = process.env.NODE_ENV,
  debug: string | undefined = process.env.DEBUG_ERROR_DETAILS
): boolean {
  // Production ignores the flag entirely.
  return env === "development" && debug === "true";
}

export function clientErrorMessage(status: number | undefined, message: string | undefined, isProd: boolean): string {
  const statusCode = typeof status === "number" && Number.isFinite(status) ? status : 500;
  if (isProd && statusCode >= 500) return GENERIC_5XX_MESSAGE;
  return message || GENERIC_5XX_MESSAGE;
}

function existingRequestId(body: unknown): string | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).requestId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export interface EnvelopeOptions {
  /** when true, 5xx bodies pass through untouched (local debug only) */
  allowDetails?: boolean;
  /** correlation id to embed; falls back to an existing body id, then a new id */
  requestId?: string;
}

export interface ErrorEnvelopeResult {
  /** true when the body was replaced by the strict envelope */
  scrubbed: boolean;
  /** the body to send: strict envelope when scrubbed, else the original */
  body: unknown;
  /** present only when scrubbed — for safe log correlation */
  requestId?: string;
}

/**
 * For a response with status >= 500, return a STRICT { error, requestId }
 * envelope — every other field dropped — UNLESS detail is explicitly allowed.
 * 4xx and (debug-only) detail responses pass through. Input is never mutated and
 * the original text is never returned (so callers cannot log it).
 */
export function errorEnvelope(status: number, body: unknown, opts: EnvelopeOptions = {}): ErrorEnvelopeResult {
  const statusCode = typeof status === "number" && Number.isFinite(status) ? status : 500;
  if (statusCode < 500 || opts.allowDetails === true) return { scrubbed: false, body };
  const requestId = opts.requestId ?? existingRequestId(body) ?? newRequestId();
  return { scrubbed: true, body: { error: GENERIC_5XX_MESSAGE, requestId }, requestId };
}

export interface SafeErrorContext {
  operation?: string;
  requestId?: string;
}

export interface SafeErrorSummary {
  name: string;
  code?: string;
  operation?: string;
  requestId?: string;
}

/**
 * Build a log-safe summary of an error. Includes ONLY the error class name, a
 * provider-independent enum-shaped code (e.g. ECONNREFUSED, 23505), and the
 * caller-supplied operation/requestId. Deliberately omits message, stack,
 * connection strings, URLs, emails, tokens and filesystem paths.
 */
export function safeErrorSummary(error: unknown, context: SafeErrorContext = {}): SafeErrorSummary {
  const err = error as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null | undefined;
  const name = (typeof err?.name === "string" && err.name) || (err?.constructor?.name as string | undefined) || "Error";

  let code: string | undefined;
  const rawCode = err?.code;
  if (typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(rawCode)) code = rawCode;
  else if (typeof rawCode === "number" && Number.isFinite(rawCode)) code = String(rawCode);

  const out: SafeErrorSummary = { name };
  if (code) out.code = code;
  if (context.operation) out.operation = context.operation;
  if (context.requestId) out.requestId = context.requestId;
  return out;
}
