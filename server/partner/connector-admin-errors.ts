/**
 * G4 Super-Admin connector operations — stable error-code surface + pure helpers.
 *
 * Pure (no DB, no I/O) so it is unit-testable without a harness. Maps the connector runtime's
 * ConnectorError.code onto the stable G4 API error codes the admin surface returns, and provides the
 * request-shaping helpers (reason validation, pagination clamping, deterministic filters) the routes
 * reuse. No secret/SQL/stack text is ever produced here.
 */
import { ConnectorError, type ConnectorErrorCode, IMPORT_ERROR_GUIDANCE } from "./connector-errors";

export const G4_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PARTNER_NOT_FOUND",
  "CONNECTOR_NOT_FOUND",
  "CONNECTOR_RECORD_NOT_FOUND",
  "INVALID_STATE_TRANSITION",
  "RECORD_ALREADY_COMPLETED",
  "MANUAL_REVIEW_REQUIRED",
  "RECONCILIATION_REQUIRED",
  "CONNECTOR_DISABLED",
  "GLOBAL_PROCESSING_DISABLED",
  "RETRY_NOT_ALLOWED",
  "OPERATION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_ALREADY_COMPLETED",
  "VALIDATION_FAILED",
  "TRANSIENT_DATABASE_ERROR",
  "REASON_REQUIRED",
  "BAD_REQUEST",
  "INTERNAL_ERROR",
] as const;
export type G4ErrorCode = (typeof G4_ERROR_CODES)[number];

/** Deterministic map from a connector runtime error code to a stable G4 API code. */
const CONNECTOR_TO_G4: Partial<Record<ConnectorErrorCode, G4ErrorCode>> = {
  feature_disabled: "GLOBAL_PROCESSING_DISABLED",
  emergency_stop: "GLOBAL_PROCESSING_DISABLED",
  import_emergency_stopped: "GLOBAL_PROCESSING_DISABLED",
  unauthorised: "FORBIDDEN",
  handoff_not_found: "CONNECTOR_RECORD_NOT_FOUND",
  invalid_state_transition: "INVALID_STATE_TRANSITION",
  already_claimed: "OPERATION_CONFLICT",
  stale_claim: "OPERATION_CONFLICT",
  import_version_conflict: "OPERATION_CONFLICT",
  idempotency_conflict: "IDEMPOTENCY_CONFLICT",
  import_already_completed: "RECORD_ALREADY_COMPLETED",
  import_cancelled: "INVALID_STATE_TRANSITION",
  import_not_ready: "RETRY_NOT_ALLOWED",
  import_claim_required: "RETRY_NOT_ALLOWED",
  import_claim_expired: "RETRY_NOT_ALLOWED",
  import_claimant_mismatch: "OPERATION_CONFLICT",
  import_validation_missing: "VALIDATION_FAILED",
  import_validation_invalid: "VALIDATION_FAILED",
  import_blocking_findings: "VALIDATION_FAILED",
  import_reconciliation_required: "RECONCILIATION_REQUIRED",
  import_destination_missing: "RECONCILIATION_REQUIRED",
  import_mapping_conflict: "RECONCILIATION_REQUIRED",
  import_destination_conflict: "RECONCILIATION_REQUIRED",
  manual_review_required: "MANUAL_REVIEW_REQUIRED",
  mapping_missing: "RETRY_NOT_ALLOWED",
  destination_missing: "RECONCILIATION_REQUIRED",
  transient_database_error: "TRANSIENT_DATABASE_ERROR",
};

export interface G4ErrorShape {
  code: G4ErrorCode;
  message: string;
  connectorCode?: ConnectorErrorCode;
  operatorAction?: string;
  requiresReconciliation?: boolean;
}

/** Map any thrown value to a safe G4 error shape. Never leaks SQL/stack; unknown → INTERNAL_ERROR. */
export function toG4Error(err: unknown): G4ErrorShape {
  if (err instanceof ConnectorError) {
    const code = CONNECTOR_TO_G4[err.code] ?? "INTERNAL_ERROR";
    const guidance = IMPORT_ERROR_GUIDANCE[err.code];
    return {
      code,
      message: guidance?.publicMessage ?? err.message,
      connectorCode: err.code,
      operatorAction: guidance?.operatorAction,
      requiresReconciliation: guidance?.requiresReconciliation,
    };
  }
  if (err instanceof G4RequestError) {
    return { code: err.code, message: err.message };
  }
  return { code: "INTERNAL_ERROR", message: "An internal error occurred." };
}

/** A request-shaping error raised by the routes/service before any connector call. */
export class G4RequestError extends Error {
  readonly code: G4ErrorCode;
  constructor(code: G4ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** HTTP status for a G4 code. */
export function g4StatusFor(code: G4ErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "PARTNER_NOT_FOUND":
    case "CONNECTOR_NOT_FOUND":
    case "CONNECTOR_RECORD_NOT_FOUND":
      return 404;
    case "OPERATION_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
    case "RECORD_ALREADY_COMPLETED":
      return 409;
    case "TRANSIENT_DATABASE_ERROR":
    case "INTERNAL_ERROR":
      return 500;
    case "REQUEST_ALREADY_COMPLETED":
      return 200;
    default:
      return 400; // BAD_REQUEST, REASON_REQUIRED, INVALID_STATE_TRANSITION, RETRY_NOT_ALLOWED, VALIDATION_FAILED, *_DISABLED, MANUAL_REVIEW_REQUIRED, RECONCILIATION_REQUIRED
  }
}

// ---- Pure request-shaping helpers (unit-tested without a DB) ----

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function clampPagination(
  pageRaw: unknown,
  pageSizeRaw: unknown
): { page: number; pageSize: number; offset: number } {
  const page = toPosInt(pageRaw, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, toPosInt(pageSizeRaw, DEFAULT_PAGE_SIZE));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function toPosInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Validate an operator reason for a mutation. Throws G4RequestError('REASON_REQUIRED') if blank. */
export function requireReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0)
    throw new G4RequestError("REASON_REQUIRED", "An operator reason is required for this action.");
  if (reason.length > 2000) throw new G4RequestError("BAD_REQUEST", "Reason is too long.");
  return reason;
}

/** Validate an optional expectedVersion (finite non-negative integer). */
export function optionalVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n)
    throw new G4RequestError("BAD_REQUEST", "Invalid expectedVersion.");
  return n;
}

/** Validate a required expectedVersion. */
export function requireVersion(raw: unknown): number {
  const v = optionalVersion(raw);
  if (v === undefined) throw new G4RequestError("BAD_REQUEST", "expectedVersion is required for this action.");
  return v;
}

const RECORD_STATES = new Set([
  "queued",
  "claimed",
  "validating",
  "ready_for_import",
  "importing",
  "reconciliation_required",
  "manual_review",
  "rejected",
  "failed",
  "cancelled",
  "imported",
]);

/** Validate an optional state filter against the known connector states. */
export function optionalStateFilter(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw);
  if (!RECORD_STATES.has(s)) throw new G4RequestError("BAD_REQUEST", "Unknown state filter.");
  return s;
}

/** The bounded batch-retry cap. */
export const MAX_BATCH_RETRY = 25;
